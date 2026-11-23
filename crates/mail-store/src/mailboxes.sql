CREATE TABLE mailboxes (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES mail_accounts(id),
    generation INTEGER NOT NULL,
    name TEXT NOT NULL,
    label TEXT NOT NULL,
    kind TEXT NOT NULL,
    delimiter TEXT,
    listed INTEGER NOT NULL DEFAULT 1,
    validity INTEGER,
    next_before INTEGER,
    UNIQUE(account_id, generation, name)
);
ALTER TABLE inbox_items RENAME TO previous_inbox_items;
CREATE TABLE inbox_items (
    account_id INTEGER NOT NULL REFERENCES mail_accounts(id),
    inbox_generation INTEGER NOT NULL,
    mailbox TEXT NOT NULL DEFAULT 'INBOX',
    uid_validity INTEGER NOT NULL,
    uid INTEGER NOT NULL,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    unread INTEGER NOT NULL CHECK(unread IN (0, 1)),
    local_read INTEGER NOT NULL DEFAULT 0 CHECK(local_read IN (0, 1)),
    flagged INTEGER NOT NULL DEFAULT 0 CHECK(flagged IN (0, 1)),
    PRIMARY KEY (account_id, inbox_generation, mailbox, uid_validity, uid)
) WITHOUT ROWID;
INSERT INTO inbox_items (account_id, inbox_generation, uid_validity, uid, message_id, unread, local_read)
    SELECT account_id, inbox_generation, uid_validity, uid, message_id, unread, local_read FROM previous_inbox_items;
DROP TABLE previous_inbox_items;
CREATE INDEX inbox_messages ON inbox_items(account_id, message_id);
CREATE TABLE pinned_messages (
    account_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    PRIMARY KEY (account_id, message_id)
) WITHOUT ROWID;
