CREATE TABLE inbox_items (
    account_id INTEGER NOT NULL REFERENCES mail_accounts(id),
    uid_validity INTEGER NOT NULL,
    uid INTEGER NOT NULL,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    unread INTEGER NOT NULL CHECK(unread IN (0, 1)),
    local_read INTEGER NOT NULL DEFAULT 0 CHECK(local_read IN (0, 1)),
    PRIMARY KEY (account_id, uid_validity, uid)
) WITHOUT ROWID;
CREATE INDEX inbox_messages ON inbox_items(account_id, message_id);
CREATE TABLE drafts (
    id INTEGER PRIMARY KEY,
    account_id INTEGER REFERENCES mail_accounts(id),
    recipient TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    reply_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'editing' CHECK(status IN ('editing', 'uncertain', 'rejected', 'sent')),
    changed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    sent_message_id INTEGER REFERENCES messages(id)
);
CREATE INDEX draft_list ON drafts(status, changed_at DESC, id DESC);
CREATE TABLE draft_attachments (
    id INTEGER PRIMARY KEY,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    payload BLOB NOT NULL
);
CREATE INDEX draft_files ON draft_attachments(draft_id, id);
