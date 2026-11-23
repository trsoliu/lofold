use lofold_mail_network::{FolderMutation, RemoteFolderKind, SeenReceipt};
use lofold_mail_store::{
    CachedChange, DiscoveredMailbox, MailLocation, Mailbox, SyncPage, SyncedItem,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    accounts::{connected_connection, read_secret, worker},
    LocalArchive,
};

#[tauri::command]
pub async fn list_mailboxes(state: State<'_, LocalArchive>) -> Result<Vec<Mailbox>, String> {
    state.run(|store| store.mailboxes()).await
}

#[tauri::command]
pub async fn refresh_mailboxes(
    state: State<'_, LocalArchive>,
    account: i64,
) -> Result<Vec<Mailbox>, String> {
    let _operation = state.mail_operation.lock().await;
    let mail_account = state.run(move |store| store.account(account)).await?;
    let folders = worker(move || {
        let secret = read_secret(&mail_account)?;
        let folders = connected_connection(&mail_account)?
            .list_folders(&mail_account.address, &secret)
            .map_err(|error| error.to_string())?;
        Ok(folders
            .into_iter()
            .map(|folder| DiscoveredMailbox {
                name: folder.name,
                label: folder.label,
                delimiter: folder.delimiter,
                kind: match folder.kind {
                    RemoteFolderKind::Inbox => "inbox",
                    RemoteFolderKind::Sent => "sent",
                    RemoteFolderKind::Drafts => "drafts",
                    RemoteFolderKind::Junk => "junk",
                    RemoteFolderKind::Trash => "trash",
                    RemoteFolderKind::Archive => "archive",
                    RemoteFolderKind::Custom => "custom",
                }
                .into(),
            })
            .collect())
    })
    .await?;
    state
        .run(move |store| {
            store.replace_mailboxes(account, folders)?;
            store.mailboxes()
        })
        .await
}

#[derive(Serialize)]
pub struct MailboxSync {
    considered: u32,
    stored: u32,
    skipped: u32,
    #[serde(rename = "readWarning")]
    read_warning: Option<String>,
}

#[tauri::command]
pub async fn sync_mailbox(
    state: State<'_, LocalArchive>,
    id: i64,
    older: Option<bool>,
) -> Result<MailboxSync, String> {
    let _operation = state.mail_operation.lock().await;
    sync(&state, id, older.unwrap_or(false)).await
}

async fn sync(state: &LocalArchive, id: i64, older: bool) -> Result<MailboxSync, String> {
    let (account, folder, known, before) = state
        .run(move |store| {
            let folder = store.mailbox(id)?;
            let account = store.account(folder.account_id)?;
            let known = store.known_mailbox_items(&folder)?;
            let before = store.mailbox_cursor(id)?;
            Ok((account, folder, known, before))
        })
        .await?;
    let before = if older {
        Some(before.ok_or("这个文件夹暂无更早的服务器邮件。")?)
    } else {
        None
    };
    let batch = worker(move || {
        let secret = read_secret(&account)?;
        connected_connection(&account)?
            .receive_folder(&account.address, &secret, &folder.name, &known, before)
            .map_err(|error| error.to_string())
    })
    .await?;
    let considered = batch.considered;
    let skipped = batch.skipped;
    let page = SyncPage {
        uid_validity: batch.uid_validity,
        reconcile: batch.reconcile_from.zip(batch.reconcile_through),
        has_more: batch.has_more,
        items: batch
            .items
            .into_iter()
            .map(|item| SyncedItem {
                uid: item.uid,
                unread: item.unread,
                flagged: item.flagged,
                raw: item.raw,
            })
            .collect(),
    };
    let (stored, invalid) = state
        .run(move |store| store.store_mailbox(id, page, older))
        .await?;
    let read_warning = push_pending_seen(state, id, None).await.err();
    Ok(MailboxSync {
        considered,
        stored,
        skipped: skipped + invalid,
        read_warning,
    })
}

// The caller owns mail_operation across the pending check, IMAP confirmation and cache update.
// A later manual unread can therefore cancel a receipt that was waiting for this lock.
async fn push_pending_seen(
    state: &LocalArchive,
    id: i64,
    only: Option<MailLocation>,
) -> Result<(), String> {
    let pending = state
        .run(move |store| {
            let mut locations = store.pending_seen(id, only.map(|item| item.uid))?;
            if let Some(target) = only {
                locations.retain(|item| item.uid_validity == target.uid_validity);
            }
            let Some(first) = locations.first() else {
                return Ok(None);
            };
            let validity = first.uid_validity;
            let folder = store.mailbox(id)?;
            let account = store.account(folder.account_id)?;
            Ok(Some((
                account,
                folder.name,
                validity,
                locations
                    .into_iter()
                    .map(|item| item.uid)
                    .collect::<Vec<_>>(),
            )))
        })
        .await?;
    let Some((account, folder, uid_validity, uids)) = pending else {
        return Ok(());
    };
    let (receipts, failure) = worker(move || {
        let secret = read_secret(&account)?;
        connected_connection(&account)?
            .sync_seen(&account.address, &secret, &folder, uid_validity, &uids)
            .map_err(|error| error.to_string())
    })
    .await?;
    state
        .run(move |store| {
            for receipt in receipts {
                let (uid, change) = match receipt {
                    SeenReceipt::Confirmed(uid) => (uid, CachedChange::Seen(true)),
                    SeenReceipt::Vanished(uid) => (uid, CachedChange::Remove),
                };
                store.apply_mailbox_change(
                    MailLocation {
                        folder_id: id,
                        uid_validity,
                        uid,
                    },
                    change,
                )?;
            }
            Ok(())
        })
        .await?;
    match failure {
        Some(issue) => Err(issue.to_string()),
        None => Ok(()),
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MailboxAction {
    SyncRead,
    Read,
    Unread,
    Flag,
    Unflag,
    Move,
    DeletePermanently,
}

#[tauri::command]
pub async fn change_mailbox_message(
    state: State<'_, LocalArchive>,
    location: MailLocation,
    action: MailboxAction,
    target: Option<i64>,
) -> Result<Option<String>, String> {
    let _operation = state.mail_operation.lock().await;
    if matches!(action, MailboxAction::SyncRead) {
        push_pending_seen(&state, location.folder_id, Some(location)).await?;
        return Ok(None);
    }
    let (account, folder, destination) = state
        .run(move |store| {
            let folder = store.message_mailbox(location)?;
            let account = store.account(folder.account_id)?;
            let target = target.map(|id| store.mailbox(id)).transpose()?;
            Ok((account, folder, target))
        })
        .await?;
    if let Some(destination) = destination.as_ref() {
        if destination.account_id != folder.account_id
            || destination.generation != folder.generation
            || destination.id == folder.id
        {
            return Err("请选择此账号的另一个文件夹。".into());
        }
    }
    if matches!(action, MailboxAction::DeletePermanently) && folder.kind != "trash" {
        return Err("请在已删除文件夹中执行彻底删除。".into());
    }
    let target_id = destination.as_ref().map(|folder| folder.id);
    let change = worker(move || {
        let secret = read_secret(&account)?;
        let (mutation, change) = match action {
            MailboxAction::SyncRead => unreachable!("pending read receipts handled above"),
            MailboxAction::Read => (FolderMutation::Seen(true), CachedChange::Seen(true)),
            MailboxAction::Unread => (FolderMutation::Seen(false), CachedChange::Seen(false)),
            MailboxAction::Flag => (FolderMutation::Flagged(true), CachedChange::Flagged(true)),
            MailboxAction::Unflag => (FolderMutation::Flagged(false), CachedChange::Flagged(false)),
            MailboxAction::Move => {
                let destination = destination.as_ref().ok_or("请选择移动目标。")?;
                (
                    FolderMutation::Move(destination.name.as_str()),
                    CachedChange::Remove,
                )
            }
            MailboxAction::DeletePermanently => {
                (FolderMutation::DeletePermanently, CachedChange::Remove)
            }
        };
        connected_connection(&account)?
            .mutate_folder(
                &account.address,
                &secret,
                &folder.name,
                location.uid_validity,
                location.uid,
                mutation,
            )
            .map_err(|error| error.to_string())?;
        Ok(change)
    })
    .await;
    let change = match change {
        Ok(change) => change,
        Err(issue) if matches!(action, MailboxAction::Unread) => {
            let canceled = state
                .run(move |store| store.cancel_pending_seen(location))
                .await?;
            return if canceled {
                Ok(Some(format!("本机已标为未读，服务器未确认：{issue}")))
            } else {
                Err(issue)
            };
        }
        Err(issue) => return Err(issue),
    };
    state
        .run(move |store| store.apply_mailbox_change(location, change))
        .await?;
    if let Some(target_id) = target_id.filter(|_| matches!(action, MailboxAction::Move)) {
        if let Err(error) = sync(&state, target_id, false).await {
            return Ok(Some(format!(
                "服务器已确认移动。收取目标文件夹时失败：{error}"
            )));
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn pin_message(
    state: State<'_, LocalArchive>,
    account: Option<i64>,
    id: i64,
    pinned: bool,
) -> Result<(), String> {
    state
        .run(move |store| store.pin_message(account, id, pinned))
        .await
}
