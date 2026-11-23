"""首批邮箱验证共用的合成邮件与验收条件。"""
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import formatdate, make_msgid


PAYLOAD = "日期,行程\n11月20日,出发\n".encode()
FILENAME = "差旅行程.csv"


def sample(sender, recipient, in_reply_to=None):
    mail = EmailMessage(policy=policy.SMTP)
    mail["From"] = sender
    mail["To"] = recipient
    mail["Date"] = formatdate(localtime=True)
    mail["Message-ID"] = make_msgid(domain=sender.split("@")[1])
    mail["Subject"] = "回复：本地邮箱往返测试" if in_reply_to else "本地邮箱往返测试"
    mail.set_content("这是一封用于核对发件身份和附件的合成测试邮件。")
    if in_reply_to:
        mail["In-Reply-To"] = in_reply_to
        mail["References"] = in_reply_to
    else:
        mail.add_attachment(PAYLOAD, maintype="text", subtype="csv", filename=FILENAME)
    return mail


def read_sample(client, identifier):
    status, rows = client.uid("SEARCH", None, "HEADER", "Message-ID", identifier)
    if status != "OK" or not rows or not isinstance(rows[0], bytes):
        raise RuntimeError("服务商未接受按样信 Message-ID 查询")
    uids = rows[0].split()
    if not uids:
        return None
    if len(uids) != 1:
        raise RuntimeError("同一测试标识命中多封，需核对重复投递")
    status, parts = client.uid("FETCH", uids[0], "(BODY.PEEK[]<0.32768>)")
    if status != "OK":
        raise RuntimeError("无法读取命中的样信")
    body = next((part[1] for part in parts if isinstance(part, tuple) and len(part) == 2), None)
    if not isinstance(body, bytes) or len(body) >= 32768:
        raise RuntimeError("样信内容缺失或超出测试读取上限")
    mail = BytesParser(policy=policy.default).parsebytes(body)
    if mail.get("Message-ID") != identifier:
        raise RuntimeError("收件方样信标识不符")
    return mail


def verify_arrival(sent, received):
    for header in ("From", "To"):
        actual = received.get(header)
        if actual is None or len(actual.addresses) != 1 or actual.addresses[0].addr_spec != str(sent[header]):
            raise RuntimeError("收件方样信身份不符")
    for header in ("Message-ID", "Subject", "In-Reply-To", "References"):
        if received.get(header) != sent.get(header):
            raise RuntimeError(f"收件方样信的 {header} 不符")
    files = list(received.iter_attachments())
    if sent.get("In-Reply-To"):
        if files:
            raise RuntimeError("回复中出现意外附件")
    elif len(files) != 1 or files[0].get_filename() != FILENAME or files[0].get_payload(decode=True) != PAYLOAD:
        raise RuntimeError("收件方样信的附件名或字节不符")
