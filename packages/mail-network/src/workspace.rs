use std::collections::HashSet;

use imap::types::Flag;
use lettre::{
    address::Envelope,
    message::{header::ContentType, Attachment, Mailbox, MultiPart},
    Message, Transport,
};
use uuid::Uuid;

use crate::{outgoing_body, Connection, MailError};

const INBOX_WINDOW: u32 = 20;
const MAX_RECEIVE_BYTES: usize = 16 * 1024 * 1024;
const RECEIVE_BUDGET: usize = 32 * 1024 * 1024;

pub struct InboxBatch {
    pub uid_validity: u32,
    pub considered: u32,
    pub skipped: u32,
    pub items: Vec<Incoming>,
}

pub struct Incoming {
    pub uid: u32,
    pub unread: bool,
    pub raw: Option<Vec<u8>>,
}

pub struct PreparedMail {
    envelope: Envelope,
    pub raw: Vec<u8>,
}

#[derive(Default)]
pub struct MailRecipients<'a> {
    pub to: &'a str,
    pub cc: &'a str,
    pub bcc: &'a str,
}

pub fn prepare_mail(
    sender: &str,
    recipients: &str,
    subject: &str,
    body: &str,
    replies_to: Option<&str>,
    files: Vec<(String, Vec<u8>)>,
) -> Result<PreparedMail, MailError> {
    prepare_mail_with_recipients(
        sender,
        MailRecipients {
            to: recipients,
            ..MailRecipients::default()
        },
        subject,
        body,
        replies_to,
        files,
    )
}

pub fn prepare_mail_with_recipients(
    sender: &str,
    recipients: MailRecipients<'_>,
    subject: &str,
    body: &str,
    replies_to: Option<&str>,
    files: Vec<(String, Vec<u8>)>,
) -> Result<PreparedMail, MailError> {
    let to = parse_recipients(recipients.to)?;
    let cc = parse_recipients(recipients.cc)?;
    let bcc = parse_recipients(recipients.bcc)?;
    if !(1..=20).contains(&(to.len() + cc.len() + bcc.len())) {
        return Err(MailError::InvalidRecipient);
    }
    let subject = subject.trim();
    if subject.is_empty() || subject.chars().any(char::is_control) {
        return Err(MailError::InvalidSubject);
    }
    let mut builder = Message::builder()
        .from(sender.parse().map_err(|_| MailError::Message)?)
        .subject(subject)
        .message_id(Some(format!("<mail-{}@lofold.invalid>", Uuid::new_v4())));
    for recipient in to {
        builder = builder.to(recipient);
    }
    for recipient in cc {
        builder = builder.cc(recipient);
    }
    for recipient in bcc {
        // Lettre uses Bcc for the SMTP envelope and strips the header from the message.
        builder = builder.bcc(recipient);
    }
    if let Some(id) = replies_to.filter(|id| {
        id.len() <= 512
            && id.contains('@')
            && id
                .bytes()
                .all(|byte| byte.is_ascii_graphic() && !b"<>".contains(&byte))
    }) {
        let reference = format!("<{id}>");
        builder = builder.in_reply_to(reference.clone()).references(reference);
    }
    let body = outgoing_body(body);
    let email = if files.is_empty() {
        builder.singlepart(body)
    } else {
        let mut multipart = MultiPart::mixed().singlepart(body);
        for (filename, payload) in files {
            multipart = multipart.singlepart(Attachment::new(filename).body(
                payload,
                ContentType::parse("application/octet-stream").map_err(|_| MailError::Message)?,
            ));
        }
        builder.multipart(multipart)
    }
    .map_err(|_| MailError::Message)?;
    let raw = email.formatted();
    if raw.len() > MAX_RECEIVE_BYTES {
        return Err(MailError::Message);
    }
    Ok(PreparedMail {
        envelope: email.envelope().clone(),
        raw,
    })
}

fn parse_recipients(recipients: &str) -> Result<Vec<Mailbox>, MailError> {
    recipients
        .split([',', ';', '，', '；', '\n'])
        .map(str::trim)
        .filter(|recipient| !recipient.is_empty())
        .map(|recipient| {
            if !crate::is_valid_address(recipient) {
                return Err(MailError::InvalidRecipient);
            }
            recipient.parse().map_err(|_| MailError::InvalidRecipient)
        })
        .collect()
}

impl Connection<'_> {
    pub fn deliver(&self, user: &str, secret: &str, mail: &PreparedMail) -> Result<(), MailError> {
        self.transport(user, secret)?
            .send_raw(&mail.envelope, &mail.raw)
            .map_err(crate::submission_error)?;
        Ok(())
    }

    pub fn receive_recent(
        &self,
        user: &str,
        secret: &str,
        known: &HashSet<(u32, u32)>,
    ) -> Result<InboxBatch, MailError> {
        let (mut inbox, mailbox) = self.open_inbox(user, secret)?;
        let uid_validity = mailbox
            .uid_validity
            .filter(|value| *value > 0)
            .ok_or(MailError::Receive)?;
        let mut batch = InboxBatch {
            uid_validity,
            considered: mailbox.exists.min(INBOX_WINDOW),
            skipped: 0,
            items: Vec::new(),
        };
        if mailbox.exists > 0 {
            let first = mailbox.exists - batch.considered + 1;
            let window = inbox
                .fetch(
                    format!("{first}:{}", mailbox.exists),
                    "(UID FLAGS RFC822.SIZE)",
                )
                .map_err(|_| MailError::Receive)?;
            let mut remaining = RECEIVE_BUDGET;
            for message in window.iter().rev() {
                let Some(uid) = message.uid.filter(|uid| *uid > 0) else {
                    batch.skipped += 1;
                    continue;
                };
                let unread = !message.flags().contains(&Flag::Seen);
                let mut item = Incoming {
                    uid,
                    unread,
                    raw: None,
                };
                if !known.contains(&(uid_validity, uid)) {
                    let size = message.size.unwrap_or(u32::MAX) as usize;
                    if size == 0 || size > remaining.min(MAX_RECEIVE_BYTES) {
                        batch.skipped += 1;
                        continue;
                    }
                    let result = inbox
                        .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
                        .map_err(|_| MailError::Receive)?;
                    let Some(raw) = result
                        .iter()
                        .find(|item| item.uid == Some(uid))
                        .and_then(|item| item.body())
                        .filter(|raw| {
                            !raw.is_empty() && raw.len() <= remaining.min(MAX_RECEIVE_BYTES)
                        })
                    else {
                        batch.skipped += 1;
                        continue;
                    };
                    remaining -= raw.len();
                    item.raw = Some(raw.to_vec());
                }
                batch.items.push(item);
            }
        }
        let _ = inbox.logout();
        Ok(batch)
    }
}

#[cfg(test)]
mod compose_tests {
    use super::*;
    use crate::MAIL_FOOTER;

    #[test]
    fn smtp_envelope_keeps_all_recipients_and_raw_mail_only_shows_visible_addresses() {
        let mail = prepare_mail_with_recipients(
            "sender@example.test",
            MailRecipients {
                to: "to@example.test",
                cc: "copy@example.test",
                bcc: "private@example.test",
            },
            "Recipients",
            "Hello",
            None,
            Vec::new(),
        )
        .unwrap();
        let message = mail_parser::MessageParser::default()
            .parse(&mail.raw)
            .unwrap();
        assert_eq!(
            message
                .body_text(0)
                .unwrap()
                .replace("\r\n", "\n")
                .trim_end(),
            format!("Hello\n\n{MAIL_FOOTER}")
        );
        assert_eq!(
            message.to().unwrap().first().unwrap().address(),
            Some("to@example.test")
        );
        assert_eq!(
            message.cc().unwrap().first().unwrap().address(),
            Some("copy@example.test")
        );
        assert!(message.bcc().is_none());
        assert!(!String::from_utf8_lossy(&mail.raw).contains("private@example.test"));
        assert_eq!(
            mail.envelope
                .to()
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            [
                "to@example.test",
                "copy@example.test",
                "private@example.test"
            ]
        );

        let blind_only = prepare_mail_with_recipients(
            "sender@example.test",
            MailRecipients {
                bcc: "private@example.test",
                ..MailRecipients::default()
            },
            "Recipients",
            "Hello",
            None,
            Vec::new(),
        )
        .unwrap();
        assert_eq!(
            blind_only.envelope.to()[0].to_string(),
            "private@example.test"
        );
        assert!(!String::from_utf8_lossy(&blind_only.raw).contains("private@example.test"));
        assert!(matches!(
            prepare_mail_with_recipients(
                "sender@example.test",
                MailRecipients {
                    to: "to@example.test",
                    bcc: "bad address",
                    ..MailRecipients::default()
                },
                "Recipients",
                "Hello",
                None,
                Vec::new(),
            ),
            Err(MailError::InvalidRecipient)
        ));
    }

    #[test]
    fn forwarded_eml_survives_serialization_with_exact_bytes_and_no_reply_headers() {
        let original = b"Subject: Original\nX-Example: preserve line endings\n\nBinary \xFFbody\n";
        let mail = prepare_mail(
            "sender@example.test",
            "new@example.test",
            "Fwd: Original",
            "",
            None,
            vec![("LoFold-1.eml".into(), original.to_vec())],
        )
        .unwrap();
        let parsed = mail_parser::MessageParser::default()
            .parse(&mail.raw)
            .unwrap();
        assert_eq!(parsed.body_text(0).unwrap().trim_end(), MAIL_FOOTER);
        assert!(parsed.in_reply_to().is_none());
        let part = parsed.attachments().next().unwrap();
        assert_eq!(part.attachment_name(), Some("LoFold-1.eml"));
        assert_eq!(part.decoded().as_ref(), original);
    }
}
