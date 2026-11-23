CREATE TABLE IF NOT EXISTS mail_id_watermarks (
    kind TEXT PRIMARY KEY,
    last_id INTEGER NOT NULL
) WITHOUT ROWID;

INSERT OR IGNORE INTO mail_id_watermarks SELECT 'account', coalesce(max(id), 0) FROM mail_accounts;
INSERT OR IGNORE INTO mail_id_watermarks SELECT 'mailbox', coalesce(max(id), 0) FROM mailboxes;

-- A stale account or folder ID must never select a different mailbox after removal.
CREATE TRIGGER IF NOT EXISTS remember_mail_account_id AFTER INSERT ON mail_accounts
BEGIN
    UPDATE mail_id_watermarks SET last_id = max(last_id, NEW.id) WHERE kind = 'account';
END;

CREATE TRIGGER IF NOT EXISTS remember_mailbox_id AFTER INSERT ON mailboxes
BEGIN
    UPDATE mail_id_watermarks SET last_id = max(last_id, NEW.id) WHERE kind = 'mailbox';
END;
