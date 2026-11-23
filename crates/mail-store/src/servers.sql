CREATE TABLE mail_servers (
    account_id INTEGER PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
    settings TEXT NOT NULL,
    revision TEXT NOT NULL,
    inbox_generation INTEGER NOT NULL DEFAULT 1
);
ALTER TABLE inbox_items RENAME TO old_inbox_items;
CREATE TABLE inbox_items (
    account_id INTEGER NOT NULL REFERENCES mail_accounts(id),
    inbox_generation INTEGER NOT NULL,
    uid_validity INTEGER NOT NULL,
    uid INTEGER NOT NULL,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    unread INTEGER NOT NULL CHECK(unread IN (0, 1)),
    local_read INTEGER NOT NULL DEFAULT 0 CHECK(local_read IN (0, 1)),
    PRIMARY KEY (account_id, inbox_generation, uid_validity, uid)
) WITHOUT ROWID;
INSERT INTO inbox_items
    SELECT account_id, 0, uid_validity, uid, message_id, unread, local_read FROM old_inbox_items;
DROP TABLE old_inbox_items;
CREATE INDEX inbox_messages ON inbox_items(account_id, message_id);
