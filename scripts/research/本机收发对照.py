"""在回环地址启动临时 GreenMail 2.1.15，核对中文邮件与发送结果不明的后果。"""
import argparse
import hashlib
import imaplib
import json
import smtplib
import socket
import subprocess
import tempfile
import time
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from pathlib import Path

from 往返样信 import PAYLOAD, read_sample, sample, verify_arrival


HOST = "127.0.0.1"
DOMAIN = "example.test"
JAR_SHA256 = "91d58798698cac357f015365240383b936ced2f2a1a9f7db37d9e3e1a31391b1"


def free_port():
    with socket.socket() as sock:
        sock.bind((HOST, 0))
        return sock.getsockname()[1]


class DiscardFinalReply(smtplib.SMTP):
    """在 SMTP 客户端与业务调用者之间丢弃确认，不改变邮件服务器行为。"""
    discarding = False

    def data(self, msg):
        self.discarding = True
        try:
            return super().data(msg)
        finally:
            self.discarding = False

    def getreply(self):
        code, reply = super().getreply()
        if self.discarding and code == 250:
            self.close()
            raise smtplib.SMTPServerDisconnected("实验：服务端最终确认未交给业务层")
        return code, reply


def message(identifier, subject):
    mail = EmailMessage(policy=policy.SMTP)
    mail["From"] = "sender@" + DOMAIN
    mail["To"] = "reader@" + DOMAIN
    mail["Message-ID"] = identifier
    mail["Subject"] = subject
    mail.set_content("请核对差旅报销材料。")
    return mail


def fetch(port, account, identifier):
    with imaplib.IMAP4(HOST, port, timeout=8) as client:
        client.login(account, "fixture")
        status, _ = client.select("INBOX", readonly=True)
        assert status == "OK"
        status, rows = client.uid("SEARCH", None, "HEADER", "Message-ID", identifier)
        assert status == "OK"
        messages = []
        for uid in rows[0].split():
            status, body = client.uid("FETCH", uid, "(BODY.PEEK[])")
            assert status == "OK"
            messages.append(BytesParser(policy=policy.default).parsebytes(body[0][1]))
        return messages


def check_two_accounts(smtp_port, imap_port):
    personal, studio = (name + "@" + DOMAIN for name in ("personal", "studio"))
    first = sample(personal, studio)
    reply = sample(studio, personal, first["Message-ID"])
    for mail in (first, reply):
        sender = mail["From"].addresses[0].username
        recipient = mail["To"].addresses[0].username
        with smtplib.SMTP(HOST, smtp_port, timeout=8) as smtp:
            smtp.login(sender, "fixture")
            assert smtp.send_message(mail) == {}
        with imaplib.IMAP4(HOST, imap_port, timeout=8) as inbox:
            inbox.login(recipient, "fixture")
            assert inbox.select("INBOX", readonly=True)[0] == "OK"
            received = read_sample(inbox, mail["Message-ID"])
            assert received is not None
            verify_arrival(mail, received)
        assert not fetch(imap_port, sender, mail["Message-ID"])
    return {"delivered_per_leg": [1, 1], "unexpected_inbox_copies": 0, "attachment_bytes": len(PAYLOAD)}


def run_test(smtp_port, imap_port):
    first_id = "<roundtrip@example.test>"
    mail = message(first_id, "差旅报销与会议")
    mail["Bcc"] = "blind@" + DOMAIN
    content = "金额,用途\n123,测试差旅\n".encode()
    mail.add_attachment(content, maintype="text", subtype="csv", filename="差旅报销单.csv")
    with smtplib.SMTP(HOST, smtp_port, timeout=8) as smtp:
        assert smtp.send_message(mail) == {}
    counts = {}
    for account in ("reader", "blind"):
        items = fetch(imap_port, account, first_id)
        assert len(items) == 1
        received = items[0]
        assert received["Subject"] == mail["Subject"] and received["Bcc"] is None
        part, = received.iter_attachments()
        assert part.get_filename() == "差旅报销单.csv"
        assert part.get_payload(decode=True) == content
        counts[account] = len(items)
    ack_id = "<ambiguous@example.test>"
    payload = message(ack_id, "确认丢失测试").as_bytes()
    def submit(smtp):
        smtp.sendmail("sender@" + DOMAIN, ["reader@" + DOMAIN], payload)
    try:
        with DiscardFinalReply(HOST, smtp_port, timeout=8) as smtp:
            submit(smtp)
    except smtplib.SMTPServerDisconnected as err:
        if not str(err).startswith("实验"):
            raise
    else:
        raise AssertionError("未模拟出确认丢失")
    before = len(fetch(imap_port, "reader", ack_id))
    with smtplib.SMTP(HOST, smtp_port, timeout=8) as smtp:
        submit(smtp)
    after = len(fetch(imap_port, "reader", ack_id))
    assert (before, after) == (1, 2)
    return {"two_test_accounts": check_two_accounts(smtp_port, imap_port),
            "recipient_counts": counts, "attachment_sha256": hashlib.sha256(content).hexdigest(),
            "copies_after_lost_reply": before, "copies_after_deliberate_retry": after}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jar", type=Path, help="GreenMail 2.1.15 standalone jar")
    parser.add_argument("--java", default="java")
    args = parser.parse_args()
    jar = args.jar.resolve()
    if hashlib.sha256(jar.read_bytes()).hexdigest() != JAR_SHA256:
        parser.error("请使用本次核验的 GreenMail 2.1.15 构件")
    smtp_port, imap_port = free_port(), free_port()
    while smtp_port == imap_port:
        imap_port = free_port()
    command = [args.java, f"-Dgreenmail.smtp.hostname={HOST}", f"-Dgreenmail.smtp.port={smtp_port}",
               f"-Dgreenmail.imap.hostname={HOST}", f"-Dgreenmail.imap.port={imap_port}",
               "-Dgreenmail.users=" + ",".join(
                   name + ":fixture@" + DOMAIN for name in ("reader", "blind", "personal", "studio")),
               "-jar", str(jar)]
    with tempfile.TemporaryDirectory() as work, tempfile.TemporaryFile(mode="w+b") as log:
        server = subprocess.Popen(command, cwd=work, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline and server.poll() is None:
                try:
                    with socket.create_connection((HOST, smtp_port), timeout=.3):
                        pass
                    with socket.create_connection((HOST, imap_port), timeout=.3):
                        break
                except OSError:
                    time.sleep(.1)
            else:
                log.seek(0)
                raise RuntimeError(log.read().decode(errors="replace")[-1800:])
            print(json.dumps(run_test(smtp_port, imap_port), ensure_ascii=False, indent=2))
        finally:
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


if __name__ == "__main__":
    main()
