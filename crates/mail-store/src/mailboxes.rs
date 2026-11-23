use std::collections::HashSet;

use rusqlite::{params, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::{ArchiveError, MailArchive};

pub struct DiscoveredMailbox {
    pub name: String,
    pub label: String,
    pub kind: String,
    pub delimiter: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mailbox {
    pub id: i64,
    pub account_id: i64,
    pub generation: i64,
    pub name: String,
    pub label: String,
    pub kind: String,
    pub delimiter: Option<String>,
    pub loaded: bool,
    pub has_more: bool,
    pub count: u32,
    pub unread: u32,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailLocation {
    pub folder_id: i64,
    pub uid_validity: u32,
    pub uid: u32,
}

pub struct SyncedItem {
    pub uid: u32,
    pub unread: bool,
    pub flagged: bool,
    pub raw: Option<Vec<u8>>,
}

pub struct SyncPage {
    pub uid_validity: u32,
    pub items: Vec<SyncedItem>,
    pub reconcile: Option<(u32, u32)>,
    pub has_more: bool,
}

pub enum CachedChange {
    Seen(bool),
    Flagged(bool),
    Remove,
}

const CURRENT: &str = "f.generation=coalesce((SELECT inbox_generation FROM mail_servers s WHERE s.account_id=f.account_id),0)";
const CATALOG: &str = "SELECT f.id,f.account_id,f.generation,f.name,f.label,f.kind,f.delimiter,
            f.validity IS NOT NULL,f.next_before IS NOT NULL,
            (SELECT count(DISTINCT i.message_id) FROM inbox_items i
                WHERE i.account_id=f.account_id AND i.inbox_generation=f.generation AND i.mailbox=f.name),
            (SELECT count(DISTINCT i.message_id) FROM inbox_items i
                WHERE i.account_id=f.account_id AND i.inbox_generation=f.generation AND i.mailbox=f.name
                    AND i.unread AND NOT i.local_read)
        FROM mailboxes f";

impl MailArchive {
    pub fn mailboxes(&self) -> Result<Vec<Mailbox>, ArchiveError> {
        let mut query = self.database.prepare(&format!(
            "{CATALOG} WHERE f.listed AND {CURRENT} ORDER BY f.account_id,f.label COLLATE NOCASE,f.id"
        ))?;
        let result = query
            .query_map([], mailbox_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }

    pub fn mailbox(&self, id: i64) -> Result<Mailbox, ArchiveError> {
        self.database
            .query_row(
                &format!("{CATALOG} WHERE f.id=?1 AND f.listed AND {CURRENT}"),
                [id],
                mailbox_row,
            )
            .optional()?
            .ok_or(ArchiveError::MissingMailbox)
    }

    pub fn replace_mailboxes(
        &mut self,
        account: i64,
        folders: Vec<DiscoveredMailbox>,
    ) -> Result<(), ArchiveError> {
        let tx = self
            .database
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let generation: i64 = tx.query_row(
            "SELECT coalesce((SELECT inbox_generation FROM mail_servers WHERE account_id=a.id),0)
             FROM mail_accounts a WHERE a.id=?1",
            [account],
            |row| row.get(0),
        )?;
        tx.execute(
            "UPDATE mailboxes SET listed=0 WHERE account_id=?1 AND generation=?2",
            params![account, generation],
        )?;
        for folder in folders {
            tx.execute(
                "INSERT INTO mailboxes(id,account_id,generation,name,label,kind,delimiter)
                 VALUES ((SELECT last_id + 1 FROM mail_id_watermarks WHERE kind = 'mailbox'),?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(account_id,generation,name) DO UPDATE SET
                    label=excluded.label,kind=excluded.kind,delimiter=excluded.delimiter,listed=1",
                params![
                    account,
                    generation,
                    folder.name,
                    folder.label,
                    folder.kind,
                    folder.delimiter
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn mailbox_cursor(&self, id: i64) -> Result<Option<u32>, ArchiveError> {
        Ok(self.database.query_row(
            "SELECT next_before FROM mailboxes WHERE id=?1",
            [id],
            |row| row.get(0),
        )?)
    }

    pub fn known_mailbox_items(
        &self,
        folder: &Mailbox,
    ) -> Result<HashSet<(u32, u32)>, ArchiveError> {
        let mut query = self.database.prepare(
            "SELECT uid_validity,uid FROM inbox_items
             WHERE account_id=?1 AND inbox_generation=?2 AND mailbox=?3",
        )?;
        let result = query
            .query_map(
                params![folder.account_id, folder.generation, folder.name],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?
            .collect::<Result<HashSet<_>, _>>()?;
        Ok(result)
    }

    pub fn store_mailbox(
        &mut self,
        id: i64,
        page: SyncPage,
        older: bool,
    ) -> Result<(u32, u32), ArchiveError> {
        let folder = self.mailbox(id)?;
        let tx = self
            .database
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous: (Option<u32>, Option<u32>) = tx.query_row(
            "SELECT validity,next_before FROM mailboxes WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let still_current = previous.0 == Some(page.uid_validity);
        if older && !still_current {
            return Err(ArchiveError::MissingMailboxMessage);
        }
        let newest: Option<u32> = tx.query_row(
            "SELECT max(uid) FROM inbox_items WHERE account_id=?1 AND inbox_generation=?2 AND mailbox=?3 AND uid_validity=?4",
            params![folder.account_id, folder.generation, folder.name, page.uid_validity],
            |row| row.get(0),
        )?;
        let first_on_page = page.items.iter().map(|item| item.uid).min();
        let missed_recent = page.has_more
            && first_on_page
                .zip(newest)
                .is_some_and(|(first, last)| first > last.saturating_add(1));
        let next = if older || !still_current || missed_recent || newest.is_none() || !page.has_more
        {
            first_on_page.filter(|_| page.has_more)
        } else {
            previous.1
        };
        tx.execute(
            "DELETE FROM inbox_items WHERE account_id=?1 AND inbox_generation=?2 AND mailbox=?3 AND uid_validity<>?4",
            params![folder.account_id,folder.generation,folder.name,page.uid_validity],
        )?;
        if let Some((first, last)) = page.reconcile {
            let received: HashSet<_> = page.items.iter().map(|item| item.uid).collect();
            let mut query = tx.prepare(
                "SELECT uid FROM inbox_items WHERE account_id=?1 AND inbox_generation=?2 AND mailbox=?3 AND uid_validity=?4 AND uid BETWEEN ?5 AND ?6",
            )?;
            let cached = query
                .query_map(
                    params![
                        folder.account_id,
                        folder.generation,
                        folder.name,
                        page.uid_validity,
                        first,
                        last
                    ],
                    |row| row.get::<_, u32>(0),
                )?
                .collect::<Result<Vec<_>, _>>()?;
            for uid in cached.into_iter().filter(|uid| !received.contains(uid)) {
                tx.execute(
                    "DELETE FROM inbox_items WHERE account_id=?1 AND inbox_generation=?2 AND mailbox=?3 AND uid_validity=?4 AND uid=?5",
                    params![folder.account_id,folder.generation,folder.name,page.uid_validity,uid],
                )?;
            }
        }
        let mut stored = 0;
        let mut invalid = 0;
        for item in page.items {
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
                    "INSERT INTO inbox_items(account_id,inbox_generation,mailbox,uid_validity,uid,message_id,unread,flagged)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT DO NOTHING",
                    params![folder.account_id,folder.generation,folder.name,page.uid_validity,item.uid,message_id,item.unread,item.flagged],
                )? as u32;
            }
            tx.execute(
                "UPDATE inbox_items SET unread=?6,flagged=?7,local_read=0
                 WHERE account_id=?1 AND inbox_generation=?2 AND mailbox=?3 AND uid_validity=?4 AND uid=?5",
                params![folder.account_id,folder.generation,folder.name,page.uid_validity,item.uid,item.unread,item.flagged],
            )?;
        }
        tx.execute(
            "UPDATE mailboxes SET validity=?2,next_before=?3 WHERE id=?1",
            params![id, page.uid_validity, next],
        )?;
        tx.commit()?;
        Ok((stored, invalid))
    }

    pub fn message_mailbox(&self, location: MailLocation) -> Result<Mailbox, ArchiveError> {
        let folder = self.mailbox(location.folder_id)?;
        let current: bool = self.database.query_row(
            "SELECT EXISTS(SELECT 1 FROM inbox_items i JOIN mailboxes f ON f.id=?1
             WHERE i.account_id=f.account_id AND i.inbox_generation=f.generation AND i.mailbox=f.name
               AND i.uid_validity=f.validity AND i.uid_validity=?2 AND i.uid=?3)",
            params![location.folder_id, location.uid_validity, location.uid], |row| row.get(0),
        )?;
        if !current {
            return Err(ArchiveError::MissingMailboxMessage);
        }
        Ok(folder)
    }

    pub fn apply_mailbox_change(
        &self,
        location: MailLocation,
        change: CachedChange,
    ) -> Result<(), ArchiveError> {
        let folder = self.message_mailbox(location)?;
        let where_item = "WHERE account_id=?1 AND inbox_generation=?2 AND mailbox=?3 AND uid_validity=?4 AND uid=?5";
        let keys = params![
            folder.account_id,
            folder.generation,
            folder.name,
            location.uid_validity,
            location.uid
        ];
        match change {
            CachedChange::Seen(seen) => self.database.execute(
                &format!(
                    "UPDATE inbox_items SET unread={},local_read=0 {where_item}",
                    u8::from(!seen)
                ),
                keys,
            )?,
            CachedChange::Flagged(flagged) => self.database.execute(
                &format!(
                    "UPDATE inbox_items SET flagged={} {where_item}",
                    u8::from(flagged)
                ),
                keys,
            )?,
            CachedChange::Remove => self
                .database
                .execute(&format!("DELETE FROM inbox_items {where_item}"), keys)?,
        };
        Ok(())
    }

    pub fn pin_message(
        &self,
        account: Option<i64>,
        id: i64,
        pinned: bool,
    ) -> Result<(), ArchiveError> {
        let keys = params![account.unwrap_or(0), id];
        if pinned {
            self.database.execute(
                "INSERT INTO pinned_messages VALUES (?1,?2) ON CONFLICT DO NOTHING",
                keys,
            )?;
        } else {
            self.database.execute(
                "DELETE FROM pinned_messages WHERE account_id=?1 AND message_id=?2",
                keys,
            )?;
        }
        Ok(())
    }
}

fn mailbox_row(row: &Row<'_>) -> rusqlite::Result<Mailbox> {
    Ok(Mailbox {
        id: row.get(0)?,
        account_id: row.get(1)?,
        generation: row.get(2)?,
        name: row.get(3)?,
        label: row.get(4)?,
        kind: row.get(5)?,
        delimiter: row.get(6)?,
        loaded: row.get(7)?,
        has_more: row.get(8)?,
        count: row.get(9)?,
        unread: row.get(10)?,
    })
}
