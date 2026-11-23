use lofold_mail_store::{AttachmentPage, SavedSearch, SearchSpec, StorageStatus};
use tauri::State;

use crate::LocalArchive;

#[tauri::command]
pub async fn list_attachments(
    state: State<'_, LocalArchive>,
    query: String,
    account_id: Option<i64>,
    offset: u32,
) -> Result<AttachmentPage, String> {
    state
        .run(move |store| store.list_attachments(&query, account_id, offset))
        .await
}

#[tauri::command]
pub async fn list_saved_searches(
    state: State<'_, LocalArchive>,
) -> Result<Vec<SavedSearch>, String> {
    state.run(|store| store.saved_searches()).await
}

#[tauri::command]
pub async fn pin_search(state: State<'_, LocalArchive>, spec: SearchSpec) -> Result<(), String> {
    state.run(move |store| store.pin_search(spec)).await
}

#[tauri::command]
pub async fn unpin_search(state: State<'_, LocalArchive>, id: i64) -> Result<(), String> {
    state.run(move |store| store.unpin_search(id)).await
}

#[tauri::command]
pub async fn storage_status(
    state: State<'_, LocalArchive>,
    account_id: Option<i64>,
) -> Result<StorageStatus, String> {
    state
        .run(move |store| store.storage_status(account_id))
        .await
}
