CREATE TABLE attachment_index (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    filename TEXT NOT NULL,
    PRIMARY KEY (message_id, ordinal)
) WITHOUT ROWID;

-- The existing search index stores sanitized names separated by LF.
WITH RECURSIVE split(message_id, ordinal, filename, remaining) AS (
    SELECT rowid, -1, '', filenames || char(10) FROM message_search WHERE filenames <> ''
    UNION ALL
    SELECT message_id, ordinal + 1,
        substr(remaining, 1, instr(remaining, char(10)) - 1),
        substr(remaining, instr(remaining, char(10)) + 1)
    FROM split WHERE remaining <> ''
)
INSERT INTO attachment_index (message_id, ordinal, filename)
SELECT message_id, ordinal, filename FROM split WHERE ordinal >= 0 AND filename <> '';

CREATE TABLE saved_searches (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    folder TEXT NOT NULL CHECK(folder IN ('archive', 'inbox', 'unread', 'sent')),
    account_id INTEGER REFERENCES mail_accounts(id),
    query TEXT NOT NULL,
    attachments_only INTEGER NOT NULL CHECK(attachments_only IN (0, 1))
);
