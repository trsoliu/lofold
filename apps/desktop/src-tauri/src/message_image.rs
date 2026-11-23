use std::io::Read;

use super::{export_to_selection, image_watermark, Export, LocalArchive, MailArchive};
use lofold_mail_store::ArchiveError;
use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[cfg(target_os = "macos")]
fn render(html: &str) -> Result<Vec<u8>, String> {
    unsafe extern "C" {
        fn lofold_mail_image(
            source: *const u8,
            length: usize,
            out: *mut *mut u8,
            size: *mut usize,
        ) -> i32;
        fn lofold_free_mail_image(bytes: *mut u8);
    }
    let mut bytes = std::ptr::null_mut();
    let mut size = 0;
    // Native code retains the source before dispatch and returns a malloc-owned
    // buffer only on success. Its length and lifetime are explicit across FFI.
    unsafe {
        match lofold_mail_image(html.as_ptr(), html.len(), &mut bytes, &mut size) {
            0 => {
                let png = std::slice::from_raw_parts(bytes, size).to_vec();
                lofold_free_mail_image(bytes);
                Ok(png)
            }
            1 => Err("邮件排版超过单张 PNG 的尺寸上限，请导出 EML 原件。".into()),
            3 => Err("生成邮件长图超时，请重试。".into()),
            _ => Err("无法生成完整邮件长图。".into()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn render(_: &str) -> Result<Vec<u8>, String> {
    Err("邮件长图目前支持 macOS。".into())
}

#[derive(Serialize)]
struct ImageAccount {
    id: i64,
    address: String,
}

#[derive(Serialize)]
pub(super) struct ImageAccounts {
    linked: bool,
    accounts: Vec<ImageAccount>,
}

fn image_accounts(store: &MailArchive, id: i64) -> Result<ImageAccounts, ArchiveError> {
    let linked = store.linked_mail_accounts(id)?;
    let accounts = store
        .accounts()?
        .into_iter()
        .filter(|account| linked.is_empty() || linked.contains(&account.id))
        .map(|account| ImageAccount {
            id: account.id,
            address: account.address,
        })
        .collect();
    Ok(ImageAccounts {
        linked: !linked.is_empty(),
        accounts,
    })
}

#[tauri::command]
pub(super) async fn message_image_accounts(
    state: State<'_, LocalArchive>,
    id: i64,
) -> Result<ImageAccounts, String> {
    state.run(move |store| image_accounts(store, id)).await
}

#[tauri::command]
pub(super) async fn save_message_image(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, LocalArchive>,
    id: i64,
    html: String,
    account: Option<i64>,
) -> Result<bool, String> {
    if html.len() > 12 * 1024 * 1024 {
        return Err("邮件内容超过长图处理上限。".into());
    }
    let watermark = state
        .with_open_archive(move |archive| {
            let choices = image_accounts(&archive.mail, id).map_err(|error| error.to_string())?;
            match account {
                Some(id) => choices
                    .accounts
                    .into_iter()
                    .find(|account| account.id == id)
                    .map(|account| Some((account.address, archive.watermark_key.clone())))
                    .ok_or_else(|| "所选邮箱已变更，请重新选择暗水印账号。".to_owned()),
                None if choices.accounts.is_empty() => Ok(None),
                None => Err("请选择用于暗水印的邮箱账号。".into()),
            }
        })
        .await?;
    let directory = state.directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let filename = format!("LoFold-{id}.png");
        let dialog = app
            .dialog()
            .file()
            .set_title("保存邮件长图")
            .add_filter("PNG 图片", &["png"])
            .set_file_name(&filename);
        #[cfg(desktop)]
        let dialog = dialog.set_parent(&window);
        let Some(path) = dialog.blocking_save_file() else {
            return Ok(false);
        };
        let bytes = render(&html)?;
        let bytes = match watermark {
            Some((address, key)) => image_watermark::embed_png(&bytes, &address, &key)?,
            None => bytes,
        };
        export_to_selection(&directory, path, Export { filename, bytes })?;
        Ok(true)
    })
    .await
    .map_err(|_| "导出邮件长图中断。".to_owned())?
}

#[derive(Serialize)]
pub(super) struct WatermarkResult {
    address: Option<String>,
}

#[tauri::command]
pub(super) async fn read_image_watermark(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, LocalArchive>,
) -> Result<Option<WatermarkResult>, String> {
    let path = tauri::async_runtime::spawn_blocking(move || {
        let dialog = app
            .dialog()
            .file()
            .set_title("读取长图暗水印")
            .add_filter("PNG 图片", &["png"]);
        #[cfg(desktop)]
        let dialog = dialog.set_parent(&window);
        dialog.blocking_pick_file()
    })
    .await
    .map_err(|_| "文件选择中断。".to_owned())?;
    let Some(path) = path else { return Ok(None) };
    let key = state
        .with_open_archive(|archive| Ok(archive.watermark_key.clone()))
        .await?;
    tauri::async_runtime::spawn_blocking(move || {
        const MAX_FILE_SIZE: u64 = image_watermark::MAX_PNG_BYTES as u64;
        let (_, file) = crate::open_selection(path)?;
        let mut bytes = Vec::new();
        file.take(MAX_FILE_SIZE + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取所选图片。")?;
        if bytes.len() as u64 > MAX_FILE_SIZE {
            return Err("图片超过水印读取上限。".into());
        }
        let address = image_watermark::read_png(&bytes, &key)?;
        Ok(Some(WatermarkResult { address }))
    })
    .await
    .map_err(|_| "暗水印读取中断。".to_owned())?
}

#[tauri::command]
pub(super) async fn print_message(html: String) -> Result<bool, String> {
    if html.len() > 12 * 1024 * 1024 {
        return Err("邮件内容超过打印处理上限。".into());
    }
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(move || {
        unsafe extern "C" {
            fn lofold_print_mail(source: *const u8, length: usize) -> i32;
        }
        // Native code copies the UTF-8 source before dispatching to the UI.
        match unsafe { lofold_print_mail(html.as_ptr(), html.len()) } {
            0 => Ok(true),
            4 => Ok(false),
            _ => Err("无法打开邮件打印面板。".into()),
        }
    })
    .await
    .map_err(|_| "打印操作中断。".to_owned())?;
    #[cfg(not(target_os = "macos"))]
    Err("邮件打印目前支持 macOS。".into())
}
