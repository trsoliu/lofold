"""运行本机双邮箱联测环境，邮件随服务退出清空，TLS 信任仅供本次测试。"""
import argparse
import hashlib
import imaplib
from pathlib import Path
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time

from 本机收发对照 import DOMAIN, HOST, JAR_SHA256


def make_certificates(directory):
    """生成此次运行的测试 CA 和含 localhost、127.0.0.1 的服务端证书。"""
    def openssl(*args):
        proc = subprocess.run(["openssl", *args], cwd=directory, capture_output=True)
        if proc.returncode:
            raise RuntimeError(proc.stderr.decode(errors="replace")[-800:])

    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "7",
            "-subj", "/CN=Local Mail Test Root", "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", "root.key", "-out", "root.pem")
    openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost",
            "-keyout", "server.key", "-out", "server.csr")
    (directory / "server.ext").write_text(
        "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
    openssl("x509", "-req", "-in", "server.csr", "-CA", "root.pem", "-CAkey", "root.key",
            "-CAcreateserial", "-days", "7", "-extfile", "server.ext", "-out", "server.pem")
    openssl("pkcs12", "-export", "-in", "server.pem", "-inkey", "server.key", "-certfile",
            "root.pem", "-out", "server.p12", "-passout", "pass:fixture")
    for transient in ("root.key", "server.key", "server.csr", "server.ext", "root.srl", "server.pem"):
        (directory / transient).unlink()


def serve(jar, java, ports, stopped):
    with tempfile.TemporaryDirectory(prefix="local-mail-fixture-") as directory:
        work = Path(directory)
        make_certificates(work)
        context = ssl.create_default_context(cafile=str(work / "root.pem"))
        command = [java, f"-Dgreenmail.tls.keystore.file={work / 'server.p12'}",
                   "-Dgreenmail.tls.keystore.password=fixture",
                   f"-Dgreenmail.users=personal:fixture@{DOMAIN},studio:fixture@{DOMAIN}"]
        for protocol, port in ports.items():
            command.extend([f"-Dgreenmail.{protocol}.hostname={HOST}", f"-Dgreenmail.{protocol}.port={port}"])
        with (work / "greenmail.log").open("w+b") as log:
            server = subprocess.Popen([*command, "-jar", str(jar)], cwd=work, stdout=log,
                                      stderr=subprocess.STDOUT, start_new_session=True)
            try:
                deadline = time.monotonic() + 15
                while server.poll() is None and time.monotonic() < deadline and not stopped.is_set():
                    try:
                        with imaplib.IMAP4_SSL(HOST, ports["imaps"], timeout=2, ssl_context=context) as inbox:
                            inbox.login("personal", "fixture")
                            if inbox.select("INBOX", readonly=True)[0] != "OK":
                                raise RuntimeError("测试邮箱未能打开 INBOX")
                        break
                    except ConnectionRefusedError:
                        stopped.wait(.12)
                else:
                    if stopped.is_set():
                        return
                    log.seek(0)
                    raise RuntimeError("GreenMail 启动失败。\n" + log.read().decode(errors="replace")[-1000:])
                for protocol, port in ports.items():
                    print(f"{protocol.upper()}  {HOST}:{port}")
                print(f"个人邮箱 personal@{DOMAIN}（用户名 personal）\n工作邮箱 studio@{DOMAIN}（用户名 studio）")
                print("两只合成测试邮箱的密码均为 fixture")
                print(f"测试 CA  {work / 'root.pem'}\n按 Ctrl+C 停服务并清理本轮邮箱。", flush=True)
                while not stopped.wait(.3):
                    if server.poll() is not None:
                        raise RuntimeError(f"GreenMail 提前退出，退出码 {server.returncode}")
            finally:
                if server.poll() is None:
                    server.terminate()
                    try:
                        server.wait(timeout=6)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jar", type=Path, help="GreenMail 2.1.15 的 standalone JAR")
    parser.add_argument("--java", default="java", help="Java 可执行文件")
    default_ports = {"smtp":43025, "imap":43143, "smtps":43465, "imaps":43993}
    for name, port in default_ports.items():
        parser.add_argument(f"--{name}-port", type=int, default=port)
    args = parser.parse_args()
    jar = args.jar.resolve()
    ports = {name:getattr(args, name + "_port") for name in default_ports}
    if len(set(ports.values())) != len(ports) or not all(0 < p <= 65535 for p in ports.values()):
        parser.error("四个端口须不同且在 1 至 65535 内")
    try:
        if hashlib.sha256(jar.read_bytes()).hexdigest() != JAR_SHA256:
            parser.error("JAR 的 SHA-256 与已核验的 GreenMail 2.1.15 不符")
        for name, port in ports.items():
            with socket.socket() as sock:
                try:
                    sock.bind((HOST, port))
                except OSError as exc:
                    raise RuntimeError(f"{name.upper()} 端口 {port} 无法绑定，请换用其他端口") from exc
        stopped = threading.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stopped.set())
        serve(jar, args.java, ports, stopped)
    except (OSError, RuntimeError, imaplib.IMAP4.error) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
