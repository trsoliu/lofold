use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use lofold_agent_mcp::{socket_path, Bridge, Command, DraftText, Search};
use lofold_mail_store::{Draft, DraftFields};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::LocalArchive;

const MAX_SHARES: usize = 20;
const MAX_SHARED_CHARS: usize = 12_000;
const MAX_AGENT_DRAFTS: usize = 100;
const EVENT: &str = "lofold://agent-action";

#[derive(Default)]
pub struct AgentAccess {
    session: Arc<Mutex<Access>>,
    bridge: Mutex<Option<Bridge>>,
}

impl AgentAccess {
    pub fn shutdown(&self) {
        if let Ok(mut session) = self.session.lock() {
            *session = Access::default();
        }
        if let Ok(mut bridge) = self.bridge.lock() {
            bridge.take();
        }
    }
}

#[derive(Default)]
struct Access {
    generation: Option<Uuid>,
    shares: Vec<SharedMail>,
    drafts: HashMap<i64, i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareSummary {
    share_id: String,
    subject: String,
    sender: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedMail {
    #[serde(skip)]
    message_id: i64,
    #[serde(flatten)]
    summary: ShareSummary,
    body: String,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    enabled: bool,
    command: String,
    shares: Vec<ShareSummary>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Action {
    OpenSearch {
        query: String,
        scope: lofold_agent_mcp::SearchScope,
    },
    OpenDraft {
        id: i64,
    },
    DraftChanged,
}

fn access_error<T>(_: T) -> String {
    "Agent MCP 暂不可用，请重新打开 LoFold。".into()
}

fn settings(access: &AgentAccess) -> Result<Settings, String> {
    let session = access.session.lock().map_err(access_error)?;
    let command = std::env::current_exe()
        .map_err(|_| "无法定位 LoFold 可执行文件。")?
        .to_string_lossy()
        .into_owned();
    Ok(Settings {
        enabled: session.generation.is_some(),
        command,
        shares: session
            .shares
            .iter()
            .map(|mail| mail.summary.clone())
            .collect(),
    })
}

#[tauri::command]
pub fn mcp_settings(access: State<'_, AgentAccess>) -> Result<Settings, String> {
    settings(&access)
}

#[tauri::command]
pub fn mcp_set_enabled(
    app: AppHandle,
    access: State<'_, AgentAccess>,
    archive: State<'_, LocalArchive>,
    enabled: bool,
) -> Result<Settings, String> {
    if enabled {
        let mut bridge = access.bridge.lock().map_err(access_error)?;
        if bridge.is_none() {
            let session = access.session.clone();
            let archive = archive.inner().clone();
            *bridge = Some(
                Bridge::bind(socket_path(), move |command| {
                    execute(&session, &archive, command, |action| dispatch(&app, action))
                })
                .map_err(|_| "无法开启本机 MCP 连接。请确认这台 Mac 上只运行一个 LoFold 实例。")?,
            );
        }
        access
            .session
            .lock()
            .map_err(access_error)?
            .generation
            .get_or_insert_with(Uuid::new_v4);
    } else {
        *access.session.lock().map_err(access_error)? = Access::default();
    }
    settings(&access)
}

#[tauri::command]
pub async fn mcp_share_mail(
    access: State<'_, AgentAccess>,
    archive: State<'_, LocalArchive>,
    id: i64,
) -> Result<Settings, String> {
    let generation = access
        .session
        .lock()
        .map_err(access_error)?
        .generation
        .ok_or("请先在「设置 → Agent MCP」启用连接。")?;
    let (mail, body) = archive.run(move |store| store.ai_message(id)).await?;
    {
        let mut session = access.session.lock().map_err(access_error)?;
        if session.generation != Some(generation) {
            return Err("Agent 访问会话已变更，请重新发起共享。".into());
        }
        session.share(id, mail.subject(), mail.sender(), body)?;
    }
    settings(&access)
}

#[tauri::command]
pub fn mcp_revoke_mail(
    access: State<'_, AgentAccess>,
    share_id: String,
) -> Result<Settings, String> {
    access
        .session
        .lock()
        .map_err(access_error)?
        .shares
        .retain(|mail| mail.summary.share_id != share_id);
    settings(&access)
}

#[tauri::command]
pub fn mcp_take_draft(access: State<'_, AgentAccess>, id: i64) -> Result<(), String> {
    access
        .session
        .lock()
        .map_err(access_error)?
        .drafts
        .remove(&id);
    Ok(())
}

impl Access {
    fn share(
        &mut self,
        id: i64,
        subject: &str,
        sender: &str,
        mut body: String,
    ) -> Result<(), String> {
        if self.shares.iter().any(|mail| mail.message_id == id) {
            return Ok(());
        }
        if self.shares.len() >= MAX_SHARES {
            return Err("本次会话最多共享 20 封邮件。请先撤回部分共享。".into());
        }
        let cut = byte_limit(&body, MAX_SHARED_CHARS);
        if let Some(offset) = cut {
            body.truncate(offset);
        }
        self.shares.push(SharedMail {
            message_id: id,
            summary: ShareSummary {
                share_id: Uuid::new_v4().to_string(),
                subject: subject[..byte_limit(subject, 512).unwrap_or(subject.len())].to_owned(),
                sender: sender[..byte_limit(sender, 512).unwrap_or(sender.len())].to_owned(),
            },
            body,
            truncated: cut.is_some(),
        });
        Ok(())
    }
}

fn byte_limit(text: &str, chars: usize) -> Option<usize> {
    text.char_indices().nth(chars).map(|(offset, _)| offset)
}

fn dispatch(app: &AppHandle, action: Action) -> Result<(), String> {
    app.emit_to("main", EVENT, action.clone())
        .map_err(|_| "无法通知 LoFold 主窗口。".to_owned())?;
    if !matches!(action, Action::DraftChanged) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    Ok(())
}

fn execute(
    access: &Mutex<Access>,
    archive: &LocalArchive,
    command: Command,
    dispatch: impl Fn(Action) -> Result<(), String>,
) -> Result<Value, String> {
    let mut session = access.lock().map_err(access_error)?;
    if matches!(command, Command::Status) {
        return Ok(
            json!({ "enabled": session.generation.is_some(), "sharedMailCount": session.shares.len() }),
        );
    }
    if session.generation.is_none() {
        return Err("Agent MCP 当前已关闭。请在 LoFold 设置中启用。".into());
    }

    match command {
        Command::Status => unreachable!(),
        Command::ListSharedMail => Ok(
            json!({ "messages": session.shares.iter().map(|mail| &mail.summary).collect::<Vec<_>>() }),
        ),
        Command::ReadSharedMail(input) => session
            .shares
            .iter()
            .find(|mail| mail.summary.share_id == input.share_id)
            .map(|mail| json!({ "message": mail }))
            .ok_or_else(|| "邮件未共享，或共享已被撤回。请先列出已共享邮件。".into()),
        Command::OpenSearch(Search { query, scope }) => {
            let query = query.trim();
            if query.chars().count() > 160 || query.chars().any(char::is_control) {
                return Err("搜索词最多 160 个字符，并使用单行文本。".into());
            }
            drop(session);
            dispatch(Action::OpenSearch {
                query: query.to_owned(),
                scope,
            })?;
            Ok(json!({ "requested": true, "scope": scope }))
        }
        Command::CreateDraft(input) => {
            if session.drafts.len() >= MAX_AGENT_DRAFTS {
                return Err(
                    "本次会话已达到 Agent 草稿上限。可先在 LoFold 中查看已保存草稿。".into(),
                );
            }
            let draft = edit_archive(archive, |store| {
                store.create_draft_with_fields(fields(input))
            })?;
            session.drafts.insert(draft.id, draft.revision);
            drop(session);
            let _ = dispatch(Action::DraftChanged);
            Ok(receipt(&draft))
        }
        Command::UpdateDraft(input) => {
            if session.drafts.get(&input.draft_id) != Some(&input.revision) {
                return Err(
                    "草稿不属于当前 Agent 会话，或修订号已失效。请在 LoFold 中查看。".into(),
                );
            }
            let draft = edit_archive(archive, |store| {
                store.save_draft(input.draft_id, input.revision, fields(input.fields))
            })?;
            session.drafts.insert(draft.id, draft.revision);
            drop(session);
            let _ = dispatch(Action::DraftChanged);
            Ok(receipt(&draft))
        }
        Command::OpenDraft(input) => {
            let revision = session
                .drafts
                .get(&input.draft_id)
                .ok_or("只能打开由当前 Agent 会话创建且尚未交接的草稿。")?;
            let draft = edit_archive(archive, |store| store.draft(input.draft_id))?;
            if draft.revision != *revision
                || (draft.status != "editing" && draft.status != "rejected")
            {
                return Err("草稿已修改或提交。请在 LoFold 的草稿箱中查看。".into());
            }
            session.drafts.remove(&draft.id);
            drop(session);
            dispatch(Action::OpenDraft { id: draft.id })?;
            Ok(json!({ "draftId": draft.id, "reviewRequested": true }))
        }
    }
}

fn edit_archive<T>(
    archive: &LocalArchive,
    operation: impl FnOnce(
        &mut lofold_mail_store::MailArchive,
    ) -> Result<T, lofold_mail_store::ArchiveError>,
) -> Result<T, String> {
    let mut opened = archive
        .store
        .try_lock()
        .map_err(|_| "本机归档忙，请稍后重试。")?;
    let archive = opened
        .as_mut()
        .ok_or("请先在 LoFold 中打开本机归档并完成解锁。")?;
    operation(&mut archive.mail).map_err(|error| error.to_string())
}

fn fields(input: DraftText) -> DraftFields {
    DraftFields {
        account_id: None,
        recipient: input.recipient,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        body: input.body,
    }
}

fn receipt(draft: &Draft) -> Value {
    json!({ "draftId": draft.id, "revision": draft.revision, "status": draft.status })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lofold_agent_mcp::{DraftId, DraftUpdate, SearchScope, SharedId};
    use lofold_mail_store::MailArchive;

    fn text(subject: &str) -> DraftText {
        DraftText {
            recipient: "test@example.test".into(),
            cc: String::new(),
            bcc: String::new(),
            subject: subject.into(),
            body: "Fixture body".into(),
        }
    }

    #[test]
    fn permissions_and_draft_handoff_use_the_real_archive() {
        let directory = tempfile::tempdir().unwrap();
        let mail = MailArchive::open(&directory.path().join("archive.sqlite"), &[9; 32]).unwrap();
        let archive = LocalArchive {
            directory: directory.path().to_path_buf(),
            store: Arc::new(Mutex::new(Some(crate::OpenedArchive {
                mail,
                watermark_key: zeroize::Zeroizing::new([2; 32]),
            }))),
            mail_operation: Arc::new(tauri::async_runtime::Mutex::new(())),
        };
        let access = Mutex::new(Access::default());
        let events = Mutex::new(Vec::new());
        let run = |request| {
            execute(&access, &archive, request, |event| {
                events.lock().unwrap().push(event);
                Ok(())
            })
        };
        assert_eq!(run(Command::Status).unwrap()["enabled"], false);
        assert!(run(Command::CreateDraft(text("Blocked"))).is_err());
        access.lock().unwrap().generation = Some(Uuid::new_v4());
        assert!(run(Command::ReadSharedMail(SharedId {
            share_id: "1".into()
        }))
        .is_err());
        let share = {
            let mut state = access.lock().unwrap();
            state
                .share(
                    1,
                    "Fixture only",
                    "test@example.test",
                    "私".repeat(MAX_SHARED_CHARS + 1),
                )
                .unwrap();
            state.shares[0].summary.share_id.clone()
        };
        let list = run(Command::ListSharedMail).unwrap();
        assert_eq!(list["messages"][0]["subject"], "Fixture only");
        assert!(list["messages"][0].get("body").is_none());
        let read = run(Command::ReadSharedMail(SharedId {
            share_id: share.clone(),
        }))
        .unwrap();
        assert_eq!(read["message"]["truncated"], true);
        assert_eq!(
            read["message"]["body"].as_str().unwrap().chars().count(),
            MAX_SHARED_CHARS
        );
        access.lock().unwrap().shares.clear();
        assert!(run(Command::ReadSharedMail(SharedId { share_id: share })).is_err());

        assert!(run(Command::OpenSearch(Search {
            query: "invoice".into(),
            scope: SearchScope::Archive
        }))
        .is_ok());
        let ordinary = edit_archive(&archive, |store| {
            store.create_draft_with_fields(fields(text("Human draft")))
        })
        .unwrap();
        assert!(run(Command::UpdateDraft(DraftUpdate {
            draft_id: ordinary.id,
            revision: ordinary.revision,
            fields: text("Blocked")
        }))
        .is_err());
        let created = run(Command::CreateDraft(text("Agent draft"))).unwrap();
        let id = created["draftId"].as_i64().unwrap();
        let revision = created["revision"].as_i64().unwrap();
        let update = |revision, subject| {
            Command::UpdateDraft(DraftUpdate {
                draft_id: id,
                revision,
                fields: text(subject),
            })
        };
        let updated = run(update(revision, "Updated")).unwrap();
        let latest = updated["revision"].as_i64().unwrap();
        assert!(run(update(revision, "Stale")).is_err());
        let opened = run(Command::OpenDraft(DraftId { draft_id: id })).unwrap();
        assert_eq!(opened["reviewRequested"], true);
        assert!(run(update(latest, "Blocked after handoff")).is_err());
        let saved = edit_archive(&archive, |store| store.draft(id)).unwrap();
        assert_eq!(saved.fields.subject, "Updated");
        assert_eq!(saved.fields.account_id, None);
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, Action::OpenDraft { id: opened_id } if *opened_id == id)));
        *access.lock().unwrap() = Access::default();
        assert!(run(Command::ListSharedMail).is_err());
    }
}
