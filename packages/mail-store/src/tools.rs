use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::{ArchiveError, Folder, MailArchive, MAX_SEARCH_CHARS};

const ITEMS_PER_PAGE: usize = 40;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentHit {
    pub message_id: i64,
    pub ordinal: u32,
    pub filename: String,
    pub subject: String,
    pub sender: String,
    pub sent_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPage {
    pub items: Vec<AttachmentHit>,
    pub has_more: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSpec {
    pub name: String,
    pub folder: Folder,
    pub account_id: Option<i64>,
    pub query: String,
    pub attachments_only: bool,
}

#[derive(Serialize)]
pub struct SavedSearch {
    pub id: i64,
    #[serde(flatten)]
    pub spec: SearchSpec,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub messages: i64,
    pub attachments: i64,
    pub raw_bytes: i64,
    pub stored_block_bytes: i64,
}

const ACCOUNT_SCOPE: &str = "
    (?1 IS NULL
        OR m.id IN (SELECT message_id FROM inbox_items WHERE account_id = ?1)
        OR m.id IN (SELECT sent_message_id FROM drafts WHERE account_id = ?1 AND status = 'sent')
        OR m.id IN (SELECT message_id FROM mail_probes WHERE account_id = ?1 AND status = 'received'))";

impl MailArchive {
    pub fn list_attachments(
        &self,
        query: &str,
        account_id: Option<i64>,
        offset: u32,
    ) -> Result<AttachmentPage, ArchiveError> {
        let query = query.trim();
        if query.chars().count() > MAX_SEARCH_CHARS {
            return Err(ArchiveError::SearchTooLong);
        }
        let mut statement = self.database.prepare(&format!(
            "SELECT f.message_id, f.ordinal, f.filename, m.subject, m.sender, m.sent_at
             FROM attachment_index f JOIN messages m ON m.id=f.message_id
             WHERE {ACCOUNT_SCOPE} AND (?2='' OR instr(lower(f.filename), lower(?2)))
             ORDER BY m.sent_at DESC NULLS LAST, m.id DESC, f.ordinal
             LIMIT ?3 OFFSET ?4"
        ))?;
        let mut items = statement
            .query_map(
                params![account_id, query, (ITEMS_PER_PAGE + 1) as u32, offset],
                |row| {
                    Ok(AttachmentHit {
                        message_id: row.get(0)?,
                        ordinal: row.get(1)?,
                        filename: row.get(2)?,
                        subject: row.get(3)?,
                        sender: row.get(4)?,
                        sent_at: row.get(5)?,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > ITEMS_PER_PAGE;
        items.truncate(ITEMS_PER_PAGE);
        Ok(AttachmentPage { items, has_more })
    }

    pub fn saved_searches(&self) -> Result<Vec<SavedSearch>, ArchiveError> {
        let mut statement = self.database.prepare(
            "SELECT id,name,folder,account_id,query,attachments_only FROM saved_searches ORDER BY id",
        )?;
        let items = statement
            .query_map([], |row| {
                let folder = match row.get::<_, String>(2)?.as_str() {
                    "inbox" => Folder::Inbox,
                    "unread" => Folder::Unread,
                    "sent" => Folder::Sent,
                    _ => Folder::Archive,
                };
                Ok(SavedSearch {
                    id: row.get(0)?,
                    spec: SearchSpec {
                        name: row.get(1)?,
                        folder,
                        account_id: row.get(3)?,
                        query: row.get(4)?,
                        attachments_only: row.get(5)?,
                    },
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(items)
    }

    pub fn pin_search(&mut self, spec: SearchSpec) -> Result<(), ArchiveError> {
        let name = spec.name.trim();
        let query = spec.query.trim();
        if name.is_empty() || name.chars().count() > 40 || name.chars().any(char::is_control) {
            return Err(ArchiveError::InvalidSearchName);
        }
        if query.chars().count() > MAX_SEARCH_CHARS {
            return Err(ArchiveError::SearchTooLong);
        }
        if query.is_empty() && !spec.attachments_only {
            return Err(ArchiveError::EmptySearch);
        }
        let folder = match spec.folder {
            Folder::Archive => "archive",
            Folder::Inbox => "inbox",
            Folder::Unread => "unread",
            Folder::Sent => "sent",
            Folder::Flagged
            | Folder::Junk
            | Folder::Trash
            | Folder::Remote
            | Folder::AccountMail => {
                return Err(ArchiveError::MissingMailbox);
            }
        };
        let account = spec
            .account_id
            .filter(|_| !matches!(spec.folder, Folder::Archive));
        let changed = self.database.execute(
            "INSERT INTO saved_searches(name,folder,account_id,query,attachments_only)
             VALUES (?1,?2,?3,?4,?5) ON CONFLICT(name) DO NOTHING",
            params![name, folder, account, query, spec.attachments_only],
        )?;
        if changed != 1 {
            return Err(ArchiveError::SearchNameUsed);
        }
        Ok(())
    }

    pub fn unpin_search(&mut self, id: i64) -> Result<(), ArchiveError> {
        self.database
            .execute("DELETE FROM saved_searches WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn storage_status(&self, account_id: Option<i64>) -> Result<StorageStatus, ArchiveError> {
        let status = self.database.query_row(
            &format!(
                "WITH included AS (SELECT m.id, m.raw_size FROM messages m WHERE {ACCOUNT_SCOPE})
                 SELECT count(*), coalesce(sum(raw_size), 0),
                    (SELECT count(*) FROM attachment_index f JOIN included i ON i.id=f.message_id),
                    (SELECT coalesce(sum(length(b.payload)),0) FROM message_blocks b JOIN included i ON i.id=b.message_id)
                 FROM included"
            ),
            [account_id],
            |row| Ok(StorageStatus {
                messages: row.get(0)?,
                raw_bytes: row.get(1)?,
                attachments: row.get(2)?,
                stored_block_bytes: row.get(3)?,
            }),
        )?;
        Ok(status)
    }
}
