CREATE TABLE writing_profiles (
    account_id INTEGER REFERENCES mail_accounts(id) ON DELETE CASCADE CHECK(account_id > 0),
    revision INTEGER NOT NULL CHECK(revision > 0),
    profile TEXT NOT NULL
);

-- A null account is the profile for drafts with no sender selected.
CREATE UNIQUE INDEX writing_profile_scope ON writing_profiles(coalesce(account_id, 0));
