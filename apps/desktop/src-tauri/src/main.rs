use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use lofold_mail_store::{
    Conversation, Export, Folder, ImportResult, MailArchive, MailDetail, MailPage, MAX_EML_BYTES,
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, State, WebviewWindow,
};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

mod accounts;
mod ai;
mod image_watermark;
mod mailboxes;
#[cfg(target_os = "macos")]
mod mcp;
mod message_image;
mod tools;
mod workspace;

#[derive(Clone)]
struct LocalArchive {
    directory: PathBuf,
    store: Arc<Mutex<Option<OpenedArchive>>>,
    mail_operation: Arc<tauri::async_runtime::Mutex<()>>,
}

struct OpenedArchive {
    mail: MailArchive,
    watermark_key: Zeroizing<[u8; 32]>,
}

impl LocalArchive {
    async fn run<T, F>(&self, operation: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: Send + 'static + FnOnce(&mut MailArchive) -> Result<T, lofold_mail_store::ArchiveError>,
    {
        self.with_open_archive(move |archive| {
            operation(&mut archive.mail).map_err(|error| error.to_string())
        })
        .await
    }

    async fn with_open_archive<T, F>(&self, operation: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: Send + 'static + FnOnce(&mut OpenedArchive) -> Result<T, String>,
    {
        let archive = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut store = archive
                .store
                .lock()
                .map_err(|_| "归档当前不可用，请重新启动 LoFold。")?;
            if store.is_none() {
                *store = Some(open_archive(&archive.directory)?);
            }
            operation(store.as_mut().expect("archive is open"))
        })
        .await
        .map_err(|_| "归档操作中断。".to_owned())?
    }
}

#[cfg(target_os = "macos")]
fn open_archive(directory: &Path) -> Result<OpenedArchive, String> {
    use fs2::FileExt;
    use security_framework::passwords::{get_generic_password, set_generic_password};
    use std::fs::{self, OpenOptions};

    const SERVICE: &str = "org.lofold.client";
    const ACCOUNT: &str = "archive-key-v1";
    const ITEM_NOT_FOUND: i32 = -25300;

    fs::create_dir_all(directory).map_err(|_| "无法创建本机归档目录。")?;
    let path = directory.join("archive.sqlite3");
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(directory.join("archive.lock"))
        .map_err(|_| "无法访问本机归档目录。")?;
    FileExt::lock_exclusive(&lock).map_err(|_| "无法锁定本机归档。")?;

    let mut key = Zeroizing::new([0u8; 32]);
    match get_generic_password(SERVICE, ACCOUNT) {
        Ok(bytes) => {
            let bytes = Zeroizing::new(bytes);
            if bytes.len() != key.len() {
                return Err("钥匙串中的归档密钥格式无效。".into());
            }
            key.copy_from_slice(&bytes);
        }
        Err(error) if error.code() == ITEM_NOT_FOUND => {
            if path.try_exists().map_err(|_| "无法确认本机归档状态。")? {
                return Err("找不到现有归档的钥匙串密钥。请恢复原有密钥后重试。".into());
            }
            getrandom::fill(&mut key[..]).map_err(|_| "无法生成归档密钥。")?;
            set_generic_password(SERVICE, ACCOUNT, &key[..]).map_err(|_| "无法保存钥匙串密钥。")?;
        }
        Err(_) => return Err("无法访问 macOS 钥匙串。解锁后请重试。".into()),
    }

    let mail = MailArchive::open(&path, &key).map_err(|error| error.to_string())?;
    Ok(OpenedArchive {
        mail,
        watermark_key: image_watermark::derive_key(&key),
    })
}

#[cfg(not(target_os = "macos"))]
fn open_archive(_directory: &Path) -> Result<OpenedArchive, String> {
    Err("当前版本的加密归档支持 macOS。".into())
}

#[tauri::command]
async fn import_eml(
    request: Request<'_>,
    state: State<'_, LocalArchive>,
) -> Result<ImportResult, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("无法读取所选 EML 文件。".into());
    };
    if bytes.len() > MAX_EML_BYTES {
        return Err("每封 EML 最大支持 16 MiB。".into());
    }
    let bytes = bytes.clone();
    state.run(move |store| store.import(&bytes)).await
}

#[tauri::command]
async fn list_mail(
    state: State<'_, LocalArchive>,
    query: String,
    offset: u32,
    folder: Option<Folder>,
    account: Option<i64>,
    attachments_only: Option<bool>,
    mailbox: Option<i64>,
) -> Result<MailPage, String> {
    state
        .run(move |store| {
            store.search_mailboxes(
                folder.unwrap_or(Folder::Archive),
                account,
                &query,
                attachments_only.unwrap_or(false),
                offset,
                mailbox,
            )
        })
        .await
}

#[tauri::command]
async fn read_mail(state: State<'_, LocalArchive>, id: i64) -> Result<MailDetail, String> {
    state.run(move |store| store.detail(id)).await
}

#[tauri::command]
async fn read_conversation(
    state: State<'_, LocalArchive>,
    id: i64,
    account: Option<i64>,
) -> Result<Conversation, String> {
    state
        .run(move |store| store.conversation(id, account))
        .await
}

#[tauri::command]
async fn save_mail(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, LocalArchive>,
    id: i64,
    attachment_index: Option<usize>,
) -> Result<bool, String> {
    let export = state
        .run(move |store| match attachment_index {
            Some(index) => store.export_attachment(id, index),
            None => store.export_raw(id),
        })
        .await?;
    let directory = state.directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app
            .dialog()
            .file()
            .set_title("保存文件")
            .set_file_name(&export.filename);
        #[cfg(desktop)]
        let dialog = dialog.set_parent(&window);
        let Some(path) = dialog.blocking_save_file() else {
            return Ok(false);
        };
        let path = path.into_path().map_err(|_| "所选位置无法保存文件。")?;
        write_export(&directory, &path, export)?;
        Ok(true)
    })
    .await
    .map_err(|_| "导出操作中断。".to_owned())?
}

fn write_export(directory: &Path, path: &Path, export: Export) -> Result<(), String> {
    let parent = path
        .parent()
        .and_then(|path| path.canonicalize().ok())
        .ok_or("无法访问所选保存目录。")?;
    let archive = directory.canonicalize().map_err(|_| "无法确认归档目录。")?;
    if parent.starts_with(archive) {
        return Err("请选择归档数据目录之外的位置。".into());
    }
    let filename = path.file_name().ok_or("文件名无效。")?;
    let mut temp = tempfile::NamedTempFile::new_in(&parent).map_err(|_| "无法创建导出文件。")?;
    temp.write_all(&export.bytes)
        .and_then(|()| temp.as_file().sync_all())
        .map_err(|_| "无法写入导出文件。")?;
    temp.persist(parent.join(filename))
        .map_err(|_| "无法保存到所选位置。")?;
    Ok(())
}

fn main() {
    #[cfg(target_os = "macos")]
    if std::env::args_os()
        .nth(1)
        .is_some_and(|argument| argument == "--mcp")
    {
        if let Err(error) = lofold_agent_mcp::run_stdio() {
            eprintln!("LoFold MCP: {error}");
            std::process::exit(1);
        }
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(LocalArchive {
                directory: app.path().app_local_data_dir()?,
                store: Arc::new(Mutex::new(None)),
                mail_operation: Arc::new(tauri::async_runtime::Mutex::new(())),
            });
            app.manage(ai::AiState::default());
            #[cfg(target_os = "macos")]
            app.manage(mcp::AgentAccess::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            import_eml,
            list_mail,
            read_mail,
            read_conversation,
            save_mail,
            ai::ai_models,
            ai::run_ai,
            ai::cancel_ai,
            #[cfg(target_os = "macos")]
            mcp::mcp_settings,
            #[cfg(target_os = "macos")]
            mcp::mcp_set_enabled,
            #[cfg(target_os = "macos")]
            mcp::mcp_share_mail,
            #[cfg(target_os = "macos")]
            mcp::mcp_revoke_mail,
            #[cfg(target_os = "macos")]
            mcp::mcp_take_draft,
            message_image::save_message_image,
            message_image::message_image_accounts,
            message_image::read_image_watermark,
            message_image::print_message,
            mailboxes::list_mailboxes,
            mailboxes::refresh_mailboxes,
            mailboxes::sync_mailbox,
            mailboxes::change_mailbox_message,
            mailboxes::pin_message,
            accounts::list_accounts,
            accounts::import_mailmaster,
            accounts::add_mail_account,
            accounts::preview_account_removal,
            accounts::remove_mail_account,
            accounts::save_mail_servers,
            accounts::authorize_mail_account,
            accounts::send_mail_probe,
            accounts::check_mail_probe,
            workspace::sync_inbox,
            workspace::mark_inbox_read,
            workspace::create_draft,
            workspace::discard_draft,
            workspace::list_drafts,
            workspace::read_draft,
            workspace::save_draft,
            workspace::attach_draft_file,
            workspace::remove_draft_file,
            workspace::submit_draft,
            tools::list_attachments,
            tools::list_saved_searches,
            tools::pin_search,
            tools::unpin_search,
            tools::storage_status
        ])
        .build(tauri::generate_context!())
        .expect("LoFold could not start")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if matches!(_event, tauri::RunEvent::Exit) {
                _app.state::<mcp::AgentAccess>().shutdown();
            }
        });
}
