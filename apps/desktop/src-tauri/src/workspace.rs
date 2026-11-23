use std::{collections::HashSet, io::Read};

use lofold_mail_network::{prepare_mail_with_recipients, MailError, MailRecipients};
use lofold_mail_store::{ComposeMode, Draft, DraftFields, InboxItem, MAX_DRAFT_FILES_BYTES};
use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::{
    accounts::{connected_connection, read_secret, worker},
    LocalArchive,
};

#[derive(Serialize)]
pub struct SyncResult {
    considered: u32,
    stored: u32,
    skipped: u32,
}

#[tauri::command]
pub async fn sync_inbox(state: State<'_, LocalArchive>, id: i64) -> Result<SyncResult, String> {
    let _operation = state.mail_operation.lock().await;
    let (account, known) = state
        .run(move |store| {
            Ok((
                store.account(id)?,
                store
                    .known_inbox_items(id)?
                    .into_iter()
                    .collect::<HashSet<_>>(),
            ))
        })
        .await?;
    let batch = worker(move || {
        let connection = connected_connection(&account)?;
        let secret = read_secret(&account)?;
        connection
            .receive_recent(&account.address, &secret, &known)
            .map_err(|error| error.to_string())
    })
    .await?;
    let items = batch
        .items
        .into_iter()
        .map(|item| InboxItem {
            uid: item.uid,
            unread: item.unread,
            raw: item.raw,
        })
        .collect();
    let (stored, invalid) = state
        .run(move |store| store.store_inbox(id, batch.uid_validity, items))
        .await?;
    Ok(SyncResult {
        considered: batch.considered,
        stored,
        skipped: batch.skipped + invalid,
    })
}

#[tauri::command]
pub async fn mark_inbox_read(
    state: State<'_, LocalArchive>,
    id: i64,
    account: i64,
) -> Result<(), String> {
    state
        .run(move |store| store.mark_inbox_read(account, id))
        .await
}

#[tauri::command]
pub async fn create_draft(
    state: State<'_, LocalArchive>,
    account_id: Option<i64>,
    reply: Option<i64>,
    mode: Option<ComposeMode>,
) -> Result<Draft, String> {
    state
        .run(move |store| match (reply, mode.unwrap_or_default()) {
            (Some(id), mode) => store.create_draft_from_message(account_id, id, mode),
            (None, ComposeMode::Reply) => store.create_draft(account_id, None),
            (None, _) => Err(lofold_mail_store::ArchiveError::MissingMessage),
        })
        .await
}

#[tauri::command]
pub async fn discard_draft(
    state: State<'_, LocalArchive>,
    id: i64,
    revision: i64,
) -> Result<(), String> {
    state
        .run(move |store| store.discard_draft(id, revision))
        .await
}

#[tauri::command]
pub async fn list_drafts(
    state: State<'_, LocalArchive>,
    account_id: Option<i64>,
) -> Result<Vec<Draft>, String> {
    state
        .run(move |store| store.drafts_for_account(account_id))
        .await
}

#[tauri::command]
pub async fn read_draft(state: State<'_, LocalArchive>, id: i64) -> Result<Draft, String> {
    state.run(move |store| store.draft(id)).await
}

#[tauri::command]
pub async fn save_draft(
    state: State<'_, LocalArchive>,
    id: i64,
    revision: i64,
    fields: DraftFields,
) -> Result<Draft, String> {
    state
        .run(move |store| store.save_draft(id, revision, fields))
        .await
}

#[tauri::command]
pub async fn attach_draft_file(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, LocalArchive>,
    id: i64,
    revision: i64,
) -> Result<Option<Draft>, String> {
    let attachment = worker(move || {
        let dialog = app.dialog().file().set_title("为草稿选择附件");
        #[cfg(desktop)]
        let dialog = dialog.set_parent(&window);
        let Some(path) = dialog.blocking_pick_file() else {
            return Ok(None);
        };
        let (name, file) = crate::open_selection(path)?;
        let mut payload = Vec::new();
        file.take((MAX_DRAFT_FILES_BYTES + 1) as u64)
            .read_to_end(&mut payload)
            .map_err(|_| "无法读取所选文件。")?;
        if payload.len() > MAX_DRAFT_FILES_BYTES {
            return Err("附件合计上限为 8 MiB。".into());
        }
        Ok(Some((name, payload)))
    })
    .await?;
    if let Some((name, payload)) = attachment {
        state
            .run(move |store| store.attach_draft_file(id, revision, name, payload))
            .await
            .map(Some)
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn remove_draft_file(
    state: State<'_, LocalArchive>,
    id: i64,
    revision: i64,
    file: i64,
) -> Result<Draft, String> {
    state
        .run(move |store| store.remove_draft_file(id, revision, file))
        .await
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SendResult {
    Accepted { message_id: i64 },
    Rejected { detail: String },
    Uncertain { detail: String },
}

#[tauri::command]
pub async fn submit_draft(
    state: State<'_, LocalArchive>,
    id: i64,
    revision: i64,
) -> Result<SendResult, String> {
    let _operation = state.mail_operation.lock().await;
    let payload = state
        .run(move |store| store.draft_for_send(id, revision))
        .await?;
    let account_id = payload.fields.account_id.ok_or("请先选择发件邮箱。")?;
    let account = state.run(move |store| store.account(account_id)).await?;
    let (account, secret, mail) = worker(move || {
        connected_connection(&account)?;
        let mail = prepare_mail_with_recipients(
            &account.address,
            MailRecipients {
                to: &payload.fields.recipient,
                cc: &payload.fields.cc,
                bcc: &payload.fields.bcc,
            },
            &payload.fields.subject,
            &payload.fields.body,
            payload.reply_id.as_deref(),
            payload.files,
        )
        .map_err(|error| error.to_string())?;
        let secret = read_secret(&account)?;
        Ok((account, secret, mail))
    })
    .await?;
    // Persist the attempt before submitting DATA. A crash may leave it uncertain.
    state
        .run(move |store| store.reserve_draft_send(id, revision))
        .await?;
    let (result, raw) = worker(move || {
        let result = connected_connection(&account)?.deliver(&account.address, &secret, &mail);
        Ok((result, mail.raw))
    })
    .await?;
    match result {
        Ok(()) => {
            let message_id = state
                .run(move |store| store.finish_draft_send(id, &raw))
                .await
                .map_err(|_| "服务商已接受邮件，本机保存已发送副本失败。请先核对投递结果。")?;
            Ok(SendResult::Accepted { message_id })
        }
        Err(error @ (MailError::SmtpRejected | MailError::SmtpConnection)) => {
            state.run(move |store| store.reject_draft_send(id)).await?;
            Ok(SendResult::Rejected {
                detail: error.to_string(),
            })
        }
        Err(error) => Ok(SendResult::Uncertain {
            detail: error.to_string(),
        }),
    }
}
