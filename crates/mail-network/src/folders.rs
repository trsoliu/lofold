use std::{
    collections::HashSet,
    io::{Read, Write},
};

use imap::{
    error::Error as ImapError,
    types::{Flag, Mailbox},
    Session,
};
use imap_proto::{parser::parse_response, Capability, MailboxDatum, NameAttribute, Response};

use crate::{Connection, MailError};

const WINDOW: u32 = 20;
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const DOWNLOAD_BUDGET: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RemoteFolderKind {
    Inbox,
    Sent,
    Drafts,
    Junk,
    Trash,
    Archive,
    Custom,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteFolder {
    /// IMAP mailbox name to pass back to the server.
    pub name: String,
    pub label: String,
    pub kind: RemoteFolderKind,
    pub delimiter: Option<String>,
}

#[derive(Debug)]
pub struct FolderBatch {
    pub uid_validity: u32,
    pub considered: u32,
    pub skipped: u32,
    pub items: Vec<FolderItem>,
    pub has_more: bool,
    /// Inclusive UID range known to have been enumerated on a latest-page read.
    pub reconcile_from: Option<u32>,
    pub reconcile_through: Option<u32>,
}

#[derive(Debug)]
pub struct FolderItem {
    pub uid: u32,
    pub unread: bool,
    pub flagged: bool,
    /// Absent for cached messages and messages whose bodies could not be downloaded.
    pub raw: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Debug)]
pub enum FolderMutation<'a> {
    Seen(bool),
    Flagged(bool),
    Move(&'a str),
    DeletePermanently,
}

impl Connection<'_> {
    pub fn list_folders(&self, user: &str, secret: &str) -> Result<Vec<RemoteFolder>, MailError> {
        let mut session = self.imap_session(user, secret)?;
        let folders = list_folders(&mut session);
        let _ = session.logout();
        folders
    }

    pub fn receive_folder(
        &self,
        user: &str,
        secret: &str,
        folder: &str,
        known: &HashSet<(u32, u32)>,
        before: Option<u32>,
    ) -> Result<FolderBatch, MailError> {
        validate_folder_name(folder)?;
        let mut session = self.imap_session(user, secret)?;
        let mailbox = session.examine(folder).map_err(|_| MailError::FolderOpen)?;
        let batch = receive_page(&mut session, &mailbox, known, before);
        let _ = session.logout();
        batch
    }

    pub fn mutate_folder(
        &self,
        user: &str,
        secret: &str,
        folder: &str,
        uid_validity: u32,
        uid: u32,
        action: FolderMutation<'_>,
    ) -> Result<(), MailError> {
        validate_folder_name(folder)?;
        if let FolderMutation::Move(destination) = action {
            validate_folder_name(destination)?;
            if folder == destination
                || (folder.eq_ignore_ascii_case("INBOX")
                    && destination.eq_ignore_ascii_case("INBOX"))
            {
                return Err(MailError::FolderAction);
            }
        }
        if uid == 0 || uid_validity == 0 {
            return Err(MailError::FolderChanged);
        }
        let mut session = self.imap_session(user, secret)?;
        let result = mutate_in_folder(&mut session, folder, uid_validity, uid, action);
        let _ = session.logout();
        result
    }
}

fn validate_folder_name(folder: &str) -> Result<(), MailError> {
    if folder.is_empty() || folder.chars().any(char::is_control) {
        return Err(MailError::FolderOpen);
    }
    Ok(())
}

fn list_folders<T: Read + Write>(session: &mut Session<T>) -> Result<Vec<RemoteFolder>, MailError> {
    let use_extended = session.capabilities().is_ok_and(|capabilities| {
        capabilities.iter().any(|capability| {
            capability_is(capability, "SPECIAL-USE") || capability_is(capability, "IMAP4rev2")
        })
    });
    let basic_list = "LIST \"\" \"*\"";
    let names = if use_extended {
        match session.run_command_and_read_response("LIST \"\" \"*\" RETURN (SPECIAL-USE)") {
            Err(ImapError::Bad(_) | ImapError::No(_)) => {
                session.run_command_and_read_response(basic_list)
            }
            response => response,
        }
    } else {
        session.run_command_and_read_response(basic_list)
    }
    .map_err(|_| MailError::FolderList)?;
    remote_folders(&names)
}

fn capability_is(capability: &Capability<'_>, expected: &str) -> bool {
    match capability {
        Capability::Atom(value) => value.eq_ignore_ascii_case(expected),
        _ => false,
    }
}

fn remote_folders(mut remaining: &[u8]) -> Result<Vec<RemoteFolder>, MailError> {
    use RemoteFolderKind::{Custom, Inbox};

    let mut folders = Vec::new();
    let mut used_roles = HashSet::new();
    let mut used_names = HashSet::new();
    while !remaining.is_empty() {
        let line = remaining;
        let (rest, response) = parse_response(line).map_err(|_| MailError::FolderList)?;
        remaining = rest;
        let Response::MailboxData(MailboxDatum::List {
            name_attributes,
            delimiter,
            name,
        }) = response
        else {
            continue;
        };
        if name_attributes.iter().any(|attribute| match attribute {
            NameAttribute::NoSelect => true,
            NameAttribute::Extension(name) => name.eq_ignore_ascii_case("\\NonExistent"),
            _ => false,
        }) {
            continue;
        }
        // The parser leaves quoted-pair escapes in borrowed names. Literal names already contain
        // their actual bytes, so only unescape when the parsed token starts after a quote.
        let name = if listed_as_quoted(line, &name) {
            unescape_list_name(&name)
        } else {
            name.into_owned()
        };
        if validate_folder_name(&name).is_err() || !used_names.insert(name.clone()) {
            continue;
        }
        let kind = if name.eq_ignore_ascii_case("INBOX") {
            Inbox
        } else {
            name_attributes
                .iter()
                .find_map(special_role)
                .unwrap_or(Custom)
        };
        if kind != Custom {
            used_roles.insert(kind);
        }
        folders.push(RemoteFolder {
            label: decode_modified_utf7(&name).unwrap_or_else(|| name.clone()),
            name,
            kind,
            delimiter: delimiter.as_deref().map(unescape_list_name),
        });
    }

    // An explicitly advertised role wins. For aliases alone, prefer a top-level mailbox.
    folders.sort_by(|left, right| {
        let depth = |folder: &RemoteFolder| {
            folder
                .delimiter
                .as_ref()
                .filter(|delimiter| !delimiter.is_empty())
                .map_or(0, |delimiter| folder.name.matches(delimiter).count())
        };
        depth(left)
            .cmp(&depth(right))
            .then_with(|| left.name.cmp(&right.name))
    });
    for folder in &mut folders {
        if folder.kind == Custom {
            if let Some(kind) = fallback_role(&folder.label, folder.delimiter.as_deref()) {
                if used_roles.insert(kind) {
                    folder.kind = kind;
                }
            }
        }
    }
    folders.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.label.cmp(&right.label))
    });
    Ok(folders)
}

fn listed_as_quoted(response: &[u8], name: &str) -> bool {
    let position = (name.as_ptr() as usize).checked_sub(response.as_ptr() as usize);
    position
        .and_then(|start| start.checked_sub(1))
        .and_then(|before| response.get(before))
        == Some(&b'"')
}

fn special_role(attribute: &NameAttribute<'_>) -> Option<RemoteFolderKind> {
    use RemoteFolderKind::{Archive, Drafts, Junk, Sent, Trash};
    Some(match attribute {
        NameAttribute::Sent => Sent,
        NameAttribute::Drafts => Drafts,
        NameAttribute::Junk => Junk,
        NameAttribute::Trash => Trash,
        NameAttribute::Archive => Archive,
        NameAttribute::Extension(name) if name.eq_ignore_ascii_case("\\Spam") => Junk,
        _ => return None,
    })
}

fn fallback_role(label: &str, delimiter: Option<&str>) -> Option<RemoteFolderKind> {
    use RemoteFolderKind::{Archive, Drafts, Junk, Sent, Trash};
    let label = label.to_ascii_lowercase();
    let name = match delimiter.and_then(|separator| label.split_once(separator)) {
        Some(("inbox" | "[gmail]" | "[google mail]", name)) => name,
        Some(_) => return None,
        None => &label,
    };
    Some(match name {
        "sent" | "sent items" | "sent mail" | "sent messages" | "sentmail" | "已发送"
        | "已发送邮件" | "寄件备份" | "寄件備份" | "寄件匣" => Sent,
        "draft" | "drafts" | "draft items" | "草稿" | "草稿箱" | "草稿匣" => Drafts,
        "junk" | "junk e-mail" | "junk email" | "junk mail" | "spam" | "垃圾邮件" | "垃圾郵件"
        | "垃圾邮箱" | "垃圾郵件匣" | "广告邮件" => Junk,
        "trash" | "bin" | "deleted" | "deleted items" | "deleted messages" | "已删除"
        | "已刪除" | "已删除邮件" | "废纸篓" | "垃圾桶" | "回收站" => Trash,
        "archive" | "archives" | "archived" | "归档" | "封存" => Archive,
        _ => return None,
    })
}

// imap-proto returns the contents of a quoted LIST name with its quoted-pair escapes.
fn unescape_list_name(name: &str) -> String {
    let mut output = String::with_capacity(name.len());
    let mut chars = name.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' && matches!(chars.peek(), Some('"' | '\\')) {
            output.extend(chars.next());
        } else {
            output.push(ch);
        }
    }
    output
}

fn decode_modified_utf7(name: &str) -> Option<String> {
    let mut output = String::with_capacity(name.len());
    let mut remaining = name;
    while let Some((plain, shifted)) = remaining.split_once('&') {
        output.push_str(plain);
        let (encoded, rest) = shifted.split_once('-')?;
        if encoded.is_empty() {
            output.push('&');
        } else {
            let bytes = modified_base64(encoded)?;
            let (pairs, remainder) = bytes.as_chunks::<2>();
            if !remainder.is_empty() {
                return None;
            }
            let units = pairs.iter().copied().map(u16::from_be_bytes);
            for unit in char::decode_utf16(units) {
                output.push(unit.ok()?);
            }
        }
        remaining = rest;
    }
    output.push_str(remaining);
    Some(output)
}

fn modified_base64(encoded: &str) -> Option<Vec<u8>> {
    let mut decoded = Vec::with_capacity(encoded.len() * 3 / 4);
    let mut pending = 0u16;
    let mut bits = 0;
    for byte in encoded.bytes() {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b',' => 63,
            _ => return None,
        };
        pending = (pending << 6) | u16::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            decoded.push((pending >> bits) as u8);
            pending &= (1 << bits) - 1;
        }
    }
    (bits < 6 && pending == 0).then_some(decoded)
}

fn receive_page<T: Read + Write>(
    session: &mut Session<T>,
    mailbox: &Mailbox,
    known: &HashSet<(u32, u32)>,
    before: Option<u32>,
) -> Result<FolderBatch, MailError> {
    let uid_validity = mailbox
        .uid_validity
        .filter(|value| *value > 0)
        .ok_or(MailError::FolderReceive)?;
    let mut batch = FolderBatch {
        uid_validity,
        considered: 0,
        skipped: 0,
        items: Vec::new(),
        has_more: false,
        reconcile_from: None,
        reconcile_through: None,
    };
    let through = mailbox.uid_next.and_then(|uid| uid.checked_sub(1));
    let greatest_known = || {
        known
            .iter()
            .filter(|(generation, _)| *generation == uid_validity)
            .map(|(_, uid)| *uid)
            .max()
    };
    let last = match before {
        Some(before) if before <= 1 => return Ok(batch),
        Some(before) if !mailbox.uid_next.is_some_and(|next| before >= next) => {
            sequence_before(session, mailbox.exists, before)?
        }
        _ => mailbox.exists,
    };
    if last == 0 {
        if before.is_none() {
            batch.reconcile_from = Some(1);
            batch.reconcile_through = through.or_else(greatest_known);
        }
        return Ok(batch);
    }

    let first = last.saturating_sub(WINDOW - 1).max(1);
    let metadata = session
        .fetch(format!("{first}:{last}"), "(UID FLAGS RFC822.SIZE)")
        .map_err(|_| MailError::FolderReceive)?;
    let mut page = metadata
        .iter()
        .filter_map(|message| {
            let uid = message.uid.filter(|uid| *uid > 0)?;
            let size = message.size?;
            if !(first..=last).contains(&message.message)
                || before.is_some_and(|before| uid >= before)
            {
                return None;
            }
            Some((uid, message.message, size, message.flags()))
        })
        .collect::<Vec<_>>();
    page.sort_unstable_by(|left, right| right.0.cmp(&left.0));
    page.dedup_by_key(|message| message.0);
    if page.is_empty() {
        return Err(MailError::FolderReceive);
    }
    batch.considered = page.len() as u32;
    batch.has_more = first > 1;
    if before.is_none() && page.iter().map(|entry| entry.1).eq((first..=last).rev()) {
        batch.reconcile_from = Some(if first == 1 {
            1
        } else {
            page.last().expect("nonempty page").0
        });
        batch.reconcile_through = through.or_else(|| {
            page.first()
                .map(|message| message.0.max(greatest_known().unwrap_or(0)))
        });
    }

    let mut remaining = DOWNLOAD_BUDGET;
    for (uid, _, size, flags) in page {
        let mut item = FolderItem {
            uid,
            unread: !has_flag(flags, &Flag::Seen),
            flagged: has_flag(flags, &Flag::Flagged),
            raw: None,
        };
        if !known.contains(&(uid_validity, uid)) {
            let size = size as usize;
            if size > 0 && size <= remaining.min(MAX_MESSAGE_BYTES) {
                remaining -= size;
                let result = session
                    .uid_fetch(uid.to_string(), format!("(UID BODY.PEEK[]<0.{size}>)"))
                    .map_err(|_| MailError::FolderReceive)?;
                if let Some(body) = result
                    .iter()
                    .filter(|response| response.uid == Some(uid))
                    .find_map(|response| response.body())
                    .filter(|raw| raw.len() == size)
                {
                    item.raw = Some(body.to_vec());
                }
            }
            if item.raw.is_none() {
                batch.skipped += 1;
            }
        }
        batch.items.push(item);
    }
    Ok(batch)
}

// UIDs increase with sequence positions. A binary search avoids pulling all UIDs in a large folder.
fn sequence_before<T: Read + Write>(
    session: &mut Session<T>,
    exists: u32,
    before: u32,
) -> Result<u32, MailError> {
    let mut low = 0;
    let mut high = exists;
    while low < high {
        let middle = high - (high - low) / 2;
        let fetched = session
            .fetch(middle.to_string(), "(UID)")
            .map_err(|_| MailError::FolderReceive)?;
        let uid = fetched
            .iter()
            .filter(|response| response.message == middle)
            .find_map(|response| response.uid)
            .filter(|uid| *uid > 0)
            .ok_or(MailError::FolderReceive)?;
        if uid < before {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    Ok(low)
}

fn mutate_in_folder<T: Read + Write>(
    session: &mut Session<T>,
    folder: &str,
    uid_validity: u32,
    uid: u32,
    action: FolderMutation<'_>,
) -> Result<(), MailError> {
    let mailbox = session.select(folder).map_err(|_| MailError::FolderOpen)?;
    if mailbox.uid_validity != Some(uid_validity) {
        return Err(MailError::FolderChanged);
    }
    if mailbox.is_read_only {
        return Err(MailError::FolderActionUnsupported);
    }
    let flag = match action {
        FolderMutation::Seen(value) => Some((Flag::Seen, value)),
        FolderMutation::Flagged(value) => Some((Flag::Flagged, value)),
        FolderMutation::DeletePermanently => Some((Flag::Deleted, true)),
        FolderMutation::Move(_) => None,
    };
    if let Some((required, _)) = &flag {
        if !mailbox.permanent_flags.is_empty() && !has_flag(&mailbox.permanent_flags, required) {
            return Err(MailError::FolderActionUnsupported);
        }
    }
    let mut move_by_copy = false;
    if matches!(
        action,
        FolderMutation::Move(_) | FolderMutation::DeletePermanently
    ) {
        let capabilities = session
            .capabilities()
            .map_err(|_| MailError::FolderAction)?;
        let supports = |name| {
            capabilities
                .iter()
                .any(|item| capability_is(item, name) || capability_is(item, "IMAP4rev2"))
        };
        move_by_copy = matches!(action, FolderMutation::Move(_)) && !supports("MOVE");
        if (move_by_copy || matches!(action, FolderMutation::DeletePermanently))
            && !supports("UIDPLUS")
        {
            return Err(MailError::FolderActionUnsupported);
        }
        if move_by_copy
            && !mailbox.permanent_flags.is_empty()
            && !has_flag(&mailbox.permanent_flags, &Flag::Deleted)
        {
            return Err(MailError::FolderActionUnsupported);
        }
    }
    let original = uid_flags(session, uid)
        .map_err(|_| MailError::FolderAction)?
        .ok_or(MailError::MessageMissing)?;
    let uid_set = uid.to_string();
    if let Some((flag, value)) = flag {
        if has_flag(&original, &flag) != value {
            let verb = if value {
                "+FLAGS.SILENT"
            } else {
                "-FLAGS.SILENT"
            };
            session
                .uid_store(&uid_set, format!("{verb} ({flag})"))
                .map_err(mutation_error)?;
        }
        if !matches!(action, FolderMutation::DeletePermanently) {
            let flags = uid_flags(session, uid)
                .map_err(|_| MailError::FolderActionUncertain)?
                .ok_or(MailError::MessageMissing)?;
            return if has_flag(&flags, &flag) == value {
                Ok(())
            } else {
                Err(MailError::FolderAction)
            };
        }
    }

    match action {
        FolderMutation::Move(destination) if move_by_copy => {
            if has_flag(&original, &Flag::Deleted) {
                return Err(MailError::FolderActionUnsupported);
            }
            let destination = destination.replace('\\', "\\\\").replace('"', "\\\"");
            session
                .run_command_and_check_ok(format!("UID COPY {uid_set} \"{destination}\""))
                .map_err(mutation_error)?;
            // Once the exact UID copy succeeds, failure in either remaining step
            // is ambiguous to the caller. Never reissue COPY or expunge the folder.
            session
                .uid_store(&uid_set, "+FLAGS.SILENT (\\Deleted)")
                .map_err(|_| MailError::FolderActionUncertain)?;
            session
                .uid_expunge(&uid_set)
                .map_err(|_| MailError::FolderActionUncertain)?;
        }
        FolderMutation::Move(destination) => {
            session
                .uid_mv(&uid_set, destination)
                .map_err(|error| match error {
                    ImapError::No(_) => MailError::FolderActionUncertain,
                    error => mutation_error(error),
                })?
        }
        FolderMutation::DeletePermanently => {
            // The preceding STORE can already have changed the target even if EXPUNGE fails.
            session
                .uid_expunge(&uid_set)
                .map_err(|_| MailError::FolderActionUncertain)?;
        }
        _ => unreachable!("flag mutations returned above"),
    }
    if uid_flags(session, uid)
        .map_err(|_| MailError::FolderActionUncertain)?
        .is_some()
    {
        return Err(MailError::FolderActionUncertain);
    }
    Ok(())
}

fn uid_flags<T: Read + Write>(
    session: &mut Session<T>,
    uid: u32,
) -> imap::error::Result<Option<Vec<Flag<'static>>>> {
    let result = session.uid_fetch(uid.to_string(), "(UID FLAGS)")?;
    Ok(result
        .iter()
        .find(|response| response.uid == Some(uid))
        .map(|response| {
            response
                .flags()
                .iter()
                .cloned()
                .map(Flag::into_owned)
                .collect()
        }))
}

fn has_flag(flags: &[Flag<'_>], expected: &Flag<'_>) -> bool {
    let expected_name = match expected {
        Flag::Seen => "\\Seen",
        Flag::Flagged => "\\Flagged",
        Flag::Deleted => "\\Deleted",
        _ => return flags.contains(expected),
    };
    flags.iter().any(|flag| {
        flag == expected
            || matches!(flag, Flag::Custom(name) if name.eq_ignore_ascii_case(expected_name))
    })
}

fn mutation_error(error: ImapError) -> MailError {
    match error {
        ImapError::Bad(_) | ImapError::No(_) | ImapError::Validate(_) => MailError::FolderAction,
        _ => MailError::FolderActionUncertain,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::RefCell,
        io::{self, Cursor},
        rc::Rc,
    };

    #[derive(Debug)]
    struct Script {
        responses: Cursor<Vec<u8>>,
        commands: Rc<RefCell<Vec<u8>>>,
    }

    impl Read for Script {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.responses.read(buffer)
        }
    }

    impl Write for Script {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.commands.borrow_mut().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn scripted(responses: &str) -> (Session<Script>, Rc<RefCell<Vec<u8>>>) {
        let commands = Rc::new(RefCell::new(Vec::new()));
        let client = imap::Client::new(Script {
            responses: Cursor::new(format!("a1 OK authenticated\r\n{responses}").into_bytes()),
            commands: Rc::clone(&commands),
        });
        let session = client.login("fixture-user", "fixture-password").unwrap();
        (session, commands)
    }

    fn issued(commands: &RefCell<Vec<u8>>) -> Vec<String> {
        String::from_utf8(commands.borrow().clone())
            .unwrap()
            .lines()
            .skip(1)
            .map(|line| line.split_once(' ').unwrap().1.to_owned())
            .collect()
    }

    #[test]
    fn list_uses_special_use_and_preserves_wire_and_literal_names() {
        let (mut session, commands) = scripted(concat!(
            "* CAPABILITY IMAP4rev1 special-use\r\n",
            "a2 OK capability\r\n",
            "* LIST (\\Noselect) \"/\" Namespace\r\n",
            "* LIST (\\NonExistent) \"/\" Gone\r\n",
            "* LIST () \"/\" inbox\r\n",
            "* LIST (\\Sent) \"/\" \"&XfJT0ZAB-\"\r\n",
            "* LIST () \"/\" \"Sent Items\"\r\n",
            "* LIST () \"/\" \"INBOX/Drafts\"\r\n",
            "* LIST (\\Junk) \"/\" Advertising\r\n",
            "* LIST () \"/\" \"Deleted Items\"\r\n",
            "* LIST (\\Archive) \"/\" \"Long Term\"\r\n",
            "* LIST () \"/\" \"Namespace/R&D &- Legal\"\r\n",
            "* LIST () \"/\" \"Quoted \\\"Folder\\\"\"\r\n",
            "* LIST () NIL {11}\r\nback\\\\slash\r\n",
            "a3 OK list\r\n",
        ));
        let folders = list_folders(&mut session).unwrap();
        let find = |name: &str| folders.iter().find(|folder| folder.name == name).unwrap();
        assert_eq!(folders.len(), 10);
        assert_eq!(find("INBOX").kind, RemoteFolderKind::Inbox);
        assert_eq!(find("&XfJT0ZAB-").label, "已发送");
        assert_eq!(find("&XfJT0ZAB-").kind, RemoteFolderKind::Sent);
        assert_eq!(find("Sent Items").kind, RemoteFolderKind::Custom);
        assert_eq!(find("INBOX/Drafts").kind, RemoteFolderKind::Drafts);
        assert_eq!(find("Advertising").kind, RemoteFolderKind::Junk);
        assert_eq!(find("Deleted Items").kind, RemoteFolderKind::Trash);
        assert_eq!(find("Long Term").kind, RemoteFolderKind::Archive);
        assert_eq!(find("Quoted \"Folder\"").label, "Quoted \"Folder\"");
        assert_eq!(find("back\\\\slash").delimiter, None);
        assert_eq!(
            issued(&commands),
            ["CAPABILITY", "LIST \"\" \"*\" RETURN (SPECIAL-USE)"]
        );
        assert_eq!(
            decode_modified_utf7("R&-D &2D3eAA-").as_deref(),
            Some("R&D 😀")
        );
        assert_eq!(decode_modified_utf7("&XQ!-"), None);
    }

    #[test]
    fn list_retries_without_the_extension_after_a_tagged_rejection() {
        let (mut session, commands) = scripted(concat!(
            "* CAPABILITY IMAP4rev1 SPECIAL-USE\r\n",
            "a2 OK capability\r\n",
            "a3 BAD unsupported\r\n",
            "* LIST () NIL Trash\r\n",
            "a4 OK list\r\n",
        ));
        let folders = list_folders(&mut session).unwrap();
        assert_eq!(folders[0].kind, RemoteFolderKind::Trash);
        assert_eq!(
            issued(&commands),
            [
                "CAPABILITY",
                "LIST \"\" \"*\" RETURN (SPECIAL-USE)",
                "LIST \"\" \"*\"",
            ]
        );
    }

    #[test]
    fn receive_uses_a_bounded_peek_and_retains_skipped_uid_and_flags() {
        let (mut session, commands) = scripted(concat!(
            "* 3 EXISTS\r\n",
            "* OK [UIDVALIDITY 7] generation\r\n",
            "* OK [UIDNEXT 14] next\r\n",
            "a2 OK [READ-ONLY] selected\r\n",
            "* 1 FETCH (UID 8 FLAGS () RFC822.SIZE 20000000)\r\n",
            "* 3 FETCH (UID 12 FLAGS (\\seen \\FLAGGED) RFC822.SIZE 3)\r\n",
            "* 2 FETCH (UID 10 FLAGS (\\Seen) RFC822.SIZE 11)\r\n",
            "a3 OK fetched\r\n",
            "* 3 FETCH (UID 12 BODY[]<0> {3}\r\nabc)\r\n",
            "a4 OK fetched\r\n",
        ));
        let mailbox = session.examine("Drafts").unwrap();
        let known = HashSet::from([(7, 10), (6, 12)]);
        let batch = receive_page(&mut session, &mailbox, &known, None).unwrap();
        assert_eq!((batch.considered, batch.skipped), (3, 1));
        assert_eq!(batch.uid_validity, 7);
        assert_eq!(
            (batch.reconcile_from, batch.reconcile_through),
            (Some(1), Some(13))
        );
        assert!(!batch.has_more);
        let fresh = &batch.items[0];
        assert_eq!(fresh.uid, 12);
        assert!(!fresh.unread);
        assert!(fresh.flagged);
        assert_eq!(fresh.raw.as_deref(), Some(b"abc".as_slice()));
        let cached = &batch.items[1];
        assert_eq!(cached.uid, 10);
        assert!(!cached.unread);
        assert!(cached.raw.is_none());
        let oversized = &batch.items[2];
        assert_eq!(oversized.uid, 8);
        assert!(oversized.unread);
        assert!(oversized.raw.is_none());
        assert_eq!(
            issued(&commands),
            [
                "EXAMINE \"Drafts\"",
                "FETCH 1:3 (UID FLAGS RFC822.SIZE)",
                "UID FETCH 12 (UID BODY.PEEK[]<0.3>)",
            ]
        );
    }

    #[test]
    fn older_pages_keep_a_strict_uid_boundary_without_authorizing_reconciliation() {
        let (mut session, commands) = scripted(concat!(
            "* 3 FETCH (UID 30)\r\n",
            "a2 OK fetched\r\n",
            "* 1 FETCH (UID 10)\r\n",
            "a3 OK fetched\r\n",
            "* 2 FETCH (UID 20)\r\n",
            "a4 OK fetched\r\n",
            "* 1 FETCH (UID 10 FLAGS () RFC822.SIZE 5)\r\n",
            "* 2 FETCH (UID 20 FLAGS () RFC822.SIZE 5)\r\n",
            "a5 OK fetched\r\n",
        ));
        let mut mailbox = Mailbox::default();
        mailbox.exists = 5;
        mailbox.uid_next = Some(60);
        mailbox.uid_validity = Some(7);
        let known = HashSet::from([(7, 10), (7, 20)]);
        let batch = receive_page(&mut session, &mailbox, &known, Some(30)).unwrap();
        let uids = batch.items.iter().map(|item| item.uid).collect::<Vec<_>>();
        assert_eq!(uids, [20, 10]);
        assert_eq!(
            (batch.reconcile_from, batch.reconcile_through),
            (None, None)
        );
        assert_eq!(
            issued(&commands),
            [
                "FETCH 3 (UID)",
                "FETCH 1 (UID)",
                "FETCH 2 (UID)",
                "FETCH 1:2 (UID FLAGS RFC822.SIZE)"
            ]
        );
    }

    #[test]
    fn empty_and_interrupted_windows_authorize_only_observed_ranges() {
        let (mut session, commands) = scripted("");
        let mut mailbox = Mailbox::default();
        mailbox.uid_next = Some(31);
        mailbox.uid_validity = Some(7);
        let empty = receive_page(&mut session, &mailbox, &HashSet::new(), None).unwrap();
        assert_eq!(
            (empty.reconcile_from, empty.reconcile_through),
            (Some(1), Some(30))
        );
        assert!(issued(&commands).is_empty());

        let (mut session, _) = scripted(concat!(
            "* 2 FETCH (UID 20 FLAGS () RFC822.SIZE 5)\r\n",
            "a2 OK fetched\r\n",
        ));
        mailbox.exists = 2;
        let incomplete =
            receive_page(&mut session, &mailbox, &HashSet::from([(7, 20)]), None).unwrap();
        assert_eq!(
            (incomplete.reconcile_from, incomplete.reconcile_through),
            (None, None)
        );
    }

    const SELECTED: &str = concat!(
        "* 2 EXISTS\r\n",
        "* OK [UIDVALIDITY 7] generation\r\n",
        "* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Deleted)] flags\r\n",
        "a2 OK [READ-WRITE] selected\r\n",
    );

    #[test]
    fn stale_generation_never_mutates_a_reused_uid() {
        let (mut session, commands) = scripted(SELECTED);
        assert!(matches!(
            mutate_in_folder(
                &mut session,
                "Trash",
                6,
                12,
                FolderMutation::DeletePermanently
            ),
            Err(MailError::FolderChanged)
        ));
        assert_eq!(issued(&commands), ["SELECT \"Trash\""]);
    }

    #[test]
    fn verifies_the_exact_seen_and_flagged_changes() {
        for (action, old_flags, new_flags, expected) in [
            (
                FolderMutation::Seen(true),
                "",
                "\\SEEN",
                "+FLAGS.SILENT (\\Seen)",
            ),
            (
                FolderMutation::Seen(false),
                "\\seen",
                "",
                "-FLAGS.SILENT (\\Seen)",
            ),
            (
                FolderMutation::Flagged(true),
                "",
                "\\Flagged",
                "+FLAGS.SILENT (\\Flagged)",
            ),
            (
                FolderMutation::Flagged(false),
                "\\Flagged",
                "",
                "-FLAGS.SILENT (\\Flagged)",
            ),
        ] {
            let (mut session, commands) = scripted(&format!(
                "{SELECTED}* 2 FETCH (UID 12 FLAGS ({old_flags}))\r\na3 OK fetched\r\n\
                 a4 OK stored\r\n* 2 FETCH (UID 12 FLAGS ({new_flags}))\r\na5 OK fetched\r\n"
            ));
            mutate_in_folder(&mut session, "Projects", 7, 12, action).unwrap();
            assert_eq!(
                issued(&commands),
                [
                    "SELECT \"Projects\"",
                    "UID FETCH 12 (UID FLAGS)",
                    &format!("UID STORE 12 {expected}"),
                    "UID FETCH 12 (UID FLAGS)",
                ]
            );
        }
    }

    #[test]
    fn permanent_delete_is_scoped_to_one_uid_and_refuses_unsafe_servers() {
        let (mut session, commands) = scripted(&format!(
            "{SELECTED}* CAPABILITY IMAP4rev1 uidplus\r\na3 OK capability\r\n\
             * 2 FETCH (UID 12 FLAGS ())\r\na4 OK fetched\r\na5 OK stored\r\n\
             * 2 EXPUNGE\r\na6 OK removed\r\na7 OK fetched\r\n"
        ));
        mutate_in_folder(
            &mut session,
            "Trash",
            7,
            12,
            FolderMutation::DeletePermanently,
        )
        .unwrap();
        assert_eq!(
            issued(&commands),
            [
                "SELECT \"Trash\"",
                "CAPABILITY",
                "UID FETCH 12 (UID FLAGS)",
                "UID STORE 12 +FLAGS.SILENT (\\Deleted)",
                "UID EXPUNGE 12",
                "UID FETCH 12 (UID FLAGS)",
            ]
        );

        let (mut session, commands) = scripted(&format!(
            "{SELECTED}* CAPABILITY IMAP4rev1\r\na3 OK capability\r\n"
        ));
        assert!(matches!(
            mutate_in_folder(
                &mut session,
                "Trash",
                7,
                12,
                FolderMutation::DeletePermanently
            ),
            Err(MailError::FolderActionUnsupported)
        ));
        assert_eq!(issued(&commands), ["SELECT \"Trash\"", "CAPABILITY"]);
    }

    #[test]
    fn move_targets_a_single_uid_and_quotes_the_destination() {
        let (mut session, commands) = scripted(&format!(
            "{SELECTED}* CAPABILITY IMAP4rev1 MOVE\r\na3 OK capability\r\n\
             * 2 FETCH (UID 12 FLAGS (\\Seen))\r\na4 OK fetched\r\n\
             * 2 EXPUNGE\r\na5 OK moved\r\na6 OK fetched\r\n"
        ));
        mutate_in_folder(
            &mut session,
            "Projects",
            7,
            12,
            FolderMutation::Move("Custom/With \"quotes\""),
        )
        .unwrap();
        assert_eq!(
            issued(&commands),
            [
                "SELECT \"Projects\"",
                "CAPABILITY",
                "UID FETCH 12 (UID FLAGS)",
                "UID MOVE 12 \"Custom/With \\\"quotes\\\"\"",
                "UID FETCH 12 (UID FLAGS)",
            ]
        );
    }

    #[test]
    fn uidplus_move_fallback_copies_then_expunge_only_the_source_uid() {
        let (mut session, commands) = scripted(&format!(
            "{SELECTED}* CAPABILITY IMAP4rev1 UIDPLUS\r\na3 OK capability\r\n\
             * 2 FETCH (UID 12 FLAGS (\\Seen))\r\na4 OK fetched\r\n\
             a5 OK [COPYUID 8 12 20] copied\r\na6 OK flagged\r\n\
             * 2 EXPUNGE\r\na7 OK removed\r\na8 OK fetched\r\n"
        ));
        mutate_in_folder(
            &mut session,
            "Projects",
            7,
            12,
            FolderMutation::Move("Trash"),
        )
        .unwrap();
        assert_eq!(
            issued(&commands),
            [
                "SELECT \"Projects\"",
                "CAPABILITY",
                "UID FETCH 12 (UID FLAGS)",
                "UID COPY 12 \"Trash\"",
                "UID STORE 12 +FLAGS.SILENT (\\Deleted)",
                "UID EXPUNGE 12",
                "UID FETCH 12 (UID FLAGS)",
            ]
        );
    }
}
