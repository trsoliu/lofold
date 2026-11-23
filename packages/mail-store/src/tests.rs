use super::*;

const SAMPLE: &[u8] = include_bytes!("../tests/fixtures/chinese-attachment.eml");
const KEY: [u8; 32] = [9; 32];

#[test]
fn reader_alert_keeps_html_chart_and_original_bytes_after_reopen() {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let raw = include_bytes!("../tests/fixtures/reader-alert.eml");
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive");
    let id = {
        let mut store = MailArchive::open(&path, &KEY).unwrap();
        store.import(raw).unwrap().id
    };
    let store = MailArchive::open(&path, &KEY).unwrap();
    let detail = store.detail(id).unwrap();
    assert_eq!(detail.summary.subject, "Synthetic capacity notification");
    let chart = detail
        .attachments
        .iter()
        .find(|file| file.name == "fixture-alert-chart.png")
        .expect("alert chart attachment");
    let exported_chart = store.export_attachment(id, chart.index).unwrap().bytes;
    let rich = serde_json::to_value(detail).unwrap();
    let html = rich["richBody"]["html"].as_str().expect("HTML body");
    assert!(html.contains("合成容量通知"));
    assert!(html.contains("<span>首次</span><span>触发：</span>"));
    assert!(html.contains("ALERT-FIXTURE-END"));
    let image = rich["richBody"]["inlineImages"]["fixture-alert-chart@lofold.test"]
        .as_str()
        .expect("CID image")
        .strip_prefix("data:image/png;base64,")
        .expect("raster data URL");
    assert_eq!(STANDARD.decode(image).unwrap(), exported_chart);
    assert_eq!(
        hex::encode(Sha256::digest(&exported_chart)),
        "f6974485df18d3a372c3b89c0cec76d3412e30966e4f8cf5e7b5326daeb39a9f"
    );
    assert_eq!(store.export_raw(id).unwrap().bytes, raw);
}

#[test]
fn ai_candidates_keep_scoped_messages_in_the_selected_account() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MailArchive::open(&directory.path().join("archive"), &KEY).unwrap();
    store
        .add_accounts(&["alpha@example.test".into(), "beta@example.test".into()])
        .unwrap();
    let accounts = store.accounts().unwrap();
    for account in &accounts {
        let raw = format!("From: fixture@example.test\r\nTo: {}\r\nSubject: Invoice review\r\n\r\nUnique body for {}", account.address, account.address);
        store
            .store_inbox(
                account.id,
                1,
                vec![InboxItem {
                    uid: 1,
                    unread: false,
                    raw: Some(raw.into_bytes()),
                }],
            )
            .unwrap();
    }
    let terms = vec!["invoice".to_owned(), "review".to_owned()];
    let matches = store.ai_matches(&terms, Some(accounts[0].id), 5).unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].0.account_id, Some(accounts[0].id));
    assert!(matches[0].1.contains(&accounts[0].address));
    assert!(!matches[0].1.contains(&accounts[1].address));
    assert_eq!(store.ai_matches(&terms, None, 5).unwrap().len(), 2);
}

#[test]
fn manual_server_changes_preserve_cached_mail_and_require_fresh_verification() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive");
    let mut store = MailArchive::open(&path, &KEY).unwrap();
    store.add_accounts(&["sample@example.test".into()]).unwrap();
    let account = store.accounts().unwrap()[0].id;
    let settings = ServerSettings {
        imap: Server {
            host: "imap.example.test".into(),
            port: 993,
            username: "reader".into(),
            start_tls: false,
        },
        smtp: Server {
            host: "smtp.example.test".into(),
            port: 587,
            username: "sender".into(),
            start_tls: true,
        },
    };
    assert!(store
        .save_server_settings(account, &settings, "first")
        .unwrap());
    store.mark_server_connected(account, Some("first")).unwrap();
    store
        .store_inbox(
            account,
            5,
            vec![InboxItem {
                uid: 8,
                unread: true,
                raw: Some(SAMPLE.to_vec()),
            }],
        )
        .unwrap();
    assert_eq!(store.known_inbox_items(account).unwrap(), [(5, 8)]);
    assert!(!store
        .save_server_settings(account, &settings, "ignored")
        .unwrap());
    assert!(store.account(account).unwrap().connected);

    let mut smtp_change = settings.clone();
    smtp_change.smtp.host = "other-smtp.example.test".into();
    assert!(store
        .save_server_settings(account, &smtp_change, "second")
        .unwrap());
    assert_eq!(store.known_inbox_items(account).unwrap(), [(5, 8)]);
    assert!(matches!(
        store.mark_server_connected(account, Some("first")),
        Err(ArchiveError::AccountChanged)
    ));

    let mut imap_change = smtp_change;
    imap_change.imap.host = "other-imap.example.test".into();
    assert!(store
        .save_server_settings(account, &imap_change, "third")
        .unwrap());
    drop(store);
    let store = MailArchive::open(&path, &KEY).unwrap();
    let saved = store.account(account).unwrap();
    assert_eq!(saved.servers, Some(imap_change));
    assert!(!saved.connected);
    assert!(store.known_inbox_items(account).unwrap().is_empty());
    assert_eq!(
        store
            .list_folder(Folder::Inbox, Some(account), "", 0)
            .unwrap()
            .items
            .len(),
        1
    );
}

#[test]
fn chinese_mime_survives_restart_and_exports_byte_for_byte() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive.sqlite3");
    let id = {
        let mut store = MailArchive::open(&path, &KEY).unwrap();
        let first = store.import(SAMPLE).unwrap();
        let duplicate = store.import(SAMPLE).unwrap();
        assert!(!first.duplicate);
        assert!(duplicate.duplicate);
        assert_eq!(first.id, duplicate.id);
        first.id
    };

    assert!(matches!(
        MailArchive::open(&path, &[8; 32]),
        Err(ArchiveError::Encryption)
    ));
    let on_disk = std::fs::read(&path).unwrap();
    assert!(!on_disk.starts_with(b"SQLite format 3\0"));
    let body = "这是一封用于核对发件身份和附件的合成测试邮件。";
    assert!(!on_disk
        .windows(body.len())
        .any(|window| window == body.as_bytes()));

    let store = MailArchive::open(&path, &KEY).unwrap();
    let detail = store.detail(id).unwrap();
    assert_eq!(detail.summary.subject, "本地邮箱往返测试");
    assert_eq!(detail.summary.sender, "sample@example.test");
    assert_eq!(detail.recipients, "archive@example.test");
    assert!(detail.body.contains(body));
    assert_eq!(detail.attachments[0].name, "差旅行程.csv");
    assert_eq!(store.export_raw(id).unwrap().bytes, SAMPLE);
    assert_eq!(
        store.export_attachment(id, 0).unwrap().bytes,
        "日期,行程\n11月20日,出发\n".as_bytes()
    );
    for query in [
        "邮箱",
        "邮箱往返",
        "差旅",
        "旅行程.csv",
        "发件身份",
        "ARCHIVE@example",
    ] {
        assert_eq!(store.list(query, 0).unwrap().items[0].id, id, "{query}");
    }
    assert!(store.list("邮箱 OR 附件", 0).unwrap().items.is_empty());
    assert!(store.list("\"邮箱\"", 0).unwrap().items.is_empty());
}

#[test]
fn malformed_files_are_rejected_and_missing_blocks_are_detected() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MailArchive::open(&directory.path().join("archive"), &KEY).unwrap();
    assert!(matches!(
        store.import(b"not a message"),
        Err(ArchiveError::InvalidMessage)
    ));
    assert!(matches!(
        store.import(&vec![0; MAX_EML_BYTES + 1]),
        Err(ArchiveError::TooLarge)
    ));
    assert!(store.list("", 0).unwrap().items.is_empty());

    let mut large = b"Subject: Multi-block fixture\r\n\r\n".to_vec();
    large.extend(std::iter::repeat_n(b'a', 2 * MAX_BLOCK_BYTES));
    let id = store.import(&large).unwrap().id;
    assert_eq!(store.export_raw(id).unwrap().bytes, large);
    assert!(store.detail(id).unwrap().body_truncated);
    store
        .database
        .execute(
            "DELETE FROM message_blocks WHERE message_id = ?1 AND ordinal = 1",
            [id],
        )
        .unwrap();
    assert!(matches!(store.export_raw(id), Err(ArchiveError::Integrity)));
}

#[test]
fn html_mail_is_converted_to_text_and_legacy_attachments_keep_wire_bytes() {
    let raw = b"Subject: HTML and attachment\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=parts\r\n\r\n--parts\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <b>archive</b></p><img src='https://example.test/pixel'>\r\n--parts\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Disposition: attachment; filename=legacy.txt\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=E9\r\n--parts--\r\n";
    let directory = tempfile::tempdir().unwrap();
    let mut store = MailArchive::open(&directory.path().join("archive"), &KEY).unwrap();
    let id = store.import(raw).unwrap().id;
    let detail = store.detail(id).unwrap();
    assert!(detail.body.contains("Hello archive"));
    assert!(!detail.body.contains("https://"));
    assert_eq!(store.export_attachment(id, 0).unwrap().bytes, b"caf\xe9");
}

#[test]
fn mailmaster_import_only_reads_valid_personal_addresses() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mail-master-fixture.db");
    let fixture = Connection::open(&path).unwrap();
    fixture
        .execute_batch(
            "CREATE TABLE Account (Email TEXT, Valid INTEGER, unrelated TEXT);
         INSERT INTO Account VALUES ('sample@163.com', 1, 'not an account setting');
         INSERT INTO Account VALUES ('disabled@qq.com', 0, 'not an account setting');
         INSERT INTO Account VALUES ('work@company.example.test', 1, 'not an account setting');
         INSERT INTO Account VALUES ('sample@GMAIL.COM', 1, 'not an account setting');",
        )
        .unwrap();
    let addresses = mailmaster_addresses(&path).unwrap();
    assert_eq!(addresses, ["sample@163.com", "sample@GMAIL.COM"]);
    let mut store = MailArchive::open(&directory.path().join("archive"), &KEY).unwrap();
    assert_eq!(store.add_accounts(&addresses).unwrap(), 2);
    assert_eq!(store.add_accounts(&addresses).unwrap(), 0);
    assert!(store
        .accounts()
        .unwrap()
        .iter()
        .all(|account| !account.connected));
}

#[test]
fn archive_upgrade_preserves_mail_and_prevents_repeat_submission() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive");
    let id = {
        let mut store = MailArchive::open(&path, &KEY).unwrap();
        let id = store.import(SAMPLE).unwrap().id;
        store
            .database
            .execute_batch(
                "DROP TABLE writing_profiles; DROP TABLE conversation_headers; DROP TABLE conversation_indexed; DROP TABLE conversation_backfill; DROP TABLE pinned_messages; DROP TABLE mailboxes; DROP TABLE saved_searches; DROP TABLE attachment_index; DROP TABLE draft_attachments; DROP TABLE drafts; DROP TABLE inbox_items; DROP TABLE mail_probes; DROP TABLE mail_servers; DROP TABLE mail_accounts; DROP TABLE mail_id_watermarks; PRAGMA user_version=1;",
            )
            .unwrap();
        id
    };
    let account = {
        let mut store = MailArchive::open(&path, &KEY).unwrap();
        assert_eq!(store.export_raw(id).unwrap().bytes, SAMPLE);
        store.add_accounts(&["sample@163.com".into()]).unwrap();
        let account = store.accounts().unwrap()[0].id;
        store.mark_account_connected(account).unwrap();
        store.begin_probe(account, "first").unwrap();
        account
    };
    let mut store = MailArchive::open(&path, &KEY).unwrap();
    assert!(matches!(
        store.begin_probe(account, "duplicate"),
        Err(ArchiveError::PendingProbe)
    ));
    store
        .finish_probe(account, "first", ProbeOutcome::Received(id))
        .unwrap();
    store
        .finish_probe(account, "first", ProbeOutcome::Accepted)
        .unwrap();
    let probe = store.account(account).unwrap().probe.unwrap();
    assert_eq!(probe.status, "received");
    assert_eq!(probe.message_id, Some(id));
    store.begin_probe(account, "second").unwrap();
}

#[test]
fn scoped_inbox_reply_and_draft_survive_reopen_before_smtp_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive");
    let mut store = MailArchive::open(&path, &KEY).unwrap();
    store
        .add_accounts(&["one@163.com".into(), "two@qq.com".into()])
        .unwrap();
    let accounts = store.accounts().unwrap();
    let (one, two) = (accounts[0].id, accounts[1].id);
    let incoming = || InboxItem {
        uid: 12,
        unread: true,
        raw: Some(SAMPLE.to_vec()),
    };
    store.store_inbox(one, 44, vec![incoming()]).unwrap();
    store.store_inbox(two, 19, vec![incoming()]).unwrap();
    assert_eq!(
        store
            .list_folder(Folder::Inbox, None, "差旅", 0)
            .unwrap()
            .items
            .len(),
        2
    );
    let page = store.list_folder(Folder::Inbox, Some(two), "", 0).unwrap();
    assert_eq!(page.items.len(), 1);
    let id = page.items[0].id;
    store.mark_inbox_read(two, id).unwrap();
    store
        .store_inbox(
            two,
            19,
            vec![InboxItem {
                uid: 12,
                unread: true,
                raw: None,
            }],
        )
        .unwrap();
    assert!(store
        .list_folder(Folder::Unread, Some(two), "", 0)
        .unwrap()
        .items
        .is_empty());
    assert_eq!(
        store
            .list_folder(Folder::Unread, Some(one), "", 0)
            .unwrap()
            .items
            .len(),
        1
    );

    let reply = store.create_draft(Some(two), Some(id)).unwrap();
    assert!(store.drafts_for_account(Some(one)).unwrap().is_empty());
    let scoped_drafts = store.drafts_for_account(Some(two)).unwrap();
    assert_eq!(scoped_drafts.len(), 1);
    assert_eq!(scoped_drafts[0].id, reply.id);
    assert_eq!(store.drafts().unwrap().len(), 1);
    assert_eq!(reply.fields.account_id, Some(two));
    assert_eq!(reply.fields.recipient, "sample@example.test");
    assert!(reply.fields.subject.starts_with("Re: "));
    let mut fields = reply.fields;
    fields.body = "你好，详见附件。".into();
    let edited = store.save_draft(reply.id, reply.revision, fields).unwrap();
    let revised = store
        .attach_draft_file(
            edited.id,
            edited.revision,
            "回复资料.txt".into(),
            b"attachment".to_vec(),
        )
        .unwrap();
    drop(store);
    let mut store = MailArchive::open(&path, &KEY).unwrap();
    let loaded = store.draft(revised.id).unwrap();
    assert_eq!(loaded.fields.body, "你好，详见附件。");
    assert_eq!(loaded.attachments.len(), 1);
    let outgoing = store.draft_for_send(loaded.id, loaded.revision).unwrap();
    assert!(outgoing.reply_id.is_some());
    assert_eq!(outgoing.files[0].1, b"attachment");
    store
        .reserve_draft_send(loaded.id, loaded.revision)
        .unwrap();
    drop(store);
    let mut store = MailArchive::open(&path, &KEY).unwrap();
    let draft = store.draft(loaded.id).unwrap();
    assert_eq!(draft.status, "uncertain");
    assert!(matches!(
        store.reserve_draft_send(draft.id, draft.revision),
        Err(ArchiveError::DraftChanged)
    ));
    store.finish_draft_send(draft.id, SAMPLE).unwrap();
    assert!(store.drafts().unwrap().is_empty());
    let sent = store.list_folder(Folder::Sent, Some(two), "", 0).unwrap();
    assert_eq!(sent.items[0].id, id);
    assert!(store
        .list_folder(Folder::Sent, Some(one), "", 0)
        .unwrap()
        .items
        .is_empty());
}

#[test]
fn existing_attachments_and_saved_searches_survive_migration_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive");
    let id = {
        let mut store = MailArchive::open(&path, &KEY).unwrap();
        let result = store.import(SAMPLE).unwrap();
        store.database.execute_batch(
            "DROP TABLE writing_profiles; ALTER TABLE drafts DROP COLUMN cc; ALTER TABLE drafts DROP COLUMN bcc; DROP INDEX draft_sent_message; DROP TABLE conversation_headers; DROP TABLE conversation_indexed; DROP TABLE conversation_backfill; DROP TABLE pinned_messages; DROP TABLE mailboxes; DROP TABLE attachment_index; DROP TABLE saved_searches; DROP TABLE mail_servers; DROP TRIGGER remember_mail_account_id; DROP TABLE mail_id_watermarks; PRAGMA user_version=3;",
        ).unwrap();
        result.id
    };
    let mut store = MailArchive::open(&path, &KEY).unwrap();
    let legacy = store.list_attachments("差旅", None, 0).unwrap();
    assert_eq!(legacy.items.len(), 1);
    assert_eq!(legacy.items[0].message_id, id);
    assert_eq!(legacy.items[0].ordinal, 0);
    assert_eq!(legacy.items[0].filename, "差旅行程.csv");
    assert!(store
        .list_attachments("行程", Some(77), 0)
        .unwrap()
        .items
        .is_empty());
    assert_eq!(
        store.export_attachment(id, 0).unwrap().bytes,
        "日期,行程\n11月20日,出发\n".as_bytes()
    );
    let stats = store.storage_status(None).unwrap();
    assert_eq!(
        (stats.messages, stats.attachments, stats.raw_bytes),
        (1, 1, SAMPLE.len() as i64)
    );
    assert!(stats.stored_block_bytes > 0);
    store
        .pin_search(SearchSpec {
            name: "附件邮件".into(),
            folder: Folder::Archive,
            account_id: None,
            query: "差旅".into(),
            attachments_only: true,
        })
        .unwrap();
    drop(store);

    let mut store = MailArchive::open(&path, &KEY).unwrap();
    let pin = store.saved_searches().unwrap().pop().unwrap();
    assert_eq!(pin.spec.query, "差旅");
    assert!(pin.spec.attachments_only);
    let hits = store
        .search_folder(
            pin.spec.folder,
            pin.spec.account_id,
            &pin.spec.query,
            pin.spec.attachments_only,
            0,
        )
        .unwrap();
    assert_eq!(hits.items[0].id, id);
    store.unpin_search(pin.id).unwrap();
    assert!(store.saved_searches().unwrap().is_empty());
    assert_eq!(store.export_raw(id).unwrap().bytes, SAMPLE);
}

#[test]
fn account_removal_preserves_local_mail_and_drafts_without_reusing_ids() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive");
    let mut store = MailArchive::open(&path, &KEY).unwrap();
    store
        .add_accounts(&["stay@example.test".into(), "remove@example.test".into()])
        .unwrap();
    let accounts = store.accounts().unwrap();
    let other = accounts[0].id;
    let removed = accounts[1].id;
    let inbox = || DiscoveredMailbox {
        name: "INBOX".into(),
        label: "收件箱".into(),
        kind: "inbox".into(),
        delimiter: None,
    };
    store.replace_mailboxes(other, vec![inbox()]).unwrap();
    store.replace_mailboxes(removed, vec![inbox()]).unwrap();
    let old_folder = store.mailboxes().unwrap()[1].id;
    store.mark_account_connected(removed).unwrap();
    store.begin_probe(removed, "removal-check").unwrap();
    store
        .store_inbox(
            removed,
            1,
            vec![InboxItem {
                uid: 1,
                unread: true,
                raw: Some(SAMPLE.to_vec()),
            }],
        )
        .unwrap();
    let message = store.list("", 0).unwrap().items[0].id;
    store.pin_message(Some(removed), message, true).unwrap();
    let draft = store.create_draft(Some(removed), None).unwrap();
    let draft = store
        .attach_draft_file(draft.id, draft.revision, "a.txt".into(), vec![7, 9])
        .unwrap();
    let uncertain = store.create_draft(Some(removed), None).unwrap();
    store
        .reserve_draft_send(uncertain.id, uncertain.revision)
        .unwrap();
    let sent = store.create_draft(Some(removed), None).unwrap();
    store.reserve_draft_send(sent.id, sent.revision).unwrap();
    assert_eq!(store.finish_draft_send(sent.id, SAMPLE).unwrap(), message);
    for (name, account_id) in [("保留", Some(other)), ("移除", Some(removed))] {
        store
            .pin_search(SearchSpec {
                name: name.into(),
                folder: Folder::Inbox,
                account_id,
                query: "差旅".into(),
                attachments_only: true,
            })
            .unwrap();
    }
    store.database.execute_batch(
        "ALTER TABLE inbox_items DROP COLUMN pending_seen; DROP TABLE writing_profiles; ALTER TABLE drafts DROP COLUMN cc; ALTER TABLE drafts DROP COLUMN bcc;
         DROP TRIGGER remember_mail_account_id; DROP TRIGGER remember_mailbox_id;
         DROP TABLE mail_id_watermarks; DROP INDEX draft_sent_message;
         DROP TABLE conversation_headers; DROP TABLE conversation_indexed; DROP TABLE conversation_backfill;
         PRAGMA user_version=6;",
    ).unwrap();
    drop(store);

    let mut store = MailArchive::open(&path, &KEY).unwrap();
    let preview = store.account_removal(removed).unwrap();
    assert_eq!((preview.drafts, preview.saved_searches), (2, 1));
    store.remove_account(removed).unwrap();
    assert!(matches!(
        store.account(removed),
        Err(ArchiveError::MissingAccount)
    ));
    assert!(matches!(
        store.mailbox(old_folder),
        Err(ArchiveError::MissingMailbox)
    ));
    assert_eq!(store.mailboxes().unwrap()[0].account_id, other);
    assert!(store
        .list_folder(Folder::Inbox, None, "", 0)
        .unwrap()
        .items
        .is_empty());
    assert_eq!(
        store.list_folder(Folder::Sent, None, "", 0).unwrap().items[0].id,
        message
    );
    assert_eq!(store.export_raw(message).unwrap().bytes, SAMPLE);
    assert_eq!(
        store.saved_searches().unwrap()[0].spec.account_id,
        Some(other)
    );
    let detached = store.draft(draft.id).unwrap();
    assert_eq!(detached.fields.account_id, None);
    assert_ne!(detached.revision, draft.revision);
    assert_eq!(detached.attachments.len(), 1);
    assert_eq!(
        store
            .draft_for_send(draft.id, detached.revision)
            .unwrap()
            .files,
        vec![("a.txt".into(), vec![7, 9])]
    );
    let pending = store.draft(uncertain.id).unwrap();
    assert_eq!(pending.status, "uncertain");
    assert!(matches!(
        store.draft_for_send(pending.id, pending.revision),
        Err(ArchiveError::DraftChanged)
    ));

    store.add_accounts(&["remove@example.test".into()]).unwrap();
    let replacement = store.accounts().unwrap().pop().unwrap();
    assert!(replacement.id > removed);
    assert!(!replacement.connected && replacement.probe.is_none());
    store
        .replace_mailboxes(replacement.id, vec![inbox()])
        .unwrap();
    assert!(store.mailboxes().unwrap()[1].id > old_folder);
}

#[test]
fn mailbox_sync_keeps_history_outside_authoritative_window_and_fences_uid_validity() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MailArchive::open(&directory.path().join("archive"), &KEY).unwrap();
    store.add_accounts(&["sample@163.com".into()]).unwrap();
    let account = store.accounts().unwrap()[0].id;
    store
        .replace_mailboxes(
            account,
            vec![
                DiscoveredMailbox {
                    name: "INBOX".into(),
                    label: "INBOX".into(),
                    kind: "inbox".into(),
                    delimiter: Some("/".into()),
                },
                DiscoveredMailbox {
                    name: "Projects".into(),
                    label: "Projects".into(),
                    kind: "custom".into(),
                    delimiter: Some("/".into()),
                },
            ],
        )
        .unwrap();
    let boxes = store.mailboxes().unwrap();
    let inbox = boxes
        .iter()
        .find(|folder| folder.kind == "inbox")
        .unwrap()
        .id;
    let project = boxes
        .iter()
        .find(|folder| folder.kind == "custom")
        .unwrap()
        .id;
    let make = |uid, raw| SyncedItem {
        uid,
        unread: true,
        flagged: true,
        raw,
    };
    store
        .store_mailbox(
            inbox,
            SyncPage {
                uid_validity: 7,
                items: vec![
                    make(3, Some(SAMPLE.to_vec())),
                    make(12, Some(SAMPLE.to_vec())),
                ],
                reconcile: Some((1, 12)),
                has_more: true,
            },
            false,
        )
        .unwrap();
    let message = store
        .list_folder(Folder::Flagged, Some(account), "", 0)
        .unwrap()
        .items
        .remove(0);
    let remote = message.location.unwrap();
    assert_eq!((remote.uid_validity, remote.uid), (7, 12));
    assert_eq!(store.mailbox_cursor(inbox).unwrap(), Some(3));
    store
        .apply_mailbox_change(remote, CachedChange::Seen(true))
        .unwrap();
    assert_eq!(store.mailbox(inbox).unwrap().unread, 1);
    store
        .store_mailbox(
            inbox,
            SyncPage {
                uid_validity: 7,
                items: vec![],
                reconcile: Some((10, 20)),
                has_more: false,
            },
            false,
        )
        .unwrap();
    let inbox_folder = store.mailbox(inbox).unwrap();
    assert_eq!(
        store.known_mailbox_items(&inbox_folder).unwrap(),
        [(7, 3)].into_iter().collect()
    );
    assert!(store.message_mailbox(remote).is_err());
    assert_eq!(store.export_raw(message.id).unwrap().bytes, SAMPLE);
    store
        .store_mailbox(
            project,
            SyncPage {
                uid_validity: 8,
                items: vec![make(4, Some(SAMPLE.to_vec()))],
                reconcile: Some((1, 5)),
                has_more: false,
            },
            false,
        )
        .unwrap();
    let listed = store
        .search_mailboxes(Folder::Remote, Some(account), "", false, 0, Some(project))
        .unwrap();
    assert_eq!(listed.items[0].location.unwrap().folder_id, project);
    store.pin_message(Some(account), message.id, true).unwrap();
    assert!(
        store
            .search_mailboxes(Folder::Remote, Some(account), "", false, 0, Some(project))
            .unwrap()
            .items[0]
            .pinned
    );
    store
        .store_mailbox(
            project,
            SyncPage {
                uid_validity: 9,
                items: vec![],
                reconcile: Some((1, 10)),
                has_more: false,
            },
            false,
        )
        .unwrap();
    assert!(store
        .message_mailbox(listed.items[0].location.unwrap())
        .is_err());
    assert_eq!(store.export_raw(message.id).unwrap().bytes, SAMPLE);
}

#[test]
fn watermark_accounts_use_mail_links_and_ignore_message_headers() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MailArchive::open(&directory.path().join("archive"), &KEY).unwrap();
    store
        .add_accounts(&["first@example.test".into(), "second@example.test".into()])
        .unwrap();
    let accounts = store.accounts().unwrap();
    let first = accounts[0].id;
    let second = accounts[1].id;
    let raw = b"From: first@example.test\r\nTo: second@example.test\r\nSubject: Local test\r\n\r\nbody\r\n";
    let message = store.import(raw).unwrap().id;
    assert!(store.linked_mail_accounts(message).unwrap().is_empty());
    for id in [second, first] {
        store
            .store_inbox(
                id,
                1,
                vec![InboxItem {
                    uid: 1,
                    unread: true,
                    raw: Some(raw.to_vec()),
                }],
            )
            .unwrap();
    }
    assert_eq!(
        store.linked_mail_accounts(message).unwrap(),
        [first, second]
    );
    store.remove_account(second).unwrap();
    assert_eq!(store.linked_mail_accounts(message).unwrap(), [first]);
}

#[test]
fn opened_read_is_local_until_confirmed_and_bound_to_the_original_location() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive");
    let mut store = MailArchive::open(&path, &KEY).unwrap();
    store
        .add_accounts(&["first@example.test".into(), "second@example.test".into()])
        .unwrap();
    let accounts = store.accounts().unwrap();
    for account in &accounts {
        store
            .replace_mailboxes(
                account.id,
                ["INBOX", "Projects"]
                    .map(|name| DiscoveredMailbox {
                        name: name.into(),
                        label: name.into(),
                        kind: if name == "INBOX" { "inbox" } else { "custom" }.into(),
                        delimiter: None,
                    })
                    .into(),
            )
            .unwrap();
    }
    let boxes = store.mailboxes().unwrap();
    let first = accounts[0].id;
    let inbox = boxes
        .iter()
        .find(|folder| folder.account_id == first && folder.name == "INBOX")
        .unwrap()
        .id;
    let page = |uid_validity, unread, raw| SyncPage {
        uid_validity,
        items: vec![SyncedItem {
            uid: 12,
            unread,
            flagged: false,
            raw,
        }],
        reconcile: None,
        has_more: false,
    };
    for folder in &boxes {
        store
            .store_mailbox(folder.id, page(7, true, Some(SAMPLE.to_vec())), false)
            .unwrap();
    }
    let message = store
        .list_folder(Folder::Inbox, Some(first), "", 0)
        .unwrap()
        .items
        .remove(0);
    let location = message.location.unwrap();
    assert!(store
        .mark_opened_read(accounts[1].id, message.id, location)
        .is_err());
    assert!(store
        .mark_opened_read(first, message.id + 1, location)
        .is_err());
    // Simulate a v10 archive: earlier local-only reads must never become IMAP writes.
    store.mark_inbox_read(accounts[1].id, message.id).unwrap();
    store
        .database
        .execute_batch("ALTER TABLE inbox_items DROP COLUMN pending_seen; PRAGMA user_version=10;")
        .unwrap();
    drop(store);
    let mut store = MailArchive::open(&path, &KEY).unwrap();
    assert!(boxes
        .iter()
        .all(|f| store.pending_seen(f.id, None).unwrap().is_empty()));
    store.mark_opened_read(first, message.id, location).unwrap();
    store.mark_opened_read(first, message.id, location).unwrap();
    store
        .store_mailbox(inbox, page(7, true, None), false)
        .unwrap();
    drop(store);
    let mut store = MailArchive::open(&path, &KEY).unwrap();
    assert_eq!(store.mailbox(inbox).unwrap().unread, 0);
    assert!(
        !store
            .list_folder(Folder::Inbox, Some(first), "", 0)
            .unwrap()
            .items[0]
            .unread
    );
    let unread = store
        .list_folder(Folder::Unread, Some(first), "", 0)
        .unwrap();
    assert_eq!(unread.items.len(), 1);
    let other = unread.items[0].location.unwrap();
    assert_ne!(other.folder_id, inbox);
    assert_eq!(store.mailbox(other.folder_id).unwrap().unread, 1);
    assert_eq!(store.pending_seen(inbox, None).unwrap().len(), 1);
    assert!(boxes
        .iter()
        .filter(|f| f.id != inbox)
        .all(|f| store.pending_seen(f.id, None).unwrap().is_empty()));
    assert!(store.cancel_pending_seen(location).unwrap());
    assert!(!store.cancel_pending_seen(location).unwrap());
    store.mark_opened_read(first, message.id, location).unwrap();
    store
        .apply_mailbox_change(location, CachedChange::Seen(false))
        .unwrap();
    assert_eq!(store.mailbox(inbox).unwrap().unread, 1);
    assert!(store.pending_seen(inbox, None).unwrap().is_empty());
    store.mark_opened_read(first, message.id, location).unwrap();
    store
        .store_mailbox(inbox, page(7, false, None), false)
        .unwrap();
    assert!(store.pending_seen(inbox, None).unwrap().is_empty());
    store
        .store_mailbox(inbox, page(7, true, None), false)
        .unwrap();
    assert_eq!(store.mailbox(inbox).unwrap().unread, 1);
    store.mark_opened_read(first, message.id, location).unwrap();
    store
        .store_mailbox(inbox, page(8, true, Some(SAMPLE.to_vec())), false)
        .unwrap();
    assert!(store.mark_opened_read(first, message.id, location).is_err());
    assert!(store.pending_seen(inbox, None).unwrap().is_empty());
    assert_eq!(store.mailbox(inbox).unwrap().unread, 1);
}
