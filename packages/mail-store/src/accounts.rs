use std::path::Path;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::{ArchiveError, MailArchive};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAccount {
    pub id: i64,
    pub address: String,
    pub connected: bool,
    pub probe: Option<MailProbe>,
    pub servers: Option<ServerSettings>,
    #[serde(skip)]
    pub server_revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub start_tls: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct ServerSettings {
    pub imap: Server,
    pub smtp: Server,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailProbe {
    pub token: String,
    pub status: String,
    pub message_id: Option<i64>,
}

pub enum ProbeOutcome {
    Accepted,
    Rejected,
    Received(i64),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRemoval {
    pub drafts: u32,
    pub saved_searches: u32,
}

/// Read the account-address column only, using the MailMaster macOS 4.17 layout.
pub fn mailmaster_addresses(path: &Path) -> Result<Vec<String>, ArchiveError> {
    let db = Connection::open_with_flags(
        path.canonicalize()?,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    db.pragma_update(None, "trusted_schema", false)?;
    let account_table = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'Account' AND type = 'table')",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if !account_table {
        return Err(ArchiveError::MailMaster);
    }
    let mut select = db.prepare(
        "SELECT DISTINCT trim(Email) COLLATE NOCASE FROM Account
         WHERE Valid = 1
           AND lower(substr(trim(Email), instr(trim(Email), '@') + 1))
               IN ('163.com', 'qq.com', 'gmail.com')
         ORDER BY 1 LIMIT 100",
    )?;
    let addresses = select
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(addresses)
}

impl MailArchive {
    pub fn add_accounts(&mut self, addresses: &[String]) -> Result<u32, ArchiveError> {
        let tx = self
            .database
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut added = 0;
        for address in addresses {
            added += tx.execute(
                "INSERT INTO mail_accounts (id, address)
                 VALUES ((SELECT last_id + 1 FROM mail_id_watermarks WHERE kind = 'account'), ?1)
                 ON CONFLICT(address) DO NOTHING",
                [address],
            )? as u32;
        }
        tx.commit()?;
        Ok(added)
    }

    pub fn accounts(&self) -> Result<Vec<MailAccount>, ArchiveError> {
        let mut select = self.database.prepare(
            "SELECT a.id, a.address, a.connected, p.token, p.status, p.message_id, s.settings, s.revision
             FROM mail_accounts a LEFT JOIN mail_probes p ON p.account_id = a.id
             LEFT JOIN mail_servers s ON s.account_id = a.id ORDER BY a.id",
        )?;
        let accounts = select
            .query_map([], account_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(accounts)
    }

    pub fn account(&self, id: i64) -> Result<MailAccount, ArchiveError> {
        self.database
            .query_row(
                "SELECT a.id, a.address, a.connected, p.token, p.status, p.message_id, s.settings, s.revision
                 FROM mail_accounts a LEFT JOIN mail_probes p ON p.account_id = a.id
                 LEFT JOIN mail_servers s ON s.account_id = a.id WHERE a.id = ?1",
                [id],
                account_row,
            )
            .optional()?
            .ok_or(ArchiveError::MissingAccount)
    }

    pub fn linked_mail_accounts(&self, message: i64) -> Result<Vec<i64>, ArchiveError> {
        let mut statement = self.database.prepare(
            "SELECT a.id FROM mail_accounts a WHERE
               EXISTS(SELECT 1 FROM inbox_items i WHERE i.account_id=a.id AND i.message_id=?1)
               OR EXISTS(SELECT 1 FROM drafts d WHERE d.account_id=a.id AND d.sent_message_id=?1 AND d.status='sent')
               OR EXISTS(SELECT 1 FROM mail_probes p WHERE p.account_id=a.id AND p.message_id=?1 AND p.status='received')
             ORDER BY a.id",
        )?;
        let ids = statement
            .query_map([message], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    pub fn account_removal(&self, id: i64) -> Result<AccountRemoval, ArchiveError> {
        self.database
            .query_row(
                "SELECT
                     (SELECT count(*) FROM drafts WHERE account_id = ?1 AND status != 'sent'),
                     (SELECT count(*) FROM saved_searches WHERE account_id = ?1)
                 FROM mail_accounts WHERE id = ?1",
                [id],
                |row| {
                    Ok(AccountRemoval {
                        drafts: row.get(0)?,
                        saved_searches: row.get(1)?,
                    })
                },
            )
            .optional()?
            .ok_or(ArchiveError::MissingAccount)
    }

    pub fn remove_account(&mut self, id: i64) -> Result<(), ArchiveError> {
        let tx = self
            .database
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        // The archive already exposes the original EMLs. Only remove their account bindings.
        tx.execute("DELETE FROM inbox_items WHERE account_id = ?1", [id])?;
        tx.execute("DELETE FROM mailboxes WHERE account_id = ?1", [id])?;
        tx.execute("DELETE FROM pinned_messages WHERE account_id = ?1", [id])?;
        tx.execute("DELETE FROM saved_searches WHERE account_id = ?1", [id])?;
        tx.execute(
            "UPDATE drafts SET account_id = NULL, revision = revision + 1 WHERE account_id = ?1",
            [id],
        )?;
        if tx.execute("DELETE FROM mail_accounts WHERE id = ?1", [id])? != 1 {
            return Err(ArchiveError::MissingAccount);
        }
        tx.commit()?;
        Ok(())
    }

    pub fn mark_account_connected(&mut self, id: i64) -> Result<(), ArchiveError> {
        self.mark_server_connected(id, None)
    }

    pub fn mark_server_connected(
        &mut self,
        id: i64,
        revision: Option<&str>,
    ) -> Result<(), ArchiveError> {
        if self.database.execute(
            "UPDATE mail_accounts SET connected = 1 WHERE id = ?1
                 AND (SELECT revision FROM mail_servers WHERE account_id = ?1) IS ?2",
            params![id, revision],
        )? != 1
        {
            return Err(ArchiveError::AccountChanged);
        }
        Ok(())
    }

    pub fn save_server_settings(
        &mut self,
        id: i64,
        settings: &ServerSettings,
        revision: &str,
    ) -> Result<bool, ArchiveError> {
        let tx = self
            .database
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = tx.query_row(
            "SELECT s.settings FROM mail_accounts a LEFT JOIN mail_servers s ON s.account_id = a.id WHERE a.id = ?1",
            [id], |row| row.get::<_, Option<String>>(0),
        ).optional()?.ok_or(ArchiveError::MissingAccount)?;
        let previous = current
            .as_deref()
            .map(serde_json::from_str::<ServerSettings>)
            .transpose()
            .map_err(|_| ArchiveError::ServerSettings)?;
        if previous.as_ref() == Some(settings) {
            return Ok(false);
        }
        let changed_inbox = previous
            .as_ref()
            .is_none_or(|previous| previous.imap != settings.imap);
        let encoded = serde_json::to_string(settings).map_err(|_| ArchiveError::ServerSettings)?;
        tx.execute(
            "INSERT INTO mail_servers (account_id, settings, revision) VALUES (?1, ?2, ?3)
             ON CONFLICT(account_id) DO UPDATE SET settings=?2, revision=?3,
             inbox_generation=inbox_generation+?4",
            params![id, encoded, revision, changed_inbox],
        )?;
        tx.execute("UPDATE mail_accounts SET connected=0 WHERE id=?1", [id])?;
        tx.execute("DELETE FROM mail_probes WHERE account_id=?1", [id])?;
        tx.commit()?;
        Ok(true)
    }

    pub fn begin_probe(&mut self, id: i64, token: &str) -> Result<(), ArchiveError> {
        let changed = self.database.execute(
            "INSERT INTO mail_probes (account_id, token, status)
             VALUES (?1, ?2, 'uncertain')
             ON CONFLICT(account_id) DO UPDATE
             SET token = excluded.token, status = excluded.status, message_id = NULL
             WHERE mail_probes.status IN ('received', 'rejected')",
            params![id, token],
        )?;
        if changed != 1 {
            return Err(ArchiveError::PendingProbe);
        }
        Ok(())
    }

    pub fn finish_probe(
        &mut self,
        id: i64,
        token: &str,
        result: ProbeOutcome,
    ) -> Result<(), ArchiveError> {
        let (status, message, permitted) = match result {
            ProbeOutcome::Accepted => ("accepted", None, "uncertain"),
            ProbeOutcome::Rejected => ("rejected", None, "uncertain"),
            ProbeOutcome::Received(message) => ("received", Some(message), "accepted"),
        };
        self.database.execute(
            "UPDATE mail_probes SET status = ?3, message_id = ?4
             WHERE account_id = ?1 AND token = ?2 AND (status = ?5 OR status = 'uncertain')",
            params![id, token, status, message, permitted],
        )?;
        Ok(())
    }
}

fn account_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MailAccount> {
    let token: Option<String> = row.get(3)?;
    let encoded: Option<String> = row.get(6)?;
    let servers = encoded
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    Ok(MailAccount {
        id: row.get(0)?,
        address: row.get(1)?,
        connected: row.get(2)?,
        servers,
        server_revision: row.get(7)?,
        probe: match token {
            Some(token) => Some(MailProbe {
                token,
                status: row.get(4)?,
                message_id: row.get(5)?,
            }),
            None => None,
        },
    })
}
