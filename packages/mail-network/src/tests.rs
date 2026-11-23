use super::*;

#[test]
fn refused_imap_starttls_never_sends_login() {
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        socket.write_all(b"* OK ready\r\n").unwrap();
        let mut reader = BufReader::new(socket);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(line, "L001 STARTTLS\r\n");
        reader
            .get_mut()
            .write_all(b"L001 NO unavailable\r\n")
            .unwrap();
        line.clear();
        assert_eq!(reader.read_line(&mut line).unwrap(), 0);
    });
    let connection = Connection::manual(
        MailServer {
            host: "127.0.0.1",
            port,
            username: "reader",
            start_tls: true,
        },
        MailServer {
            host: "127.0.0.1",
            port: 465,
            username: "sender",
            start_tls: false,
        },
    );
    assert!(matches!(
        connection.verify("sample@example.test", "fixture"),
        Err(MailError::ImapTls)
    ));
    server.join().unwrap();
}

#[test]
#[ignore = "requires the isolated custom TLS fixture"]
fn manual_credentials_use_separate_logins_over_encrypted_endpoints() {
    let ca = std::fs::read(std::env::var_os("LOFOLD_FIXTURE_CA").unwrap()).unwrap();
    let port = |name: &str| std::env::var(name).unwrap().parse::<u16>().unwrap();
    for start_tls in [false, true] {
        let (imap, smtp) = if start_tls {
            (
                "LOFOLD_FIXTURE_IMAP_STARTTLS",
                "LOFOLD_FIXTURE_SMTP_STARTTLS",
            )
        } else {
            ("LOFOLD_FIXTURE_IMAPS", "LOFOLD_FIXTURE_SMTPS")
        };
        let mut connection = Connection::manual(
            MailServer {
                host: "127.0.0.1",
                port: port(imap),
                username: "imap-reader",
                start_tls,
            },
            MailServer {
                host: "127.0.0.1",
                port: port(smtp),
                username: "smtp-sender",
                start_tls,
            },
        );
        connection.test_ca = Some(&ca);
        connection.verify("sample@example.test", "fixture").unwrap();
    }
}

#[test]
fn only_supported_personal_domains_get_endpoints() {
    for (address, label) in [
        ("sample@163.com", "网易 163"),
        ("sample@QQ.com", "QQ 邮箱"),
        ("sample@gmail.com", "Gmail"),
    ] {
        assert_eq!(Provider::for_address(address).unwrap().label, label);
    }
    for address in [
        "test@example.test",
        "help@163.com.example.test",
        "test@163.com\r\n",
    ] {
        assert!(Provider::for_address(address).is_none());
    }
}

#[test]
#[ignore = "requires the isolated GreenMail TLS fixture and LOFOLD_FIXTURE_CA"]
fn smtp_and_imap_verify_the_same_legacy_named_attachment() {
    let ca = std::fs::read(std::env::var_os("LOFOLD_FIXTURE_CA").unwrap()).unwrap();
    let port = |variable: &str| std::env::var(variable).unwrap().parse::<u16>().unwrap();
    let connection = Connection {
        imap_host: "127.0.0.1",
        imap_port: port("LOFOLD_FIXTURE_IMAPS"),
        smtp_host: "127.0.0.1",
        smtp_port: port("LOFOLD_FIXTURE_SMTPS"),
        imap_start_tls: false,
        smtp_start_tls: false,
        imap_user: None,
        smtp_user: None,
        identify: false,
        original_id_header: None,
        test_ca: Some(&ca),
    };
    let user = "personal";
    let address = "personal@example.test";
    let secret = "fixture";
    assert!(matches!(
        connection.verify(user, "wrong-fixture-token"),
        Err(MailError::ImapLogin)
    ));
    connection.verify(user, secret).unwrap();
    let id = Uuid::new_v4();
    assert!(connection
        .read_probe_for(address, user, secret, id)
        .unwrap()
        .is_none());
    connection
        .send_probe_from(address, user, secret, id)
        .unwrap();
    let raw = connection
        .read_probe_for(address, user, secret, id)
        .unwrap()
        .unwrap();
    let sample = MessageParser::default().parse(&raw).unwrap();
    assert_eq!(
        sample
            .body_text(0)
            .unwrap()
            .replace("\r\n", "\n")
            .trim_end(),
        format!("{PROBE_BODY}\n\n{MAIL_FOOTER}")
    );

    let rewritten_id = Uuid::new_v4();
    let (email, transformed) = rewritten_sample(address, rewritten_id);
    connection
        .transport(user, secret)
        .unwrap()
        .send_raw(email.envelope(), &transformed)
        .unwrap();
    assert!(connection
        .read_probe_for(address, user, secret, rewritten_id)
        .unwrap()
        .is_none());
    let qq_mail = Connection {
        original_id_header: Some(QQ_ORIGINAL_ID_HEADER),
        ..connection
    };
    assert!(qq_mail
        .read_probe_for(address, user, secret, rewritten_id)
        .unwrap()
        .is_some());
    let mut inbox = qq_mail.inbox(user, secret).unwrap();
    assert_eq!(
        find_probe_by_subject(&mut inbox, &message_id(rewritten_id), QQ_ORIGINAL_ID_HEADER)
            .unwrap()
            .len(),
        1
    );
}

fn rewritten_sample(address: &str, id: Uuid) -> (Message, Vec<u8>) {
    let email = build_probe(address, id).unwrap();
    let original = format!("Message-ID: <{}>", message_id(id));
    let mut raw = String::from_utf8(email.formatted()).unwrap();
    assert!(raw.contains(&original));
    raw = raw.replacen(
        &original,
        &format!(
            "Message-ID: <relay-replaced@example.test>\r\n{QQ_ORIGINAL_ID_HEADER}: <{}>",
            message_id(id)
        ),
        1,
    );
    (email, raw.into_bytes())
}

#[test]
fn qq_rewritten_id_is_accepted_only_with_the_exact_expected_original() {
    let address = "fixture@qq.com";
    let id = Uuid::new_v4();
    let (_, raw) = rewritten_sample(address, id);
    assert!(verify_sample(&raw, address, &message_id(id), None).is_err());
    assert!(verify_sample(&raw, address, &message_id(id), Some(QQ_ORIGINAL_ID_HEADER)).is_ok());
    assert!(verify_sample(
        &raw,
        address,
        &message_id(Uuid::new_v4()),
        Some(QQ_ORIGINAL_ID_HEADER),
    )
    .is_err());
}

#[test]
#[ignore = "requires the isolated GreenMail TLS fixture and LOFOLD_FIXTURE_CA"]
fn real_compose_and_recent_inbox_preserve_identity_and_mime() {
    let ca = std::fs::read(std::env::var_os("LOFOLD_FIXTURE_CA").unwrap()).unwrap();
    let port = |variable: &str| std::env::var(variable).unwrap().parse::<u16>().unwrap();
    let connection = Connection {
        imap_host: "127.0.0.1",
        imap_port: port("LOFOLD_FIXTURE_IMAPS"),
        smtp_host: "127.0.0.1",
        smtp_port: port("LOFOLD_FIXTURE_SMTPS"),
        imap_start_tls: false,
        smtp_start_tls: false,
        imap_user: None,
        smtp_user: None,
        identify: false,
        original_id_header: None,
        test_ca: Some(&ca),
    };
    let secret = "fixture";
    let email = prepare_mail(
        "personal@example.test",
        "studio@example.test",
        "LoFold 写信联测",
        "这是带附件的中文邮件。",
        Some("previous@example.test"),
        vec![(PROBE_FILENAME.to_owned(), PROBE_CSV.to_vec())],
    )
    .unwrap();
    connection.deliver("personal", secret, &email).unwrap();
    let mut batch = connection
        .receive_recent("studio", secret, &HashSet::new())
        .unwrap();
    assert_eq!(batch.skipped, 0);
    let expected = MessageParser::default().parse(&email.raw).unwrap();
    let item = batch
        .items
        .iter_mut()
        .find(|item| {
            item.raw
                .as_deref()
                .and_then(|raw| MessageParser::default().parse(raw))
                .is_some_and(|message| message.message_id() == expected.message_id())
        })
        .unwrap();
    assert!(item.unread);
    let raw = item.raw.take().unwrap();
    let parsed = MessageParser::default().parse(raw.as_slice()).unwrap();
    assert_eq!(parsed.subject(), Some("LoFold 写信联测"));
    assert_eq!(
        parsed
            .body_text(0)
            .unwrap()
            .replace("\r\n", "\n")
            .trim_end(),
        format!("这是带附件的中文邮件。\n\n{MAIL_FOOTER}")
    );
    assert_eq!(
        parsed.from().unwrap().first().unwrap().address(),
        Some("personal@example.test")
    );
    let attachment = parsed.attachments().next().unwrap();
    assert_eq!(attachment.attachment_name(), Some(PROBE_FILENAME));
    assert_eq!(attachment.decoded().as_ref(), PROBE_CSV);
    assert_eq!(
        parsed.in_reply_to().and_then(|ids| ids.first()),
        Some("previous@example.test")
    );
    let intact_uid = item.uid;
    let known = HashSet::from([(batch.uid_validity, intact_uid)]);
    let again = connection.receive_recent("studio", secret, &known).unwrap();
    let same = again
        .items
        .iter()
        .find(|item| item.uid == intact_uid)
        .unwrap();
    assert!(same.raw.is_none());
    assert!(same.unread);
}
