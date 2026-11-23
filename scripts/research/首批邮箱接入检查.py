"""查看邮箱预设、检查 TLS，或用两只专用测试邮箱显式验证往返。"""
import argparse
import getpass
import imaplib
import re
import smtplib
import socket
import ssl
import sys
import time
from contextlib import ExitStack, contextmanager

from 往返样信 import read_sample, sample, verify_arrival


# Thunderbird ISPDB 的个人标准域预设，出处见 docs/10-首批邮箱接入验证.md。
SERVICES = {
    "163": ("163.com", "imap.163.com", "smtp.163.com"),
    "qq": ("qq.com", "imap.qq.com", "smtp.qq.com"),
}
TIMEOUT = 8


def verify_tls(host, port, context):
    with socket.create_connection((host, port), timeout=TIMEOUT) as raw:
        with context.wrap_socket(raw, server_hostname=host) as connection:
            return connection.version()


@contextmanager
def inbox_session(host, account, code, context):
    with imaplib.IMAP4_SSL(host, 993, ssl_context=context, timeout=TIMEOUT) as client:
        client.login(account, code)
        if "ID" in client.capabilities:
            client.xatom("ID", '("name" "Local Mail Probe" "version" "1.0")')
        status, _ = client.select("INBOX", readonly=True)
        if status != "OK":
            raise imaplib.IMAP4.error("无法以只读方式打开收件箱")
        yield client


def verify_imap(host, account, code, context):
    with inbox_session(host, account, code, context):
        pass


def verify_smtp(host, account, code, context):
    with smtplib.SMTP_SSL(host, 465, timeout=TIMEOUT, context=context) as client:
        client.login(account, code)


def test_address(provider):
    domain = SERVICES[provider][0]
    address = input(f"请输入用于测试的 @{domain} 地址：").strip()
    local, _, suffix = address.partition("@")
    if suffix.lower() != domain or not re.fullmatch(r"[A-Za-z0-9_+.-]+", local):
        raise ValueError(f"请输入完整的 @{domain} 标准个人测试邮箱地址")
    return f"{local}@{domain}"


def test_code(provider):
    code = getpass.getpass(f"请输入 {provider} 测试账号的客户端授权码（输入隐藏）：")
    if not code:
        raise ValueError("授权码为空")
    return code


def send_and_readback(mail, smtp_host, code, context, inbox):
    identifier = str(mail["Message-ID"])
    print(f"{mail['From']} → {mail['To']}  本次测试 Message-ID {identifier}", flush=True)
    with smtplib.SMTP_SSL(smtp_host, 465, timeout=TIMEOUT, context=context) as smtp:
        smtp.login(str(mail["From"]), code)
        if smtp.send_message(mail):
            raise RuntimeError("收件地址遭拒")
    print("SMTP 已确认接收，正在只读核对目标收件箱。", flush=True)
    deadline = time.monotonic() + 90
    while True:
        received = read_sample(inbox, identifier)
        if received is not None:
            verify_arrival(mail, received)
            return
        if time.monotonic() >= deadline:
            raise RuntimeError("在 90 秒内未查到样信，请用上述标识检查到达时间或分流情况")
        time.sleep(3)


def roundtrip(context):
    first, second = (test_address(provider) for provider in ("163", "qq"))
    print(f"第一封 {first} → {second}，附件为工具生成的差旅行程.csv。")
    print(f"第二封 {second} → {first}，仅在第一封通过校验后回复。")
    if input("两者均为本人获准使用的专用测试邮箱时，输入「发送两封样信」继续：").strip() != "发送两封样信":
        print("已取消，未连接服务商。")
        return
    first_code, second_code = (test_code(provider) for provider in ("163", "qq"))
    first_mail = sample(first, second)
    with ExitStack() as stack:
        first_inbox = stack.enter_context(inbox_session(SERVICES["163"][1], first, first_code, context))
        second_inbox = stack.enter_context(inbox_session(SERVICES["qq"][1], second, second_code, context))
        send_and_readback(first_mail, SERVICES["163"][2], first_code, context, second_inbox)
        print("正向样信的身份、附件名称与附件字节通过。")
        reply = sample(second, first, first_mail["Message-ID"])
        send_and_readback(reply, SERVICES["qq"][2], second_code, context, first_inbox)
    print("两封样信均在目标收件箱按标识唯一命中，反向回复的发件身份与会话关联通过。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=SERVICES, help="只检查选中的个人邮箱服务商")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--tls", action="store_true", help="连接公开端点并核验证书")
    mode.add_argument("--verify-account", action="store_true", help="交互验证测试账号；不读取邮件内容或投递邮件")
    mode.add_argument("--roundtrip", action="store_true", help="本人确认后，在 163 与 QQ 两个专用测试账号之间提交两封合成邮件")
    parser.add_argument("--cafile", help="使用指定的受信任 PEM CA 文件")
    args = parser.parse_args()
    if args.verify_account and (not args.provider or not sys.stdin.isatty()):
        parser.error("验证测试账号需要 --provider，并须在本机交互终端输入")
    if args.roundtrip and (args.provider or not sys.stdin.isatty()):
        parser.error("双向投递需在本机交互终端运行，且同时使用 163 与 QQ")
    providers = [args.provider] if args.provider else SERVICES
    context = None
    if args.tls or args.verify_account or args.roundtrip:
        try:
            context = ssl.create_default_context(cafile=args.cafile)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
        except (OSError, ValueError) as err:
            parser.error(f"无法载入受信任证书：{err}")
    if args.roundtrip:
        try:
            roundtrip(context)
        except (RuntimeError, ValueError) as err:
            print(f"验证中止：{err}", file=sys.stderr)
            return 1
        except (OSError, imaplib.IMAP4.error, smtplib.SMTPException, KeyboardInterrupt, EOFError) as err:
            print(f"验证中止（{type(err).__name__}）。若已开始提交，请先按上面的标识核对收件箱。工具不会自动重投。", file=sys.stderr)
            return 1
        return 0
    ok = True
    for provider in providers:
        domain, incoming, outgoing = SERVICES[provider]
        if args.verify_account:
            try:
                account = test_address(provider)
                code = test_code(provider)
            except ValueError as err:
                parser.error(str(err))
        for label, host, port, verify_account in (
            ("IMAP", incoming, 993, verify_imap), ("SMTP", outgoing, 465, verify_smtp)
        ):
            try:
                if args.tls:
                    result = f"证书和主机名通过，{verify_tls(host, port, context)}"
                elif args.verify_account:
                    verify_account(host, account, code, context)
                    result = "已认证并只读打开 INBOX" if label == "IMAP" else "已认证，未提交邮件"
                else:
                    result = "隐式 TLS，登录名使用完整邮箱地址"
            except ssl.SSLCertVerificationError:
                result = "证书校验失败，请检查系统时间、域名与 CA 信任配置"
                ok = False
            except (TimeoutError, socket.gaierror):
                result = "连接超时或域名无法解析"
                ok = False
            except (OSError, ValueError, imaplib.IMAP4.error, smtplib.SMTPException) as err:
                result = f"检查失败（{type(err).__name__}），请检查网络、协议开关、授权码与服务商限制"
                ok = False
            print(f"{domain}  {label}  {host}:{port}  {result}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
