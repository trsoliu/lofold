use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    time::Duration,
};

use imap::{
    types::{Mailbox, Uid},
    Session,
};
use lettre::{
    message::{header::ContentType, Attachment, MultiPart, SinglePart},
    transport::smtp::{
        authentication::Credentials,
        client::{Tls, TlsParameters, TlsVersion},
    },
    Address, Message, SmtpTransport, Transport,
};
use mail_parser::{Message as ParsedMessage, MessageParser};
use native_tls::{Certificate, Protocol, TlsConnector, TlsStream};
use thiserror::Error;
use uuid::Uuid;

mod folders;
pub use folders::{FolderBatch, FolderItem, FolderMutation, RemoteFolder, RemoteFolderKind};
mod workspace;
pub use workspace::{prepare_mail, prepare_mail_with_recipients, InboxBatch, MailRecipients};

// native-tls loads the traditional Android system directory. Android 14 also
// distributes trust-anchor updates in the read-only Conscrypt APEX.
#[cfg(target_os = "android")]
fn conscrypt_roots() -> &'static [Vec<u8>] {
    use std::{fs, sync::OnceLock};
    static ROOTS: OnceLock<Vec<Vec<u8>>> = OnceLock::new();
    ROOTS.get_or_init(|| {
        fs::read_dir("/apex/com.android.conscrypt/cacerts")
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|entry| fs::read(entry.path()).ok())
            .collect()
    })
}

const TIMEOUT: Duration = Duration::from_secs(8);
const MAIL_FOOTER: &str = "Sent with LoFold: https://trsoliu.github.io/lofold/";
const PROBE_BODY: &str = "这封邮件由 LoFold 发给当前账号，用于验证 SMTP 发件与 IMAP 收件。";
const PROBE_FILENAME: &str = "差旅行程.csv";
const PROBE_CSV: &[u8] = "日期,行程\n11月20日,出发\n".as_bytes();
const PROBE_LIMIT: usize = 64 * 1024;
const PROBE_HEADER_SEARCH_LIMIT: usize = 24;
const QQ_ORIGINAL_ID_HEADER: &str = "X-OQ-MSGID";

pub fn is_valid_address(address: &str) -> bool {
    address.len() <= 254
        && !address.chars().any(char::is_control)
        && address.parse::<Address>().is_ok()
}

#[derive(Clone, Copy)]
pub struct Provider {
    pub label: &'static str,
    imap: &'static str,
    smtp: &'static str,
    identify: bool,
    original_id_header: Option<&'static str>,
}

impl Provider {
    pub fn for_address(address: &str) -> Option<Self> {
        let address: Address = address.parse().ok()?;
        let (label, imap, smtp, identify, original_id_header) =
            match address.domain().to_ascii_lowercase().as_str() {
                "163.com" => ("网易 163", "imap.163.com", "smtp.163.com", true, None),
                "qq.com" => (
                    "QQ 邮箱",
                    "imap.qq.com",
                    "smtp.qq.com",
                    false,
                    Some(QQ_ORIGINAL_ID_HEADER),
                ),
                "gmail.com" => ("Gmail", "imap.gmail.com", "smtp.gmail.com", false, None),
                _ => return None,
            };
        Some(Self {
            label,
            imap,
            smtp,
            identify,
            original_id_header,
        })
    }
}

#[derive(Debug, Error)]
pub enum MailError {
    #[error("无法连接 IMAP 服务，请检查网络。")]
    ImapConnection,
    #[error("IMAP 安全连接失败，请检查网络与证书。")]
    ImapTls,
    #[error("IMAP 授权未通过，请检查授权码及服务开关。")]
    ImapLogin,
    #[error("IMAP 无法只读打开收件箱，请检查服务商设置。")]
    Inbox,
    #[error("无法读取 IMAP 文件夹列表，请稍后重试。")]
    FolderList,
    #[error("无法打开此 IMAP 文件夹，请刷新文件夹列表。")]
    FolderOpen,
    #[error("无法读取此 IMAP 文件夹中的邮件，请稍后重试。")]
    FolderReceive,
    #[error("此邮件的服务器标识已变更，请刷新文件夹后重试。")]
    FolderChanged,
    #[error("服务器上的此邮件已移动或删除，请刷新文件夹。")]
    MessageMissing,
    #[error("此服务器或文件夹不支持该邮件操作。")]
    FolderActionUnsupported,
    #[error("服务器未接受该邮件操作。")]
    FolderAction,
    #[error("未收到明确的操作回执，请先刷新相关文件夹确认结果。")]
    FolderActionUncertain,
    #[error("SMTP 连接或授权未通过，请检查授权码和网络。")]
    SmtpConnection,
    #[error("SMTP 服务器未接受邮件。")]
    SmtpRejected,
    #[error("未收到明确的 SMTP 回执。请先核对投递结果。")]
    SmtpUncertain,
    #[error("请输入有效的收件邮箱，最多支持 20 个地址。")]
    InvalidRecipient,
    #[error("请输入有效的邮件主题。")]
    InvalidSubject,
    #[error("无法生成邮件。")]
    Message,
    #[error("IMAP 查收失败，可稍后再次查收同一封样信。")]
    Receive,
    #[error("查到的邮件与样信标识、地址或附件不一致。")]
    Mismatch,
}

pub struct Connection<'a> {
    imap_host: &'a str,
    imap_port: u16,
    smtp_host: &'a str,
    smtp_port: u16,
    imap_start_tls: bool,
    smtp_start_tls: bool,
    imap_user: Option<&'a str>,
    smtp_user: Option<&'a str>,
    identify: bool,
    original_id_header: Option<&'static str>,
    test_ca: Option<&'a [u8]>,
}

pub struct MailServer<'a> {
    pub host: &'a str,
    pub port: u16,
    pub username: &'a str,
    pub start_tls: bool,
}

impl<'a> Connection<'a> {
    pub fn provider(preset: Provider) -> Self {
        Self {
            imap_host: preset.imap,
            imap_port: 993,
            smtp_host: preset.smtp,
            smtp_port: 465,
            imap_start_tls: false,
            smtp_start_tls: false,
            imap_user: None,
            smtp_user: None,
            identify: preset.identify,
            original_id_header: preset.original_id_header,
            test_ca: None,
        }
    }

    pub fn manual(imap: MailServer<'a>, smtp: MailServer<'a>) -> Self {
        Self {
            imap_host: imap.host,
            imap_port: imap.port,
            smtp_host: smtp.host,
            smtp_port: smtp.port,
            imap_start_tls: imap.start_tls,
            smtp_start_tls: smtp.start_tls,
            imap_user: Some(imap.username),
            smtp_user: Some(smtp.username),
            identify: false,
            original_id_header: None,
            test_ca: None,
        }
    }

    pub fn verify(&self, address: &str, secret: &str) -> Result<(), MailError> {
        let mut inbox = self.inbox(address, secret)?;
        let _ = inbox.logout();
        if self
            .transport(address, secret)?
            .test_connection()
            .unwrap_or(false)
        {
            Ok(())
        } else {
            Err(MailError::SmtpConnection)
        }
    }

    pub fn send_probe(&self, address: &str, secret: &str, id: Uuid) -> Result<(), MailError> {
        self.send_probe_from(address, address, secret, id)
    }

    fn send_probe_from(
        &self,
        address: &str,
        user: &str,
        secret: &str,
        id: Uuid,
    ) -> Result<(), MailError> {
        let email = build_probe(address, id)?;
        self.transport(user, secret)?
            .send(&email)
            .map_err(submission_error)?;
        Ok(())
    }

    pub fn read_probe(
        &self,
        address: &str,
        secret: &str,
        id: Uuid,
    ) -> Result<Option<Vec<u8>>, MailError> {
        self.read_probe_for(address, address, secret, id)
    }

    fn read_probe_for(
        &self,
        address: &str,
        user: &str,
        secret: &str,
        id: Uuid,
    ) -> Result<Option<Vec<u8>>, MailError> {
        let mut inbox = self.inbox(user, secret)?;
        let raw = find_probe(&mut inbox, address, id, self.original_id_header);
        let _ = inbox.logout();
        raw
    }

    fn inbox(&self, user: &str, secret: &str) -> Result<Session<TlsStream<TcpStream>>, MailError> {
        self.open_inbox(user, secret).map(|(session, _)| session)
    }

    fn open_inbox(
        &self,
        user: &str,
        secret: &str,
    ) -> Result<(Session<TlsStream<TcpStream>>, Mailbox), MailError> {
        let mut session = self.imap_session(user, secret)?;
        let mailbox = session.examine("INBOX").map_err(|_| MailError::Inbox)?;
        Ok((session, mailbox))
    }

    fn imap_session(
        &self,
        user: &str,
        secret: &str,
    ) -> Result<Session<TlsStream<TcpStream>>, MailError> {
        let addresses = (self.imap_host, self.imap_port)
            .to_socket_addrs()
            .map_err(|_| MailError::ImapConnection)?;
        let mut tcp = addresses
            .take(4)
            .find_map(|address| TcpStream::connect_timeout(&address, TIMEOUT).ok())
            .ok_or(MailError::ImapConnection)?;
        tcp.set_read_timeout(Some(TIMEOUT))
            .and_then(|()| tcp.set_write_timeout(Some(TIMEOUT)))
            .map_err(|_| MailError::ImapConnection)?;
        let mut tls = TlsConnector::builder();
        tls.min_protocol_version(Some(Protocol::Tlsv12));
        #[cfg(target_os = "android")]
        for pem in conscrypt_roots() {
            if let Ok(cert) = Certificate::from_pem(pem) {
                tls.add_root_certificate(cert);
            }
        }
        if let Some(pem) = self.test_ca {
            tls.add_root_certificate(Certificate::from_pem(pem).map_err(|_| MailError::ImapTls)?);
        }
        let connector = tls.build().map_err(|_| MailError::ImapTls)?;
        if self.imap_start_tls {
            upgrade_imap_tls(&mut tcp)?;
        }
        let stream = connector
            .connect(self.imap_host, tcp)
            .map_err(|_| MailError::ImapTls)?;
        let mut client = imap::Client::new(stream);
        // An upgraded IMAP connection has already sent its greeting on the original stream.
        if !self.imap_start_tls {
            client
                .read_greeting()
                .map_err(|_| MailError::ImapConnection)?;
        }
        let mut session = client
            .login(self.imap_user.unwrap_or(user), secret)
            .map_err(|_| MailError::ImapLogin)?;
        if self.identify {
            let _ = session
                .run_command_and_read_response("ID (\"name\" \"LoFold\" \"version\" \"0.1.0\")");
        }
        Ok(session)
    }

    fn transport(&self, user: &str, secret: &str) -> Result<SmtpTransport, MailError> {
        let mut tls = TlsParameters::builder(self.smtp_host.to_owned())
            .set_min_tls_version(TlsVersion::Tlsv12);
        #[cfg(target_os = "android")]
        for pem in conscrypt_roots() {
            if let Ok(cert) = lettre::transport::smtp::client::Certificate::from_pem(pem) {
                tls = tls.add_root_certificate(cert);
            }
        }
        if let Some(pem) = self.test_ca {
            let cert = lettre::transport::smtp::client::Certificate::from_pem(pem)
                .map_err(|_| MailError::SmtpConnection)?;
            tls = tls.add_root_certificate(cert);
        }
        let parameters = tls.build().map_err(|_| MailError::SmtpConnection)?;
        let mode = if self.smtp_start_tls {
            Tls::Required(parameters)
        } else {
            Tls::Wrapper(parameters)
        };
        Ok(SmtpTransport::builder_dangerous(self.smtp_host)
            .port(self.smtp_port)
            .tls(mode)
            .timeout(Some(TIMEOUT))
            .credentials(Credentials::new(
                self.smtp_user.unwrap_or(user).to_owned(),
                secret.to_owned(),
            ))
            .build())
    }
}

fn upgrade_imap_tls(tcp: &mut TcpStream) -> Result<(), MailError> {
    fn read_line(reader: &mut impl BufRead, line: &mut String) -> Result<(), MailError> {
        line.clear();
        reader.read_line(line).map_err(|_| MailError::ImapTls)?;
        if !line.ends_with("\r\n") {
            return Err(MailError::ImapTls);
        }
        Ok(())
    }

    let mut greeting = BufReader::new(&mut *tcp).take(8192);
    let mut line = String::new();
    read_line(&mut greeting, &mut line)?;
    let mut words = line.split_ascii_whitespace();
    if words.next() != Some("*")
        || !words
            .next()
            .is_some_and(|word| word.eq_ignore_ascii_case("OK"))
    {
        return Err(MailError::ImapTls);
    }
    let reader = greeting.get_mut();
    reader
        .get_mut()
        .write_all(b"L001 STARTTLS\r\n")
        .map_err(|_| MailError::ImapTls)?;
    loop {
        read_line(&mut greeting, &mut line)?;
        let mut words = line.split_ascii_whitespace();
        match words.next() {
            Some("L001")
                if words
                    .next()
                    .is_some_and(|word| word.eq_ignore_ascii_case("OK")) =>
            {
                return Ok(())
            }
            Some("*") => continue,
            _ => return Err(MailError::ImapTls),
        }
    }
}

fn submission_error(error: lettre::transport::smtp::Error) -> MailError {
    if error.is_permanent() || error.is_transient() {
        MailError::SmtpRejected
    } else {
        MailError::SmtpUncertain
    }
}

fn outgoing_body(body: &str) -> SinglePart {
    let text = if body.is_empty() {
        MAIL_FOOTER.to_owned()
    } else {
        format!("{body}\n\n{MAIL_FOOTER}")
    };
    SinglePart::plain(text)
}

fn build_probe(address: &str, id: Uuid) -> Result<Message, MailError> {
    let mailbox = address.parse().map_err(|_| MailError::Message)?;
    Message::builder()
        .from(mailbox)
        .to(address.parse().map_err(|_| MailError::Message)?)
        .message_id(Some(format!("<{}>", message_id(id))))
        .subject("LoFold 收发验证")
        .multipart(
            MultiPart::mixed()
                .singlepart(outgoing_body(PROBE_BODY))
                .singlepart(Attachment::new(PROBE_FILENAME.to_owned()).body(
                    PROBE_CSV.to_vec(),
                    ContentType::parse("text/csv").map_err(|_| MailError::Message)?,
                )),
        )
        .map_err(|_| MailError::Message)
}

fn message_id(id: Uuid) -> String {
    format!("lofold-{id}@mail.lofold.invalid")
}

fn find_probe(
    inbox: &mut Session<TlsStream<TcpStream>>,
    address: &str,
    id: Uuid,
    original_id_header: Option<&str>,
) -> Result<Option<Vec<u8>>, MailError> {
    let expected = message_id(id);
    let mut matches = inbox
        .uid_search(format!("HEADER Message-ID \"<{expected}>\""))
        .map_err(|_| MailError::Receive)?;
    if let Some(header) = original_id_header.filter(|_| matches.is_empty()) {
        matches = inbox
            .uid_search(format!("HEADER {header} \"{expected}\""))
            .unwrap_or_default();
        if matches.is_empty() {
            matches = find_probe_by_subject(inbox, &expected, header)?;
        }
    }
    if matches.is_empty() {
        return Ok(None);
    }
    if matches.len() != 1 {
        return Err(MailError::Mismatch);
    }
    let uid = matches.into_iter().next().ok_or(MailError::Receive)?;
    let size = inbox
        .uid_fetch(uid.to_string(), "(UID RFC822.SIZE)")
        .map_err(|_| MailError::Receive)?
        .iter()
        .find(|item| item.uid == Some(uid))
        .and_then(|item| item.size)
        .ok_or(MailError::Receive)? as usize;
    if size == 0 || size > PROBE_LIMIT {
        return Err(MailError::Mismatch);
    }
    let messages = inbox
        .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
        .map_err(|_| MailError::Receive)?;
    let raw = messages
        .iter()
        .find(|item| item.uid == Some(uid))
        .and_then(|item| item.body())
        .ok_or(MailError::Receive)?;
    verify_sample(raw, address, &expected, original_id_header)?;
    Ok(Some(raw.to_vec()))
}

fn find_probe_by_subject(
    inbox: &mut Session<TlsStream<TcpStream>>,
    expected: &str,
    header: &str,
) -> Result<HashSet<Uid>, MailError> {
    let mut candidates = inbox
        .uid_search("SUBJECT \"LoFold\"")
        .map_err(|_| MailError::Receive)?
        .into_iter()
        .collect::<Vec<_>>();
    candidates.sort_unstable_by(|left, right| right.cmp(left));
    candidates.truncate(PROBE_HEADER_SEARCH_LIMIT);
    if candidates.is_empty() {
        return Ok(HashSet::new());
    }
    let uid_set = candidates
        .iter()
        .map(Uid::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let headers = inbox
        .uid_fetch(uid_set, "(UID BODY.PEEK[HEADER])")
        .map_err(|_| MailError::Receive)?;
    let parser = MessageParser::default();
    Ok(headers
        .iter()
        .filter_map(|item| {
            let parsed = parser.parse_headers(item.header()?)?;
            if matches_probe_id(&parsed, expected, Some(header)) {
                item.uid
            } else {
                None
            }
        })
        .collect())
}

fn matches_probe_id(message: &ParsedMessage<'_>, expected: &str, original: Option<&str>) -> bool {
    message.message_id() == Some(expected)
        || original
            .and_then(|header| message.headers().value(header))
            .and_then(|value| value.as_text())
            .is_some_and(|value| {
                let value = value.trim();
                value == expected
                    || value
                        .strip_prefix('<')
                        .and_then(|value| value.strip_suffix('>'))
                        == Some(expected)
            })
}

fn verify_sample(
    raw: &[u8],
    address: &str,
    expected_id: &str,
    original_id_header: Option<&str>,
) -> Result<(), MailError> {
    if raw.len() > PROBE_LIMIT {
        return Err(MailError::Mismatch);
    }
    let parsed = MessageParser::default()
        .parse(raw)
        .ok_or(MailError::Mismatch)?;
    let correct_address = |list: Option<mail_parser::AddressList<'_>>| {
        list.is_some_and(|list| {
            let mut mailboxes = list.mailboxes();
            mailboxes
                .next()
                .and_then(|mailbox| mailbox.address())
                .is_some_and(|value| value.eq_ignore_ascii_case(address))
                && mailboxes.next().is_none()
        })
    };
    let mut attachments = parsed.attachments();
    let correct_file = attachments.next().is_some_and(|attachment| {
        let (bytes, problems) = attachment.decoded_checked();
        attachment.attachment_name() == Some(PROBE_FILENAME)
            && problems.is_empty()
            && bytes == PROBE_CSV
    }) && attachments.next().is_none();
    if matches_probe_id(&parsed, expected_id, original_id_header)
        && correct_address(parsed.from())
        && correct_address(parsed.to())
        && correct_file
    {
        Ok(())
    } else {
        Err(MailError::Mismatch)
    }
}

#[cfg(test)]
mod tests;
