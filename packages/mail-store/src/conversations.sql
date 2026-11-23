CREATE TABLE conversation_indexed (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE
);
CREATE TABLE conversation_headers (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    header_id TEXT NOT NULL,
    PRIMARY KEY (message_id, header_id)
) WITHOUT ROWID;
CREATE INDEX conversation_header_lookup ON conversation_headers(header_id, message_id);
CREATE TABLE conversation_backfill (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    last_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL
);
INSERT INTO conversation_backfill VALUES (1, 0, coalesce((SELECT max(id) FROM messages), 0));
CREATE INDEX draft_sent_message ON drafts(account_id, sent_message_id) WHERE status='sent';
