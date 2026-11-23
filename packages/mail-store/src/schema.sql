CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    digest BLOB NOT NULL UNIQUE CHECK(length(digest) = 32),
    raw_size INTEGER NOT NULL,
    subject TEXT NOT NULL,
    sender TEXT NOT NULL,
    preview TEXT NOT NULL,
    sent_at INTEGER,
    has_attachments INTEGER NOT NULL
);
CREATE INDEX messages_reading_order ON messages (sent_at DESC, id DESC);
CREATE TABLE message_blocks (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    payload BLOB NOT NULL,
    PRIMARY KEY (message_id, ordinal)
) WITHOUT ROWID;
CREATE VIRTUAL TABLE message_search USING fts5 (
    subject, sender, recipients, body, filenames, tokenize='trigram'
);
