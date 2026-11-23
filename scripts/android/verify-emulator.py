"""Exercise the release WebView, Android document picker and encrypted archive on a fresh CI AVD."""
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET


APP = "org.lofold.client"
TITLE = "LoFoldSmoke600"
NAME = f"{TITLE}.eml"
ARTIFACTS = Path(sys.argv[1])
ARTIFACTS.mkdir(parents=True, exist_ok=True)


def adb(*args, **kwargs):
    return subprocess.check_output(["adb", *args], timeout=30, **kwargs)


def hierarchy():
    adb("shell", "uiautomator", "dump", "/sdcard/lofold-ui.xml")
    xml = adb("exec-out", "cat", "/sdcard/lofold-ui.xml")
    (ARTIFACTS / "last-ui.xml").write_bytes(xml)
    return ET.fromstring(xml)


def find(root, *labels):
    for label in labels:
        for node in root.iter("node"):
            if label in (node.get("text"), node.get("content-desc"), node.get("resource-id")):
                if node.get("enabled") == "true" and node.get("bounds") != "[0,0][0,0]":
                    return node
    return None


def wait_for(*labels, seconds=40):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        try:
            root = hierarchy()
        except (ET.ParseError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            time.sleep(1)
            continue
        if find(root, "Pixel Launcher isn't responding") is not None:
            close = find(root, "android:id/aerr_close")
            if close is not None:
                tap(close)
                continue
        node = find(root, *labels)
        if node is not None:
            return node
        time.sleep(1)
    raise RuntimeError(f"View missing: {labels}")


def tap(node):
    x0, y0, x1, y1 = map(int, re.findall(r"\d+", node.attrib["bounds"]))
    adb("shell", "input", "tap", str((x0+x1)//2), str((y0+y1)//2))
    time.sleep(0.6)


def archive():
    adb("shell", "am", "start", "-W", "-n", APP + "/.MainActivity")
    nav = wait_for("本机归档", "邮箱导航", seconds=150)
    tap(nav)
    if nav.attrib.get("text") != "本机归档" and nav.attrib.get("content-desc") != "本机归档":
        tap(wait_for("本机归档"))
    wait_for("导入 EML")


def picker():
    tap(wait_for("导入 EML"))
    root = hierarchy()
    entry = find(root, NAME)
    if entry is None:
        menu = find(root, "Show roots", "Open navigation drawer", "显示根目录", "com.android.documentsui:id/toolbar")
        if menu is None or menu.get("resource-id", "").endswith("/toolbar"):
            adb("shell", "input", "keyevent", "82")
        else:
            tap(menu)
        tap(wait_for("Downloads", "下载", "Download"))
        entry = wait_for(NAME)
    tap(entry)


def screenshot(name):
    (ARTIFACTS / name).write_bytes(adb("exec-out", "screencap", "-p"))


try:
    fixture = ARTIFACTS / NAME
    fixture.write_bytes((
        f"From: sender@example.invalid\r\nTo: archive@example.invalid\r\nSubject: {TITLE}\r\n"
        f"Message-ID: <{TITLE}@example.invalid>\r\nDate: Mon, 23 Nov 2026 08:00:00 +0000\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n\r\nSynthetic Android archive test.\r\n"
    ).encode())
    adb("push", str(fixture), "/sdcard/Download/" + NAME)
    adb("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
        "-d", "file:///sdcard/Download/" + NAME)
    archive()
    picker()
    wait_for(TITLE)
    screenshot("imported.png")
    adb("shell", "am", "force-stop", APP)
    archive()
    root = hierarchy()
    search = find(root, "搜索邮件", "搜索当前范围")
    if search is None:
        search = root.find('.//node[@class="android.widget.EditText"]')
    if search is None:
        raise RuntimeError("Search field missing")
    tap(search)
    adb("shell", "input", "text", TITLE)
    wait_for(TITLE)
    screenshot("reopened-search.png")
    # The AVD is rooted for this at-rest check, while the installed client is a release APK.
    db = adb("shell", "find", "/data/user/0/" + APP, "-name", "archive.sqlite3", text=True).strip()
    if not db or "\n" in db:
        raise RuntimeError("Expected one private archive")
    content = adb("exec-out", "cat", db)
    if len(content) < 4096 or content.startswith(b"SQLite format 3") or TITLE.encode() in content:
        raise RuntimeError("Archive plaintext/size check failed")
    print(f"PASS Android picker import, restart, search, SQLCipher header and plaintext checks ({len(content)} bytes).")
except Exception:
    screenshot("failure.png")
    raise
