use mail_parser::{Message, MessageParser};
use rusqlite::{params, Transaction, TransactionBehavior};
use serde::Serialize;

use super::{summary_from_row, ArchiveError, MailArchive, MailSummary};

const BACKFILL_MESSAGES: u32 = 32;
const BACKFILL_BYTES: u32 = 8 * 1024 * 1024;
const MAX_REFERENCE_IDS: usize = 128;
const MEMBER_LIMIT: usize = 40;
const GRAPH_LIMIT: u32 = 2048;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    items: Vec<MailSummary>,
    has_more: bool,
    indexing_pending: bool,
}

const IN_ACCOUNT: &str = "
    EXISTS(SELECT 1 FROM inbox_items i WHERE i.account_id=?2 AND i.message_id=m.id)
    OR EXISTS(SELECT 1 FROM drafts d WHERE d.account_id=?2 AND d.sent_message_id=m.id AND d.status='sent')";

impl MailArchive {
    pub(super) fn index_conversation_headers(
        tx: &Transaction<'_>,
        id: i64,
        message: &Message<'_>,
    ) -> Result<(), ArchiveError> {
        insert_headers(tx, id, &header_ids(message))
    }

    pub fn conversation(
        &mut self,
        id: i64,
        account: Option<i64>,
    ) -> Result<Conversation, ArchiveError> {
        let exists = self.database.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM messages m WHERE m.id=?1 AND (?2 IS NULL OR {IN_ACCOUNT}))"),
            params![id, account],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            return Err(ArchiveError::MissingMessage);
        }
        let indexing_pending = self.backfill_conversations(id)?;
        let mut statement = self.database.prepare(&format!(
            "WITH RECURSIVE nodes(message_id, header_id) AS (
                SELECT ?1, NULL
                UNION
                SELECT NULL, h.header_id FROM nodes n
                    JOIN conversation_headers h ON h.message_id=n.message_id
                UNION
                SELECT h.message_id, NULL FROM nodes n
                    JOIN conversation_headers h ON h.header_id=n.header_id
                    JOIN messages m ON m.id=h.message_id
                    WHERE ?2 IS NULL OR {IN_ACCOUNT}
                LIMIT ?3
             ),
             recent AS (
                SELECT m.* FROM nodes n JOIN messages m ON m.id=n.message_id
                ORDER BY (m.id=?1) DESC, m.sent_at DESC NULLS LAST, m.id DESC LIMIT ?4
             ),
             locations AS (
                SELECT i.message_id,(i.unread AND NOT i.local_read) AS unread,i.flagged,
                    f.id AS folder_id,i.uid_validity,i.uid,
                    row_number() OVER (PARTITION BY i.message_id ORDER BY
                        f.id IS NOT NULL DESC, i.inbox_generation DESC, i.mailbox='INBOX' DESC,
                        i.unread DESC, i.mailbox, i.uid_validity DESC, i.uid DESC) AS ordinal
                FROM recent r JOIN inbox_items i ON i.message_id=r.id AND i.account_id=?2
                LEFT JOIN mailboxes f ON f.account_id=i.account_id AND f.generation=i.inbox_generation
                    AND f.name=i.mailbox AND f.listed AND f.validity=i.uid_validity
                    AND f.generation=coalesce((SELECT inbox_generation FROM mail_servers WHERE account_id=?2),0)
             )
             SELECT r.id,r.subject,r.sender,r.preview,r.sent_at,r.has_attachments,
                    a.id,a.address,coalesce(l.unread,0),coalesce(l.flagged,0),
                    l.folder_id,l.uid_validity,l.uid,p.message_id IS NOT NULL,
                    (SELECT count(*) FROM nodes)=?3
             FROM recent r LEFT JOIN locations l ON l.message_id=r.id AND l.ordinal=1
             LEFT JOIN mail_accounts a ON a.id=?2
             LEFT JOIN pinned_messages p ON p.account_id=coalesce(?2,0) AND p.message_id=r.id
             ORDER BY r.sent_at DESC NULLS LAST,r.id DESC"
        ))?;
        let mut rows =
            statement.query(params![id, account, GRAPH_LIMIT, MEMBER_LIMIT as u32 + 1])?;
        let mut items = Vec::new();
        let mut has_more = false;
        while let Some(row) = rows.next()? {
            has_more |= row.get::<_, bool>(14)?;
            items.push(summary_from_row(row)?);
        }
        if items.len() > MEMBER_LIMIT {
            has_more = true;
            if let Some(extra) = items.iter().rposition(|item| item.id != id) {
                items.remove(extra);
            }
        }
        Ok(Conversation {
            items,
            has_more,
            indexing_pending,
        })
    }

    fn backfill_conversations(&mut self, anchor: i64) -> Result<bool, ArchiveError> {
        let (last, target): (i64, i64) = self.database.query_row(
            "SELECT last_id,target_id FROM conversation_backfill WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if last >= target {
            return Ok(false);
        }
        let indexed = self.database.query_row(
            "SELECT EXISTS(SELECT 1 FROM conversation_indexed WHERE message_id=?1)",
            [anchor],
            |row| row.get::<_, bool>(0),
        )?;
        let mut indexed_headers = Vec::new();
        if !indexed {
            indexed_headers.push((anchor, self.read_conversation_headers(anchor)?));
        }

        let batch = {
            let mut statement = self.database.prepare(
                "SELECT m.id,m.raw_size,i.message_id IS NOT NULL
                 FROM messages m LEFT JOIN conversation_indexed i ON i.message_id=m.id
                 WHERE m.id>?1 AND m.id<=?2
                 ORDER BY m.id LIMIT ?3",
            )?;
            let rows = statement.query_map(params![last, target, BACKFILL_MESSAGES], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let mut cursor = last;
        let mut bytes = 0;
        for (id, size, indexed) in batch {
            if !indexed && id != anchor {
                if bytes > 0 && bytes + size > BACKFILL_BYTES {
                    break;
                }
                indexed_headers.push((id, self.read_conversation_headers(id)?));
                bytes += size;
            }
            cursor = id;
        }
        if cursor == last {
            cursor = target;
        }
        let tx = self
            .database
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (id, identifiers) in indexed_headers {
            insert_headers(&tx, id, &identifiers)?;
        }
        let (cursor, target): (i64, i64) = tx.query_row(
            "UPDATE conversation_backfill SET last_id=max(last_id,?1) WHERE id=1 RETURNING last_id,target_id",
            [cursor],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        tx.commit()?;
        Ok(cursor < target)
    }

    fn read_conversation_headers(&self, id: i64) -> Result<Vec<String>, ArchiveError> {
        let raw = self.read_raw(id)?;
        let message = MessageParser::new()
            .parse_headers(&raw)
            .ok_or(ArchiveError::InvalidMessage)?;
        Ok(header_ids(&message))
    }
}

fn header_ids(message: &Message<'_>) -> Vec<String> {
    let in_reply_to = message.in_reply_to();
    let references = message.references();
    let identifiers = message
        .message_id()
        .into_iter()
        .chain(
            in_reply_to
                .iter()
                .flat_map(|ids| ids.iter().take(MAX_REFERENCE_IDS)),
        )
        .chain(references.iter().flat_map(|ids| {
            ids.first()
                .into_iter()
                .chain(ids.iter().rev().take(MAX_REFERENCE_IDS - 1))
        }));
    let mut identifiers: Vec<_> = identifiers
        .filter_map(|id| {
            let id = id.trim();
            let (name, domain) = id.rsplit_once('@')?;
            (id.len() <= 998
                && !name.is_empty()
                && !domain.is_empty()
                && !id.bytes().any(|byte| {
                    byte.is_ascii_whitespace()
                        || byte.is_ascii_control()
                        || matches!(byte, b'<' | b'>')
                }))
            .then(|| id.to_owned())
        })
        .collect();
    identifiers.sort_unstable();
    identifiers.dedup();
    identifiers
}

fn insert_headers(
    tx: &Transaction<'_>,
    id: i64,
    identifiers: &[String],
) -> Result<(), ArchiveError> {
    let mut insert =
        tx.prepare_cached("INSERT OR IGNORE INTO conversation_headers VALUES (?1,?2)")?;
    for identifier in identifiers {
        insert.execute(params![id, identifier])?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO conversation_indexed VALUES (?1)",
        [id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::InboxItem;

    fn message(id: &str, related: &str) -> Vec<u8> {
        format!(
            "From: sample@example.test\r\nSubject: Same subject\r\nMessage-ID: <{id}@example.test>\r\n{related}\r\nA fixture."
        )
        .into_bytes()
    }

    #[test]
    fn conversation_finds_transitive_links_and_keeps_account_scope() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = MailArchive::open(&directory.path().join("archive"), &[25; 32]).unwrap();
        store
            .add_accounts(&["a@example.test".into(), "b@example.test".into()])
            .unwrap();
        let accounts = store.accounts().unwrap();
        let first = accounts[0].id;
        let second = accounts[1].id;
        let root = message("root", "");
        let reply = message("reply", "References: <root@example.test>\r\n");
        let follow_up = message("follow-up", "In-Reply-To: <reply@example.test>\r\n");
        let other = message("other-account", "References: <root@example.test>\r\n");
        let unrelated = message("unrelated", "");

        for (account, messages) in [
            (first, vec![&root, &follow_up, &reply]),
            (second, vec![&other]),
        ] {
            let items = messages
                .into_iter()
                .enumerate()
                .map(|(uid, raw)| InboxItem {
                    uid: uid as u32 + 1,
                    unread: true,
                    raw: Some(raw.to_owned()),
                })
                .collect();
            store.store_inbox(account, 1, items).unwrap();
        }
        let root = store.import(&root).unwrap().id;
        let reply = store.import(&reply).unwrap().id;
        let follow_up = store.import(&follow_up).unwrap().id;
        let other = store.import(&other).unwrap().id;
        store.import(&unrelated).unwrap();
        let scoped = store.conversation(follow_up, Some(first)).unwrap();
        assert!(!scoped.has_more);
        assert!(!scoped.indexing_pending);
        assert!(scoped
            .items
            .iter()
            .all(|item| item.account_id == Some(first) && item.unread));
        assert_eq!(
            scoped.items.iter().map(|item| item.id).collect::<Vec<_>>(),
            [reply, follow_up, root]
        );
        assert!(matches!(
            store.conversation(other, Some(first)),
            Err(ArchiveError::MissingMessage)
        ));
        let archive = store.conversation(root, None).unwrap();
        assert_eq!(
            archive.items.iter().map(|item| item.id).collect::<Vec<_>>(),
            [other, reply, follow_up, root]
        );
    }

    #[test]
    fn conversation_backfills_legacy_headers_in_bounded_batches() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = MailArchive::open(&directory.path().join("archive"), &[25; 32]).unwrap();
        let root = store.import(&message("root", "")).unwrap().id;
        for n in 0..BACKFILL_MESSAGES {
            store.import(&message(&n.to_string(), "")).unwrap();
        }
        let reply = store
            .import(&message("reply", "In-Reply-To: <root@example.test>\r\n"))
            .unwrap()
            .id;
        store
            .database
            .execute_batch(
                "DELETE FROM conversation_headers;
             DELETE FROM conversation_indexed;
             UPDATE conversation_backfill SET target_id=(SELECT max(id) FROM messages);",
            )
            .unwrap();

        let partial = store.conversation(reply, None).unwrap();
        assert!(partial.indexing_pending);
        assert_eq!(
            partial.items.iter().map(|item| item.id).collect::<Vec<_>>(),
            [reply, root]
        );
        let complete = store.conversation(reply, None).unwrap();
        assert!(!complete.indexing_pending);
        assert_eq!(complete.items.len(), 2);
    }
}
