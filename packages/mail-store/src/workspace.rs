use std::collections::HashSet;

use rusqlite::{params, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::{ArchiveError, MailArchive, Transaction};

pub const MAX_DRAFT_FILES_BYTES: usize = 8 * 1024 * 1024;
const MAX_DRAFT_FILES: usize = 12;
const MAX_DRAFT_BODY_BYTES: usize = 512 * 1024;
const MAX_REPLY_RECIPIENTS: usize = 20;

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ComposeMode {
    #[default]
    Reply,
    ReplyAll,
    Forward,
    ForwardAsAttachment,
    EditServerDraft,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Folder {
    Archive,
    Inbox,
    Unread,
    Sent,
    Flagged,
    Junk,
    Trash,
    Remote,
    #[serde(skip)]
    AccountMail,
}

pub struct InboxItem {
    pub uid: u32,
    pub unread: bool,
    pub raw: Option<Vec<u8>>,
}

#[derive(Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DraftFields {
    pub account_id: Option<i64>,
    pub recipient: String,
    #[serde(default)]
    pub cc: String,
    #[serde(default)]
    pub bcc: String,
    pub subject: String,
    pub body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: i64,
    pub revision: i64,
    pub fields: DraftFields,
    pub status: String,
    pub changed_at: i64,
    pub attachments: Vec<DraftAttachment>,
}

#[derive(Serialize)]
pub struct DraftAttachment {
    id: i64,
    name: String,
    size: u32,
}

pub struct DraftPayload {
    pub reply_id: Option<String>,
    pub files: Vec<(String, Vec<u8>)>,
    pub fields: DraftFields,
}

impl MailArchive {
    pub fn known_inbox_items(&self, account_id: i64) -> Result<Vec<(u32, u32)>, ArchiveError> {
        let mut statement = self.database.prepare(
            "SELECT uid_validity, uid FROM inbox_items WHERE account_id = ?1 AND mailbox='INBOX'
             AND inbox_generation = coalesce((SELECT inbox_generation FROM mail_servers WHERE account_id = ?1), 0)
             ORDER BY uid_validity DESC, uid DESC LIMIT 500",
        )?;
        let result = statement
            .query_map([account_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }

    pub fn store_inbox(
        &mut self,
        account_id: i64,
        validity: u32,
        items: Vec<InboxItem>,
    ) -> Result<(u32, u32), ArchiveError> {
        let tx = self
            .database
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut stored = 0;
        let mut invalid = 0;
        let generation: i64 = tx.query_row(
            "SELECT coalesce((SELECT inbox_generation FROM mail_servers WHERE account_id = ?1), 0)",
            [account_id],
            |row| row.get(0),
        )?;
        for item in items {
            if let Some(raw) = item.raw {
                let message_id = match Self::import_transaction(&tx, &raw) {
                    Ok(result) => result.id,
                    Err(ArchiveError::InvalidMessage | ArchiveError::TooLarge) => {
                        invalid += 1;
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                stored += tx.execute(
                    "INSERT INTO inbox_items (account_id, uid_validity, uid, message_id, unread, inbox_generation, local_read)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                       EXISTS(SELECT 1 FROM inbox_items WHERE account_id=?1 AND message_id=?4 AND local_read=1))
                     ON CONFLICT DO NOTHING",
                    params![account_id, validity, item.uid, message_id, item.unread, generation],
                )? as u32;
            }
            tx.execute(
                "UPDATE inbox_items SET unread = ?4
                 WHERE account_id = ?1 AND uid_validity = ?2 AND uid = ?3 AND inbox_generation = ?5 AND mailbox='INBOX'",
                params![account_id, validity, item.uid, item.unread, generation],
            )?;
        }
        tx.commit()?;
        Ok((stored, invalid))
    }

    pub fn mark_inbox_read(&self, account: i64, id: i64) -> Result<(), ArchiveError> {
        self.database.execute(
            "UPDATE inbox_items SET local_read=1 WHERE account_id=?1 AND message_id=?2 AND mailbox='INBOX'",
            params![account, id],
        )?;
        Ok(())
    }

    pub fn create_draft(
        &mut self,
        account_id: Option<i64>,
        reply: Option<i64>,
    ) -> Result<Draft, ArchiveError> {
        if let Some(id) = reply {
            return self.create_draft_from_message(account_id, id, ComposeMode::Reply);
        }
        self.create_draft_with_fields(DraftFields {
            account_id,
            ..DraftFields::default()
        })
    }

    pub fn create_draft_with_fields(&mut self, fields: DraftFields) -> Result<Draft, ArchiveError> {
        self.insert_draft(DraftPayload {
            fields,
            reply_id: None,
            files: Vec::new(),
        })
    }

    pub fn create_draft_from_message(
        &mut self,
        account_id: Option<i64>,
        id: i64,
        mode: ComposeMode,
    ) -> Result<Draft, ArchiveError> {
        if let (ComposeMode::Reply | ComposeMode::ReplyAll, Some(account)) = (mode, account_id) {
            let linked: bool = self.database.query_row(
                "SELECT EXISTS(SELECT 1 FROM inbox_items WHERE account_id=?1 AND message_id=?2)",
                params![account, id],
                |row| row.get(0),
            )?;
            if !linked {
                return Err(ArchiveError::MissingMessage);
            }
        }

        if matches!(mode, ComposeMode::EditServerDraft) {
            let account = account_id.ok_or(ArchiveError::MissingAccount)?;
            let linked: bool = self.database.query_row(
                "SELECT EXISTS(SELECT 1 FROM inbox_items i
                   JOIN mailboxes f ON f.account_id=i.account_id AND f.generation=i.inbox_generation AND f.name=i.mailbox
                   WHERE i.account_id=?1 AND i.message_id=?2 AND f.listed AND f.kind='drafts'
                     AND i.uid_validity=f.validity
                     AND f.generation=coalesce((SELECT inbox_generation FROM mail_servers WHERE account_id=?1),0))",
                params![account, id],
                |row| row.get(0),
            )?;
            if !linked {
                return Err(ArchiveError::MissingMailboxMessage);
            }
        }

        let original = self.export_raw(id)?;
        let message = crate::parse(&original.bytes)?;
        let original_subject = message.subject().unwrap_or_default();
        let mut payload = DraftPayload {
            fields: DraftFields {
                account_id,
                ..DraftFields::default()
            },
            reply_id: None,
            files: Vec::new(),
        };
        let fields = &mut payload.fields;
        match mode {
            ComposeMode::Reply | ComposeMode::ReplyAll => {
                if matches!(mode, ComposeMode::ReplyAll) {
                    (fields.recipient, fields.cc) =
                        reply_all_recipients(&message, self.accounts()?)?;
                } else {
                    fields.recipient = message
                        .reply_to()
                        .or_else(|| message.from())
                        .and_then(|list| list.first())
                        .and_then(|address| address.address())
                        .filter(|address| valid_prefilled_recipient(address))
                        .ok_or(ArchiveError::InvalidReply)?
                        .to_owned();
                }
                fields.subject = subject_with_prefix(original_subject, "Re:");
                payload.reply_id = message.message_id().map(str::to_owned);
            }
            ComposeMode::Forward => {
                fields.subject = subject_with_prefix(original_subject, "Fwd:");
                fields.body = forwarded_body(&message);
                payload.files = draft_attachments_from_message(&message)?;
            }
            ComposeMode::ForwardAsAttachment => {
                fields.subject = subject_with_prefix(original_subject, "Fwd:");
                payload.files.push((original.filename, original.bytes));
            }
            ComposeMode::EditServerDraft => {
                let mut seen = HashSet::new();
                fields.recipient = visible_recipients([message.to()], &mut seen)
                    .ok_or(ArchiveError::InvalidDraftRecipients)?
                    .join(", ");
                fields.cc = visible_recipients([message.cc()], &mut seen)
                    .ok_or(ArchiveError::InvalidDraftRecipients)?
                    .join(", ");
                fields.subject = original_subject.to_owned();
                fields.body = crate::reading_body(&message);
                payload.reply_id = message
                    .in_reply_to()
                    .and_then(|ids| ids.first())
                    .map(str::to_owned);
                payload.files = draft_attachments_from_message(&message)?;
            }
        }
        self.insert_draft(payload)
    }

    fn insert_draft(&mut self, payload: DraftPayload) -> Result<Draft, ArchiveError> {
        let DraftPayload {
            fields,
            reply_id,
            files,
        } = payload;
        validate_fields(&fields)?;
        if files.len() > MAX_DRAFT_FILES
            || files.iter().map(|(_, bytes)| bytes.len()).sum::<usize>() > MAX_DRAFT_FILES_BYTES
        {
            return Err(ArchiveError::DraftAttachmentsLimit);
        }
        let tx = self
            .database
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        // A discarded SQLite row ID can be reused. Keep old optimistic locks from matching it.
        tx.execute(
            "INSERT INTO drafts (account_id, recipient, subject, body, reply_id, cc, bcc, revision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1 + (random() & ((1 << 52) - 1)))",
            params![
                fields.account_id,
                fields.recipient,
                fields.subject,
                fields.body,
                reply_id,
                fields.cc,
                fields.bcc,
            ],
        )?;
        let id = tx.last_insert_rowid();
        for (name, bytes) in files {
            tx.execute(
                "INSERT INTO draft_attachments (draft_id, name, payload) VALUES (?1, ?2, ?3)",
                params![id, name, bytes],
            )?;
        }
        tx.commit()?;
        self.draft(id)
    }

    pub fn draft(&self, id: i64) -> Result<Draft, ArchiveError> {
        let mut draft = self
            .database
            .query_row(
                "SELECT id, revision, account_id, recipient, subject, body, status, changed_at, cc, bcc
             FROM drafts WHERE id = ?1 AND status != 'sent'",
                [id],
                draft_row,
            )
            .optional()?
            .ok_or(ArchiveError::MissingDraft)?;
        draft.attachments = self.draft_attachments(id)?;
        Ok(draft)
    }

    pub fn drafts(&self) -> Result<Vec<Draft>, ArchiveError> {
        self.drafts_for_account(None)
    }

    pub fn drafts_for_account(&self, account_id: Option<i64>) -> Result<Vec<Draft>, ArchiveError> {
        let mut statement = self.database.prepare(
            "SELECT id, revision, account_id, recipient, subject, '', status, changed_at, '', ''
             FROM drafts WHERE status != 'sent' AND (?1 IS NULL OR account_id = ?1)
             ORDER BY changed_at DESC, id DESC",
        )?;
        let result = statement
            .query_map([account_id], draft_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }

    pub fn save_draft(
        &mut self,
        id: i64,
        revision: i64,
        fields: DraftFields,
    ) -> Result<Draft, ArchiveError> {
        validate_fields(&fields)?;
        let result = self.database.execute(
            "UPDATE drafts
             SET account_id=?3, recipient=?4, subject=?5, body=?6, cc=?7, bcc=?8, revision=revision+1, changed_at=unixepoch()
             WHERE id=?1 AND revision=?2 AND status IN ('editing','rejected')",
            params![id, revision, fields.account_id, fields.recipient, fields.subject, fields.body, fields.cc, fields.bcc],
        )?;
        if result != 1 {
            return Err(ArchiveError::DraftChanged);
        }
        self.draft(id)
    }

    pub fn discard_draft(&mut self, id: i64, revision: i64) -> Result<(), ArchiveError> {
        let deleted = self.database.execute(
            "DELETE FROM drafts WHERE id=?1 AND revision=?2 AND status IN ('editing','rejected')",
            params![id, revision],
        )?;
        if deleted != 1 {
            return Err(ArchiveError::DraftChanged);
        }
        Ok(())
    }

    pub fn attach_draft_file(
        &mut self,
        id: i64,
        revision: i64,
        name: String,
        payload: Vec<u8>,
    ) -> Result<Draft, ArchiveError> {
        let name = crate::attachment_name(0, Some(&name));
        let tx = self
            .database
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        touch_draft(&tx, id, revision)?;
        let (count, size): (u32, u32) = tx.query_row(
            "SELECT count(*), coalesce(sum(length(payload)),0) FROM draft_attachments WHERE draft_id=?1",
            [id], |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if count as usize >= MAX_DRAFT_FILES
            || size as usize + payload.len() > MAX_DRAFT_FILES_BYTES
        {
            return Err(ArchiveError::DraftAttachmentsLimit);
        }
        tx.execute(
            "INSERT INTO draft_attachments (draft_id, name, payload) VALUES (?1, ?2, ?3)",
            params![id, name, payload],
        )?;
        tx.commit()?;
        self.draft(id)
    }

    pub fn remove_draft_file(
        &mut self,
        id: i64,
        revision: i64,
        file: i64,
    ) -> Result<Draft, ArchiveError> {
        let tx = self
            .database
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        touch_draft(&tx, id, revision)?;
        if tx.execute(
            "DELETE FROM draft_attachments WHERE draft_id=?1 AND id=?2",
            params![id, file],
        )? != 1
        {
            return Err(ArchiveError::MissingAttachment);
        }
        tx.commit()?;
        self.draft(id)
    }

    pub fn draft_for_send(&self, id: i64, revision: i64) -> Result<DraftPayload, ArchiveError> {
        let (fields, reply_id) = self
            .database
            .query_row(
                "SELECT account_id, recipient, subject, body, reply_id, cc, bcc FROM drafts
             WHERE id=?1 AND revision=?2 AND status IN ('editing','rejected')",
                params![id, revision],
                |row| {
                    Ok((
                        DraftFields {
                            account_id: row.get(0)?,
                            recipient: row.get(1)?,
                            subject: row.get(2)?,
                            body: row.get(3)?,
                            cc: row.get(5)?,
                            bcc: row.get(6)?,
                        },
                        row.get(4)?,
                    ))
                },
            )
            .optional()?
            .ok_or(ArchiveError::DraftChanged)?;
        let mut statement = self
            .database
            .prepare("SELECT name, payload FROM draft_attachments WHERE draft_id=?1 ORDER BY id")?;
        let files = statement
            .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(DraftPayload {
            fields,
            reply_id,
            files,
        })
    }

    pub fn reserve_draft_send(&mut self, id: i64, revision: i64) -> Result<(), ArchiveError> {
        let changed = self.database.execute(
            "UPDATE drafts SET status='uncertain', revision=revision+1, changed_at=unixepoch()
             WHERE id=?1 AND revision=?2 AND status IN ('editing','rejected')",
            params![id, revision],
        )?;
        if changed != 1 {
            return Err(ArchiveError::DraftChanged);
        }
        Ok(())
    }

    pub fn reject_draft_send(&mut self, id: i64) -> Result<(), ArchiveError> {
        self.database.execute(
            "UPDATE drafts SET status='rejected' WHERE id=?1 AND status='uncertain'",
            [id],
        )?;
        Ok(())
    }

    pub fn finish_draft_send(&mut self, id: i64, raw: &[u8]) -> Result<i64, ArchiveError> {
        let tx = self
            .database
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let message_id = Self::import_transaction(&tx, raw)?.id;
        if tx.execute(
            "UPDATE drafts SET status='sent', sent_message_id=?2, changed_at=unixepoch()
             WHERE id=?1 AND status='uncertain'",
            params![id, message_id],
        )? != 1
        {
            return Err(ArchiveError::DraftChanged);
        }
        tx.execute("DELETE FROM draft_attachments WHERE draft_id=?1", [id])?;
        tx.commit()?;
        Ok(message_id)
    }

    fn draft_attachments(&self, id: i64) -> Result<Vec<DraftAttachment>, ArchiveError> {
        let mut statement = self.database.prepare(
            "SELECT id, name, length(payload) FROM draft_attachments WHERE draft_id=?1 ORDER BY id",
        )?;
        let result = statement
            .query_map([id], |row| {
                Ok(DraftAttachment {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    size: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }
}

fn draft_row(row: &Row<'_>) -> rusqlite::Result<Draft> {
    Ok(Draft {
        id: row.get(0)?,
        revision: row.get(1)?,
        fields: DraftFields {
            account_id: row.get(2)?,
            recipient: row.get(3)?,
            subject: row.get(4)?,
            body: row.get(5)?,
            cc: row.get(8)?,
            bcc: row.get(9)?,
        },
        status: row.get(6)?,
        changed_at: row.get(7)?,
        attachments: Vec::new(),
    })
}

pub(crate) fn valid_prefilled_recipient(address: &str) -> bool {
    address.len() <= 254
        && !address.contains([',', ';', '，', '；'])
        && !address.chars().any(char::is_control)
        && address.parse::<lettre::Address>().is_ok()
}

fn reply_all_recipients(
    message: &mail_parser::Message<'_>,
    accounts: Vec<crate::MailAccount>,
) -> Result<(String, String), ArchiveError> {
    let mut seen = accounts
        .into_iter()
        .map(|account| account.address.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let to = visible_recipients(
        [message.reply_to().or_else(|| message.from()), message.to()],
        &mut seen,
    )
    .ok_or(ArchiveError::InvalidReplyRecipients)?;
    let cc = visible_recipients([message.cc()], &mut seen)
        .ok_or(ArchiveError::InvalidReplyRecipients)?;
    let count = to.len() + cc.len();
    if count == 0 {
        return Err(ArchiveError::InvalidReply);
    }
    if count > MAX_REPLY_RECIPIENTS {
        return Err(ArchiveError::InvalidReplyRecipients);
    }
    Ok((to.join(", "), cc.join(", ")))
}

fn visible_recipients<'a, const N: usize>(
    headers: [Option<mail_parser::AddressList<'a>>; N],
    seen: &mut HashSet<String>,
) -> Option<Vec<&'a str>> {
    let mut recipients = Vec::new();
    for mailbox in headers
        .into_iter()
        .flatten()
        .flat_map(|list| list.mailboxes())
    {
        let address = mailbox
            .address()
            .filter(|address| valid_prefilled_recipient(address))?;
        if seen.insert(address.to_ascii_lowercase()) {
            recipients.push(address);
        }
    }
    Some(recipients)
}

fn subject_with_prefix(subject: &str, prefix: &str) -> String {
    if subject
        .get(..prefix.len())
        .is_some_and(|part| part.eq_ignore_ascii_case(prefix))
    {
        subject.to_owned()
    } else {
        format!("{prefix} {subject}")
    }
}

fn forwarded_body(message: &mail_parser::Message<'_>) -> String {
    let sender = crate::address_line(message.from());
    let date = message
        .date()
        .map(|date| date.to_rfc822())
        .unwrap_or_default();
    let subject = message.subject().unwrap_or_default();
    let to = crate::address_line(message.to());
    let cc = crate::address_line(message.cc());
    let body = crate::reading_body(message);
    let mut quote = String::from("\n\n---------- 转发邮件 ----------\n");
    for (label, value) in [
        ("发件人", sender.as_str()),
        ("日期", date.as_str()),
        ("主题", subject),
        ("收件人", to.as_str()),
        ("抄送", cc.as_str()),
    ] {
        if !value.is_empty() {
            quote.push_str(&format!("{label}：{value}\n"));
        }
    }
    quote.push('\n');
    quote.push_str(&body);
    quote
}

fn draft_attachments_from_message(
    message: &mail_parser::Message<'_>,
) -> Result<Vec<(String, Vec<u8>)>, ArchiveError> {
    let mut files = Vec::new();
    let mut remaining = MAX_DRAFT_FILES_BYTES;
    for (index, part) in message.attachments().enumerate() {
        if index >= MAX_DRAFT_FILES || part.decoded_len() > remaining {
            return Err(ArchiveError::DraftAttachmentsLimit);
        }
        let (bytes, problems) = part.decoded_checked();
        if !problems.is_empty() {
            return Err(ArchiveError::AttachmentEncoding);
        }
        remaining = remaining
            .checked_sub(bytes.len())
            .ok_or(ArchiveError::DraftAttachmentsLimit)?;
        let name = crate::attachment_name(index, part.attachment_name());
        files.push((name, bytes.into_owned()));
    }
    Ok(files)
}

fn validate_fields(fields: &DraftFields) -> Result<(), ArchiveError> {
    if [fields.recipient.len(), fields.cc.len(), fields.bcc.len()]
        .into_iter()
        .any(|length| length > 2000)
        || fields.subject.len() > 1600
        || fields.body.len() > MAX_DRAFT_BODY_BYTES
    {
        return Err(ArchiveError::DraftTooLarge);
    }
    Ok(())
}

fn touch_draft(tx: &Transaction<'_>, id: i64, revision: i64) -> Result<(), ArchiveError> {
    if tx.execute(
        "UPDATE drafts SET revision=revision+1, changed_at=unixepoch()
         WHERE id=?1 AND revision=?2 AND status IN ('editing','rejected')",
        params![id, revision],
    )? != 1
    {
        return Err(ArchiveError::DraftChanged);
    }
    Ok(())
}

#[cfg(test)]
mod compose_tests {
    use super::*;

    const MESSAGE: &[u8] = b"From: Sender <sender@example.test>\r\n\
Reply-To: reply@example.test\r\n\
To: ME@example.test, Other <other@example.test>\r\n\
Cc: Team: alias@example.test, THIRD@example.test, OTHER@example.test;\r\n\
Bcc: private@example.test\r\n\
Message-ID: <previous@example.test>\r\n\
Subject: Project update\r\n\
Date: Mon, 23 Nov 2026 09:00:00 +0800\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=example-part\r\n\
\r\n\
--example-part\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<p>Latest status</p>\r\n\
--example-part\r\n\
Content-Type: application/octet-stream\r\n\
Content-Disposition: attachment; filename=\"some/file.txt\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
aGVsbG8=\r\n\
--example-part--\r\n";

    fn fixture() -> (tempfile::TempDir, MailArchive, i64) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = MailArchive::open(&dir.path().join("archive"), &[17; 32]).unwrap();
        store
            .add_accounts(&["me@example.test".into(), "alias@example.test".into()])
            .unwrap();
        let account = store.accounts().unwrap()[0].id;
        (dir, store, account)
    }

    #[test]
    fn reply_all_only_targets_visible_non_self_recipients_once() {
        let (_dir, mut store, account) = fixture();
        let id = store.import(MESSAGE).unwrap().id;
        assert!(matches!(
            store.create_draft_from_message(Some(account), id, ComposeMode::ReplyAll),
            Err(ArchiveError::MissingMessage)
        ));
        store
            .store_inbox(
                account,
                10,
                vec![InboxItem {
                    uid: 2,
                    unread: true,
                    raw: Some(MESSAGE.to_vec()),
                }],
            )
            .unwrap();

        let ordinary = store.create_draft(Some(account), Some(id)).unwrap();
        assert_eq!(ordinary.fields.recipient, "reply@example.test");
        let reply = store
            .create_draft_from_message(Some(account), id, ComposeMode::ReplyAll)
            .unwrap();
        assert_eq!(
            reply.fields.recipient,
            "reply@example.test, other@example.test"
        );
        assert_eq!(reply.fields.cc, "THIRD@example.test");
        assert!(reply.fields.bcc.is_empty());
        assert_eq!(reply.fields.subject, "Re: Project update");
        let payload = store.draft_for_send(reply.id, reply.revision).unwrap();
        assert_eq!(payload.reply_id.as_deref(), Some("previous@example.test"));
        assert!(payload.files.is_empty());
    }

    #[test]
    fn reply_all_rejects_an_invalid_or_oversized_recipient_list_without_creating_a_draft() {
        let (_dir, mut store, _) = fixture();
        let too_many = (0..MAX_REPLY_RECIPIENTS)
            .map(|index| format!("friend{index}@example.test"))
            .collect::<Vec<_>>()
            .join(", ");
        for recipients in ["\"a;b\"@example.test".to_owned(), too_many] {
            let raw = format!(
                "From: sender@example.test\r\nTo: {recipients}\r\nSubject: Example\r\n\r\nBody\r\n"
            );
            let id = store.import(raw.as_bytes()).unwrap().id;
            let result = store.create_draft_from_message(None, id, ComposeMode::ReplyAll);
            assert!(
                matches!(result, Err(ArchiveError::InvalidReplyRecipients)),
                "unexpected result for {recipients}: {:?}",
                result.map(|draft| draft.fields.recipient)
            );
        }
        assert!(!valid_prefilled_recipient("\"a,b\"@example.test"));
        assert!(store.drafts().unwrap().is_empty());
    }

    #[test]
    fn forwards_start_without_recipients_and_keep_plaintext_or_exact_original() {
        let (dir, mut store, account) = fixture();
        let id = store.import(MESSAGE).unwrap().id;
        let inline = store
            .create_draft_from_message(Some(account), id, ComposeMode::Forward)
            .unwrap();
        let attached = store
            .create_draft_from_message(Some(account), id, ComposeMode::ForwardAsAttachment)
            .unwrap();
        assert!(inline.fields.recipient.is_empty() && attached.fields.recipient.is_empty());
        assert_eq!(inline.fields.subject, "Fwd: Project update");
        assert_eq!(attached.fields.subject, inline.fields.subject);
        assert!(inline.fields.body.contains("Latest status"));
        assert!(inline.fields.body.contains("Sender <sender@example.test>"));
        assert!(
            !inline.fields.body.contains("<p>")
                && !inline.fields.body.contains("private@example.test")
        );
        assert!(attached.fields.body.is_empty());
        drop(store);

        let store = MailArchive::open(&dir.path().join("archive"), &[17; 32]).unwrap();
        let inline = store.draft_for_send(inline.id, inline.revision).unwrap();
        let attached = store
            .draft_for_send(attached.id, attached.revision)
            .unwrap();
        assert!(inline.reply_id.is_none() && attached.reply_id.is_none());
        assert_eq!(inline.files, [("some_file.txt".into(), b"hello".to_vec())]);
        assert_eq!(
            attached.files,
            [(format!("LoFold-{id}.eml"), MESSAGE.to_vec())]
        );
    }

    #[test]
    fn server_drafts_create_local_copies_for_the_current_account() {
        use crate::{DiscoveredMailbox, SyncPage, SyncedItem};

        let (_dir, mut store, account) = fixture();
        let wrong_account = store.accounts().unwrap()[1].id;
        let empty = b"From: me@example.test\r\nBcc: private@example.test\r\nSubject:\r\n\r\nStarted writing\r\n";
        let id = store.import(MESSAGE).unwrap().id;
        let empty_id = store.import(empty).unwrap().id;
        assert!(matches!(
            store.create_draft_from_message(Some(account), id, ComposeMode::EditServerDraft),
            Err(ArchiveError::MissingMailboxMessage)
        ));

        store
            .replace_mailboxes(
                account,
                vec![DiscoveredMailbox {
                    name: "Drafts".to_owned(),
                    label: "Drafts".to_owned(),
                    kind: "drafts".to_owned(),
                    delimiter: None,
                }],
            )
            .unwrap();
        let folder = store.mailboxes().unwrap()[0].id;
        store
            .store_mailbox(
                folder,
                SyncPage {
                    uid_validity: 29,
                    items: [MESSAGE, empty]
                        .into_iter()
                        .enumerate()
                        .map(|(index, raw)| SyncedItem {
                            uid: 3 + index as u32,
                            unread: false,
                            flagged: false,
                            raw: Some(raw.to_vec()),
                        })
                        .collect(),
                    reconcile: None,
                    has_more: false,
                },
                false,
            )
            .unwrap();

        assert!(matches!(
            store.create_draft_from_message(Some(wrong_account), id, ComposeMode::EditServerDraft),
            Err(ArchiveError::MissingMailboxMessage)
        ));
        let copy = store
            .create_draft_from_message(Some(account), id, ComposeMode::EditServerDraft)
            .unwrap();
        assert_eq!(copy.fields.account_id, Some(account));
        assert_eq!(copy.fields.subject, "Project update");
        assert_eq!(copy.fields.recipient, "ME@example.test, other@example.test");
        assert_eq!(copy.fields.cc, "alias@example.test, THIRD@example.test");
        assert!(copy.fields.bcc.is_empty());
        assert!(copy.fields.body.contains("Latest status"));
        assert_eq!(
            store.draft_for_send(copy.id, copy.revision).unwrap().files,
            [("some_file.txt".into(), b"hello".to_vec())]
        );
        store.discard_draft(copy.id, copy.revision).unwrap();
        let empty_copy = store
            .create_draft_from_message(Some(account), empty_id, ComposeMode::EditServerDraft)
            .unwrap();
        assert!(empty_copy.fields.recipient.is_empty() && empty_copy.fields.subject.is_empty());
        assert!(empty_copy.fields.body.contains("Started writing"));
        assert_eq!(store.mailbox(folder).unwrap().count, 2);
        assert_eq!(store.export_raw(id).unwrap().bytes, MESSAGE);
    }

    #[test]
    fn cc_and_bcc_survive_reopening_the_encrypted_draft() {
        let (dir, mut store, account) = fixture();
        let draft = store.create_draft(Some(account), None).unwrap();
        assert!(draft.fields.cc.is_empty() && draft.fields.bcc.is_empty());
        let mut fields = draft.fields;
        fields.cc = "copy@example.test".into();
        fields.bcc = "private@example.test".into();
        let saved = store.save_draft(draft.id, draft.revision, fields).unwrap();
        drop(store);
        let store = MailArchive::open(&dir.path().join("archive"), &[17; 32]).unwrap();
        let saved = store.draft(saved.id).unwrap();
        assert_eq!(saved.fields.cc, "copy@example.test");
        assert_eq!(saved.fields.bcc, "private@example.test");
        let payload = store.draft_for_send(saved.id, saved.revision).unwrap();
        assert_eq!(payload.fields.cc, saved.fields.cc);
        assert_eq!(payload.fields.bcc, saved.fields.bcc);
    }

    #[test]
    fn oversized_eml_forward_leaves_no_partial_draft() {
        let (_dir, mut store, account) = fixture();
        let mut original = b"From: sender@example.test\r\nSubject: Large source\r\n\r\n".to_vec();
        original.resize(MAX_DRAFT_FILES_BYTES + 1, b'x');
        let id = store.import(&original).unwrap().id;
        assert!(matches!(
            store.create_draft_from_message(Some(account), id, ComposeMode::ForwardAsAttachment),
            Err(ArchiveError::DraftAttachmentsLimit)
        ));
        assert!(store.drafts().unwrap().is_empty());
        let attachment_count: u32 = store
            .database
            .query_row("SELECT count(*) FROM draft_attachments", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(attachment_count, 0);
    }

    #[test]
    fn discard_removes_attachments_and_preserves_in_flight_or_sent_drafts() {
        let (_dir, mut store, account) = fixture();
        let id = store.import(MESSAGE).unwrap().id;
        let old = store
            .create_draft_from_message(Some(account), id, ComposeMode::ForwardAsAttachment)
            .unwrap();
        store.discard_draft(old.id, old.revision).unwrap();
        assert!(matches!(
            store.draft(old.id),
            Err(ArchiveError::MissingDraft)
        ));
        let attachment_count: u32 = store
            .database
            .query_row("SELECT count(*) FROM draft_attachments", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(attachment_count, 0);
        let current = store.create_draft(Some(account), None).unwrap();
        assert!(matches!(
            store.discard_draft(old.id, old.revision),
            Err(ArchiveError::DraftChanged)
        ));
        store
            .reserve_draft_send(current.id, current.revision)
            .unwrap();
        let uncertain = store.draft(current.id).unwrap();
        assert!(matches!(
            store.discard_draft(uncertain.id, uncertain.revision),
            Err(ArchiveError::DraftChanged)
        ));
        store.finish_draft_send(uncertain.id, MESSAGE).unwrap();
        assert!(matches!(
            store.discard_draft(uncertain.id, uncertain.revision),
            Err(ArchiveError::DraftChanged)
        ));
    }
}
