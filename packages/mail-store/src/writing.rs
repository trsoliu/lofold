use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::{workspace::valid_prefilled_recipient, ArchiveError, MailArchive};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WritingTone {
    #[default]
    Default,
    Formal,
    Friendly,
    Direct,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WritingLength {
    #[default]
    Default,
    Brief,
    Detailed,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct WritingMemory {
    pub id: String,
    pub text: String,
    pub recipient: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritingProfile {
    pub display_name: String,
    pub role: String,
    pub signature: String,
    pub tone: WritingTone,
    pub length: WritingLength,
    pub memories: Vec<WritingMemory>,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct WritingRecord {
    pub revision: i64,
    pub profile: WritingProfile,
}

impl WritingProfile {
    fn validate(&mut self) -> Result<(), ArchiveError> {
        use ArchiveError::InvalidWritingProfile;
        if self.display_name.chars().count() > 80
            || self.role.chars().count() > 160
            || self.signature.chars().count() > 400
        {
            return Err(InvalidWritingProfile(
                "称呼、身份和签名分别最多支持 80、160 和 400 个字符。",
            ));
        }
        if self.memories.len() > 24 {
            return Err(InvalidWritingProfile("每份写作资料最多保留 24 条记忆。"));
        }
        let mut ids = HashSet::new();
        for memory in &mut self.memories {
            if memory.id.is_empty()
                || memory.id.len() > 64
                || !memory
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                || !ids.insert(&memory.id)
            {
                return Err(InvalidWritingProfile("写作记忆标识无效或重复。"));
            }
            if memory.text.trim().is_empty() || memory.text.chars().count() > 300 {
                return Err(InvalidWritingProfile("每条写作记忆需要 1 至 300 个字符。"));
            }
            let recipient = memory.recipient.trim();
            if !recipient.is_empty() && !valid_prefilled_recipient(recipient) {
                return Err(InvalidWritingProfile(
                    "请填写单个收件邮箱地址，或留空用于所有收件人。",
                ));
            }
            memory.recipient = recipient.to_owned();
        }
        Ok(())
    }
}

impl MailArchive {
    pub fn read_writing_profile(
        &self,
        account_id: Option<i64>,
    ) -> Result<WritingRecord, ArchiveError> {
        read_profile(&self.database, account_id)
    }

    pub fn save_writing_profile(
        &mut self,
        account_id: Option<i64>,
        revision: i64,
        mut profile: WritingProfile,
    ) -> Result<WritingRecord, ArchiveError> {
        profile.validate()?;
        let tx = self
            .database
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = read_profile(&tx, account_id)?;
        if previous.revision != revision {
            return Err(ArchiveError::WritingProfileChanged);
        }
        if previous.profile == profile {
            return Ok(previous);
        }
        let encoded = serde_json::to_string(&profile)
            .map_err(|_| ArchiveError::InvalidWritingProfile("无法保存写作资料。"))?;
        let revision = revision
            .checked_add(1)
            .ok_or(ArchiveError::InvalidWritingProfile("写作资料版本无效。"))?;
        tx.execute(
            "INSERT INTO writing_profiles(account_id, revision, profile) VALUES (?1, ?2, ?3)
             ON CONFLICT DO UPDATE SET revision=excluded.revision, profile=excluded.profile",
            params![account_id, revision, encoded],
        )?;
        tx.commit()?;
        Ok(WritingRecord { revision, profile })
    }
}

fn read_profile(db: &Connection, account_id: Option<i64>) -> Result<WritingRecord, ArchiveError> {
    // Join against a valid scope so a removed account cannot be mistaken for a fresh profile.
    let (revision, encoded): (i64, Option<String>) = db.query_row(
        "SELECT coalesce(w.revision, 0), w.profile FROM (SELECT ?1 AS account_id) s
         LEFT JOIN writing_profiles w ON coalesce(w.account_id, 0)=coalesce(s.account_id, 0)
         WHERE s.account_id IS NULL OR EXISTS(SELECT 1 FROM mail_accounts a WHERE a.id=s.account_id)",
        [account_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?.ok_or(ArchiveError::MissingAccount)?;
    let profile = match encoded {
        Some(encoded) => serde_json::from_str(&encoded)
            .map_err(|_| ArchiveError::InvalidWritingProfile("无法读取已保存的写作资料。"))?,
        None => WritingProfile::default(),
    };
    Ok(WritingRecord { revision, profile })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> WritingProfile {
        WritingProfile {
            display_name: "演示".into(),
            role: "译者".into(),
            tone: WritingTone::Friendly,
            length: WritingLength::Brief,
            signature: "祝好，\n演示".into(),
            memories: vec![WritingMemory {
                id: "memo-1".into(),
                text: "附上术语表。".into(),
                recipient: "demo@example.test".into(),
            }],
        }
    }

    #[test]
    fn writing_upgrade_preserves_eml_and_profiles_survive_reopen_in_their_own_scope() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("archive");
        let key = [7; 32];
        let eml = b"Subject: Writing fixture\r\nFrom: demo@example.test\r\n\r\nExample";
        let mut db = MailArchive::open(&path, &key).unwrap();
        let id = db.import(eml).unwrap().id;
        db.add_accounts(&["first@example.test".into(), "second@example.test".into()])
            .unwrap();
        let account = db.accounts().unwrap()[0].id;
        let other = db.accounts().unwrap()[1].id;
        db.database
            .execute_batch("ALTER TABLE inbox_items DROP COLUMN pending_seen; DROP TABLE writing_profiles; PRAGMA user_version=9;")
            .unwrap();
        drop(db);

        let mut db = MailArchive::open(&path, &key).unwrap();
        assert_eq!(db.export_raw(id).unwrap().bytes, eml);
        assert_eq!(
            db.read_writing_profile(Some(account)).unwrap(),
            WritingRecord::default()
        );
        let saved = db.save_writing_profile(Some(account), 0, sample()).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(
            db.read_writing_profile(None).unwrap(),
            WritingRecord::default()
        );
        let generic = WritingProfile {
            display_name: "通用".into(),
            ..Default::default()
        };
        db.save_writing_profile(None, 0, generic.clone()).unwrap();
        assert_eq!(
            db.read_writing_profile(Some(other)).unwrap(),
            WritingRecord::default()
        );
        drop(db);

        assert!(MailArchive::open(&path, &[8; 32]).is_err());
        let mut db = MailArchive::open(&path, &key).unwrap();
        assert_eq!(db.read_writing_profile(Some(account)).unwrap(), saved);
        db.remove_account(account).unwrap();
        assert!(matches!(
            db.save_writing_profile(Some(account), saved.revision, sample()),
            Err(ArchiveError::MissingAccount)
        ));
        let row_count: i64 = db
            .database
            .query_row(
                "SELECT count(*) FROM writing_profiles WHERE account_id IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(row_count, 0);
        db.add_accounts(&["first@example.test".into()]).unwrap();
        let new_id = db.accounts().unwrap().last().unwrap().id;
        assert_ne!(account, new_id);
        assert_eq!(
            db.read_writing_profile(Some(new_id)).unwrap(),
            WritingRecord::default()
        );
        assert_eq!(db.read_writing_profile(None).unwrap().profile, generic);
    }

    #[test]
    fn writing_stale_updates_and_invalid_memories_leave_the_latest_profile_intact() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("archive");
        let mut first = MailArchive::open(&path, &[9; 32]).unwrap();
        let mut other = MailArchive::open(&path, &[9; 32]).unwrap();
        let stale = other.read_writing_profile(None).unwrap();
        let mut profile = sample();
        profile.memories[0].recipient = "  demo@example.test  ".into();
        let saved = first.save_writing_profile(None, 0, profile).unwrap();
        assert_eq!(saved.profile, sample());
        assert!(matches!(
            other.save_writing_profile(None, stale.revision, stale.profile),
            Err(ArchiveError::WritingProfileChanged)
        ));
        let memory = sample().memories.pop().unwrap();
        for bad in [
            WritingProfile {
                memories: vec![memory.clone(); 2],
                ..sample()
            },
            WritingProfile {
                signature: "中".repeat(401),
                ..sample()
            },
            WritingProfile {
                memories: vec![WritingMemory {
                    recipient: "a@example.test,b@example.test".into(),
                    ..memory.clone()
                }],
                ..sample()
            },
            WritingProfile {
                memories: vec![WritingMemory {
                    text: " ".into(),
                    ..memory.clone()
                }],
                ..sample()
            },
        ] {
            assert!(matches!(
                other.save_writing_profile(None, saved.revision, bad),
                Err(ArchiveError::InvalidWritingProfile(_))
            ));
        }
        assert_eq!(other.read_writing_profile(None).unwrap(), saved);
        let cleared = first
            .save_writing_profile(None, saved.revision, WritingProfile::default())
            .unwrap();
        assert_eq!(cleared.revision, 2);
        assert_eq!(other.read_writing_profile(None).unwrap(), cleared);
        assert!(matches!(
            other.save_writing_profile(None, 0, sample()),
            Err(ArchiveError::WritingProfileChanged)
        ));
    }
}
