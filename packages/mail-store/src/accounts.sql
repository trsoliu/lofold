CREATE TABLE mail_accounts (
    id INTEGER PRIMARY KEY,
    address TEXT NOT NULL COLLATE NOCASE UNIQUE,
    connected INTEGER NOT NULL DEFAULT 0 CHECK(connected IN (0, 1))
);
CREATE TABLE mail_probes (
    account_id INTEGER PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('uncertain', 'accepted', 'received', 'rejected')),
    message_id INTEGER REFERENCES messages(id)
);
