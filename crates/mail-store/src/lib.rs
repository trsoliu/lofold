use std::{io, path::Path, time::Duration};

use mail_blob_codec::{decode_block, encode_block, CompressionHint, MAX_BLOCK_BYTES};
use mail_parser::{AddressList, Message, MessageParser};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const MAX_EML_BYTES: usize = 16 * 1024 * 1024;
const MAX_READING_CHARS: usize = 250_000;
const MAX_SEARCH_CHARS: usize = 160;
const PAGE_SIZE: u32 = 60;
const SCHEMA_VERSION: u32 = 9;

mod accounts;
mod conversations;
mod mailboxes;
mod rich_body;
mod tools;
mod workspace;
pub use accounts::{
    mailmaster_addresses, AccountRemoval, MailAccount, MailProbe, ProbeOutcome, Server,
    ServerSettings,
};
pub use conversations::Conversation;
pub use mailboxes::{CachedChange, DiscoveredMailbox, MailLocation, Mailbox, SyncPage, SyncedItem};
pub use tools::{AttachmentPage, SavedSearch, SearchSpec, StorageStatus};
pub use workspace::{ComposeMode, Draft, DraftFields, Folder, InboxItem, MAX_DRAFT_FILES_BYTES};

#[derive(Debug, Error)]
pub enum ArchiveError {
    #[error("每封 EML 最大支持 16 MiB。")]
    TooLarge,
    #[error("文件中没有可识别的邮件头。")]
    InvalidMessage,
    #[error("这封邮件在本机归档中不存在。")]
    MissingMessage,
    #[error("邮件原件完整性校验失败。")]
    Integrity,
    #[error("该附件不存在。")]
    MissingAttachment,
    #[error("附件的传输编码异常，请导出邮件原件。")]
    AttachmentEncoding,
    #[error("无法识别此版本的邮箱大师账号表。")]
    MailMaster,
    #[error("该邮箱账号不存在。")]
    MissingAccount,
    #[error("邮箱服务器配置已更新，请重新打开账号并验证。")]
    AccountChanged,
    #[error("无法读取邮箱服务器配置。")]
    ServerSettings,
    #[error("当前有一封待查收的样信。")]
    PendingProbe,
    #[error("该草稿不存在。")]
    MissingDraft,
    #[error("草稿已更新或正在提交，请重新打开查看。")]
    DraftChanged,
    #[error("草稿文字超过长度限制。")]
    DraftTooLarge,
    #[error("每封草稿最多 12 个附件，附件合计上限 8 MiB。")]
    DraftAttachmentsLimit,
    #[error("找不到可以回复的发件地址。")]
    InvalidReply,
    #[error("回复全部包含无效地址或超过 20 个收件人，请手动填写收件人。")]
    InvalidReplyRecipients,
    #[error("服务端草稿包含无法导入的收件地址。")]
    InvalidDraftRecipients,
    #[error("这个服务器文件夹已变更，请刷新文件夹。")]
    MissingMailbox,
    #[error("这封邮件的位置已变更，请刷新文件夹。")]
    MissingMailboxMessage,
    #[error("请输入 1 至 40 个字符的搜索名称。")]
    InvalidSearchName,
    #[error("已存在同名固定搜索。")]
    SearchNameUsed,
    #[error("请输入搜索词或启用「含附件」。")]
    EmptySearch,
    #[error("归档版本高于此应用支持的版本。")]
    NewerArchive,
    #[error("无法打开加密归档。")]
    Encryption,
    #[error("搜索词最多支持 160 个字符。")]
    SearchTooLong,
    #[error("归档数据库操作失败。")]
    Database(#[from] rusqlite::Error),
    #[error("邮件数据读写失败。")]
    Storage(#[from] io::Error),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSummary {
    id: i64,
    subject: String,
    sender: String,
    preview: String,
    sent_at: Option<i64>,
    has_attachments: bool,
    account_id: Option<i64>,
    account_address: Option<String>,
    unread: bool,
    flagged: bool,
    pinned: bool,
    location: Option<MailLocation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailPage {
    items: Vec<MailSummary>,
    has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDetail {
    #[serde(flatten)]
    summary: MailSummary,
    recipients: String,
    body: String,
    body_truncated: bool,
    rich_body: Option<rich_body::RichBody>,
    attachments: Vec<Attachment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Attachment {
    index: usize,
    name: String,
    size: usize,
}

#[derive(Serialize)]
pub struct ImportResult {
    pub id: i64,
    duplicate: bool,
}

pub struct Export {
    pub filename: String,
    pub bytes: Vec<u8>,
}

pub struct MailArchive {
    database: Connection,
}

impl MailArchive {
    pub fn open(path: &Path, key: &[u8; 32]) -> Result<Self, ArchiveError> {
        let mut database = Connection::open(path)?;
        database.busy_timeout(Duration::from_secs(5))?;
        database.pragma_update(None, "key", format!("x'{}'", hex::encode(key)))?;
        let cipher: Option<String> = database
            .query_row("PRAGMA cipher_version", [], |row| row.get(0))
            .optional()?;
        if cipher.is_none() {
            return Err(ArchiveError::Encryption);
        }
        database
            .query_row("SELECT count(*) FROM sqlite_master", [], |row| {
                row.get::<_, u32>(0)
            })
            .map_err(|_| ArchiveError::Encryption)?;
        database.execute_batch("PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON;")?;
        let migration = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: u32 = migration.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(ArchiveError::NewerArchive);
        }
        if version == 0 {
            migration.execute_batch(include_str!("schema.sql"))?;
        }
        if version < 2 {
            migration.execute_batch(include_str!("accounts.sql"))?;
        }
        if version < 3 {
            migration.execute_batch(include_str!("workspace.sql"))?;
        }
        if version < 4 {
            migration.execute_batch(include_str!("tools.sql"))?;
        }
        if version < 5 {
            migration.execute_batch(include_str!("servers.sql"))?;
        }
        if version < 6 {
            migration.execute_batch(include_str!("mailboxes.sql"))?;
        }
        if version < 7 {
            let has_conversations: bool = migration.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'conversation_headers')",
                [],
                |row| row.get(0),
            )?;
            if !has_conversations {
                migration.execute_batch(include_str!("conversations.sql"))?;
            }
        }
        if version < 8 {
            migration.execute_batch(include_str!("account-removal.sql"))?;
        }
        if version < 9 {
            migration.execute_batch(include_str!("draft_recipients.sql"))?;
            migration.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        migration.commit()?;
        Ok(Self { database })
    }

    pub fn import(&mut self, raw: &[u8]) -> Result<ImportResult, ArchiveError> {
        let tx = self
            .database
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let imported = Self::import_transaction(&tx, raw)?;
        tx.commit()?;
        Ok(imported)
    }

    fn import_transaction(tx: &Transaction<'_>, raw: &[u8]) -> Result<ImportResult, ArchiveError> {
        let message = parse(raw)?;
        let digest = Sha256::digest(raw);
        let duplicate = tx
            .query_row(
                "SELECT id FROM messages WHERE digest = ?1",
                [digest.as_slice()],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = duplicate {
            return Ok(ImportResult {
                id,
                duplicate: true,
            });
        }

        let subject = message.subject().unwrap_or_default();
        let sender = address_line(message.from());
        let recipients = address_line(message.to());
        let body = reading_body(&message);
        let preview = body.split_whitespace().collect::<Vec<_>>().join(" ");
        let preview: String = preview.chars().take(160).collect();
        let filenames = message
            .attachments()
            .enumerate()
            .map(|(index, part)| attachment_name(index, part.attachment_name()))
            .collect::<Vec<_>>();
        tx.execute(
            "INSERT INTO messages (digest, raw_size, subject, sender, preview, sent_at, has_attachments)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                digest.as_slice(), raw.len() as u32, subject, sender, preview,
                message.date().map(|date| date.to_timestamp()), !filenames.is_empty(),
            ],
        )?;
        let id = tx.last_insert_rowid();
        Self::index_conversation_headers(tx, id, &message)?;
        tx.execute(
            "INSERT INTO message_search (rowid, subject, sender, recipients, body, filenames)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, subject, sender, recipients, body, filenames.join("\n")],
        )?;
        {
            let mut index = tx.prepare("INSERT INTO attachment_index VALUES (?1, ?2, ?3)")?;
            for (ordinal, filename) in filenames.iter().enumerate() {
                index.execute(params![id, ordinal as u32, filename])?;
            }
        }
        {
            let mut insert = tx.prepare("INSERT INTO message_blocks VALUES (?1, ?2, ?3)")?;
            for (index, chunk) in raw.chunks(MAX_BLOCK_BYTES).enumerate() {
                let encoded = encode_block(chunk, CompressionHint::Auto)?;
                insert.execute(params![id, index as u32, encoded])?;
            }
        }
        Ok(ImportResult {
            id,
            duplicate: false,
        })
    }

    pub fn list(&self, query: &str, offset: u32) -> Result<MailPage, ArchiveError> {
        self.list_folder(Folder::Archive, None, query, offset)
    }

    pub fn list_folder(
        &self,
        folder: Folder,
        account: Option<i64>,
        query: &str,
        offset: u32,
    ) -> Result<MailPage, ArchiveError> {
        self.search_folder(folder, account, query, false, offset)
    }

    pub fn search_folder(
        &self,
        folder: Folder,
        account: Option<i64>,
        query: &str,
        attachments_only: bool,
        offset: u32,
    ) -> Result<MailPage, ArchiveError> {
        self.search_mailboxes(folder, account, query, attachments_only, offset, None)
    }

    pub fn search_mailboxes(
        &self,
        folder: Folder,
        account: Option<i64>,
        query: &str,
        attachments_only: bool,
        offset: u32,
        mailbox: Option<i64>,
    ) -> Result<MailPage, ArchiveError> {
        let query = query.trim();
        let chars = query.chars().count();
        if chars > MAX_SEARCH_CHARS {
            return Err(ArchiveError::SearchTooLong);
        }
        let (filter, pattern) = match chars {
            0 => ("?1 = ''", String::new()),
            1..=2 => (
                "m.id IN (
                    SELECT rowid FROM message_search
                    WHERE instr(lower(subject), lower(?1)) OR instr(lower(sender), lower(?1))
                       OR instr(lower(recipients), lower(?1)) OR instr(lower(body), lower(?1))
                       OR instr(lower(filenames), lower(?1))
                )",
                query.to_owned(),
            ),
            _ => (
                "m.id IN (SELECT rowid FROM message_search WHERE message_search MATCH ?1)",
                format!("\"{}\"", query.replace('"', "\"\"")),
            ),
        };
        let (columns, joins, pin_account) = if matches!(folder, Folder::Archive) {
            ("NULL, NULL, 0, 0, NULL, NULL, NULL", String::new(), "0")
        } else {
            let folder_filter = match folder {
                Folder::Inbox => "i.mailbox='INBOX'",
                Folder::Unread => "i.unread AND NOT i.local_read AND (i.mailbox='INBOX' OR f.kind IN ('custom','archive','inbox'))",
                Folder::Flagged => "i.flagged AND (i.mailbox='INBOX' OR f.kind NOT IN ('trash','junk','drafts'))",
                Folder::Sent => "f.kind='sent'",
                Folder::Junk => "f.kind='junk'",
                Folder::Trash => "f.kind='trash'",
                Folder::Remote => "f.id=?6",
                Folder::Archive => unreachable!(),
            };
            let remote = format!(
                "SELECT i.account_id,i.message_id,(i.unread AND NOT i.local_read) AS unread,i.flagged,
                    CASE WHEN f.validity=i.uid_validity THEN f.id END AS folder_id,i.uid_validity,i.uid
                 FROM inbox_items i LEFT JOIN mailboxes f ON f.account_id=i.account_id
                    AND f.generation=i.inbox_generation AND f.name=i.mailbox AND f.listed
                    AND f.generation=coalesce((SELECT inbox_generation FROM mail_servers s WHERE s.account_id=i.account_id),0)
                 WHERE ({folder_filter}) AND (?4 IS NULL OR i.account_id=?4)"
            );
            let sent = if matches!(folder, Folder::Sent) {
                "UNION ALL SELECT account_id,sent_message_id,0,0,NULL,NULL,NULL
                 FROM drafts WHERE status='sent' AND (?4 IS NULL OR account_id=?4)"
            } else {
                ""
            };
            let joins = format!(
                "JOIN (SELECT folders.*, row_number() OVER (PARTITION BY account_id,message_id
                    ORDER BY folder_id IS NOT NULL DESC, unread DESC, flagged DESC, folder_id, uid DESC) AS ordinal
                    FROM ({remote} {sent}) folders) item ON item.message_id=m.id AND item.ordinal=1
                 LEFT JOIN mail_accounts a ON a.id=item.account_id"
            );
            ("item.account_id, a.address, item.unread, item.flagged, item.folder_id, item.uid_validity, item.uid", joins, "coalesce(item.account_id,0)")
        };
        let valid_scope = match folder {
            Folder::Archive => "?4 IS NULL AND ?6 IS NULL",
            Folder::Remote => "?6 IS NOT NULL",
            _ => "?6 IS NULL",
        };
        let mut statement = self.database.prepare(&format!(
            "SELECT m.id,m.subject,m.sender,m.preview,m.sent_at,m.has_attachments,{columns},p.message_id IS NOT NULL
             FROM messages m {joins} LEFT JOIN pinned_messages p ON p.message_id=m.id AND p.account_id={pin_account}
             WHERE {filter} AND (NOT ?5 OR m.has_attachments=1) AND ({valid_scope})
             ORDER BY p.message_id IS NOT NULL DESC,m.sent_at DESC NULLS LAST,m.id DESC,7 DESC LIMIT ?2 OFFSET ?3"
        ))?;
        let mut items = statement
            .query_map(
                params![
                    pattern,
                    PAGE_SIZE + 1,
                    offset,
                    account,
                    attachments_only,
                    mailbox
                ],
                summary_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > PAGE_SIZE as usize;
        items.truncate(PAGE_SIZE as usize);
        Ok(MailPage { items, has_more })
    }

    pub fn detail(&self, id: i64) -> Result<MailDetail, ArchiveError> {
        let summary = self.summary(id)?;
        let raw = self.read_raw(id)?;
        let message = parse(&raw)?;
        let recipients = address_line(message.to());
        let mut body = reading_body(&message);
        let limit = body.char_indices().nth(MAX_READING_CHARS);
        if let Some((byte, _)) = limit {
            body.truncate(byte);
        }
        let attachments = message
            .attachments()
            .enumerate()
            .map(|(index, part)| Attachment {
                index,
                name: attachment_name(index, part.attachment_name()),
                size: part.decoded_len(),
            })
            .collect();
        Ok(MailDetail {
            summary,
            recipients,
            body,
            body_truncated: limit.is_some(),
            rich_body: rich_body::extract(&message),
            attachments,
        })
    }

    pub fn export_raw(&self, id: i64) -> Result<Export, ArchiveError> {
        let bytes = self.read_raw(id)?;
        Ok(Export {
            filename: format!("LoFold-{id}.eml"),
            bytes,
        })
    }

    pub fn export_attachment(&self, id: i64, index: usize) -> Result<Export, ArchiveError> {
        let raw = self.read_raw(id)?;
        let message = parse(&raw)?;
        let part = message
            .attachments()
            .nth(index)
            .ok_or(ArchiveError::MissingAttachment)?;
        let (bytes, problems) = part.decoded_checked();
        if !problems.is_empty() {
            return Err(ArchiveError::AttachmentEncoding);
        }
        Ok(Export {
            filename: attachment_name(index, part.attachment_name()),
            bytes: bytes.into_owned(),
        })
    }

    fn summary(&self, id: i64) -> Result<MailSummary, ArchiveError> {
        self.database
            .query_row(
                "SELECT id,subject,sender,preview,sent_at,has_attachments,NULL,NULL,0,0,NULL,NULL,NULL,
                        EXISTS(SELECT 1 FROM pinned_messages WHERE account_id=0 AND message_id=messages.id)
                 FROM messages WHERE id=?1",
                [id],
                summary_from_row,
            )
            .optional()?
            .ok_or(ArchiveError::MissingMessage)
    }

    fn read_raw(&self, id: i64) -> Result<Vec<u8>, ArchiveError> {
        let (size, digest): (u32, Vec<u8>) = self
            .database
            .query_row(
                "SELECT raw_size, digest FROM messages WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or(ArchiveError::MissingMessage)?;
        let size = size as usize;
        if !(1..=MAX_EML_BYTES).contains(&size) {
            return Err(ArchiveError::Integrity);
        }
        let mut statement = self.database.prepare(
            "SELECT ordinal, payload FROM message_blocks WHERE message_id = ?1 ORDER BY ordinal",
        )?;
        let mut rows = statement.query([id])?;
        let mut raw = Vec::with_capacity(size);
        let mut expected = 0;
        while let Some(row) = rows.next()? {
            if row.get::<_, u32>(0)? != expected {
                return Err(ArchiveError::Integrity);
            }
            let block = decode_block(
                row.get_ref(1)?
                    .as_blob()
                    .map_err(|_| ArchiveError::Integrity)?,
            )?;
            if block.len() != (size - raw.len()).min(MAX_BLOCK_BYTES) || block.is_empty() {
                return Err(ArchiveError::Integrity);
            }
            raw.extend(block);
            expected += 1;
        }
        if raw.len() != size || &Sha256::digest(&raw)[..] != digest.as_slice() {
            return Err(ArchiveError::Integrity);
        }
        Ok(raw)
    }
}

fn parse(raw: &[u8]) -> Result<Message<'_>, ArchiveError> {
    if raw.len() > MAX_EML_BYTES {
        return Err(ArchiveError::TooLarge);
    }
    let message = MessageParser::default()
        .parse(raw)
        .ok_or(ArchiveError::InvalidMessage)?;
    if message.headers().is_empty() {
        return Err(ArchiveError::InvalidMessage);
    }
    Ok(message)
}

fn summary_from_row(row: &Row<'_>) -> rusqlite::Result<MailSummary> {
    let location = row
        .get::<_, Option<i64>>(10)?
        .map(|folder_id| {
            Ok::<_, rusqlite::Error>(MailLocation {
                folder_id,
                uid_validity: row.get(11)?,
                uid: row.get(12)?,
            })
        })
        .transpose()?;
    Ok(MailSummary {
        id: row.get(0)?,
        subject: row.get(1)?,
        sender: row.get(2)?,
        preview: row.get(3)?,
        sent_at: row.get(4)?,
        has_attachments: row.get(5)?,
        account_id: row.get(6)?,
        account_address: row.get(7)?,
        unread: row.get(8)?,
        flagged: row.get(9)?,
        pinned: row.get(13)?,
        location,
    })
}

fn address_line(addresses: Option<AddressList<'_>>) -> String {
    addresses
        .into_iter()
        .flat_map(|list| list.mailboxes())
        .filter_map(|mailbox| match (mailbox.name(), mailbox.address()) {
            (Some(name), Some(address)) => Some(format!("{name} <{address}>")),
            (name, address) => name.or(address).map(str::to_owned),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn reading_body(message: &Message<'_>) -> String {
    message.text_bodies().collect::<Vec<_>>().join("\n\n")
}

fn attachment_name(index: usize, name: Option<&str>) -> String {
    let clean: String = name
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .map(|character| match character {
            '/' | '\\' | ':' => '_',
            character => character,
        })
        .scan(0, |length, character| {
            *length += character.len_utf8();
            (*length <= 220).then_some(character)
        })
        .collect();
    let clean = clean.trim().trim_matches('.');
    if clean.is_empty() {
        format!("附件-{}", index + 1)
    } else {
        clean.to_owned()
    }
}

#[cfg(test)]
mod tests;
