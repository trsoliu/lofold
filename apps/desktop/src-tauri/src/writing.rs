use lofold_mail_store::{WritingProfile, WritingRecord};
use tauri::State;

use crate::LocalArchive;

#[tauri::command]
pub async fn read_writing_profile(
    state: State<'_, LocalArchive>,
    account_id: Option<i64>,
) -> Result<WritingRecord, String> {
    state
        .run(move |store| store.read_writing_profile(account_id))
        .await
}

#[tauri::command]
pub async fn save_writing_profile(
    state: State<'_, LocalArchive>,
    account_id: Option<i64>,
    revision: i64,
    profile: WritingProfile,
) -> Result<WritingRecord, String> {
    state
        .run(move |store| store.save_writing_profile(account_id, revision, profile))
        .await
}
