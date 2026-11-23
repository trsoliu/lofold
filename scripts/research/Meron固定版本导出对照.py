"""核对 Meron v0.5.5 桌面 EML 导出逻辑。用法见 --help。"""

import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


SOURCE_COMMIT = "492f8ab1dc3e9a2cbc13570572d2546f894a2185"
FILE_HASHES = {
    "eml_export.go": "4b779b27e9697dbb444d9149e15374158ab40bbc3bd92b3f3a7e19a1208e4841",
    "eml_export_test.go": "8e14237a0dc742cdcd91cff9d19da63c982c56701e4b33636c74676a37ac4bd7",
    "mail.go": "9dba0bd6fef8b32681b79f7349bf77d47f5e53212d7003d75d219d76932fc35c",
}

CHINESE_CASE = r'''package main

import (
    "context"
    "crypto/sha256"
    "encoding/base64"
    "path/filepath"
    "testing"
)

func TestChineseEMLExactExport(t *testing.T) {
    subject := "十一月报销"
    encoded := base64.StdEncoding.EncodeToString([]byte(subject))
    raw := "From: demo@example.test\r\nSubject: =?UTF-8?B?" + encoded +
        "?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n报销发票\r\n"
    messages := map[uint32]string{1: raw, 2: "Subject: Another\r\n\r\nsecond"}
    sources := []emlExportSource{{Account: "synthetic", Folder: "INBOX", UIDs: []uint32{1, 2}}}
    output := filepath.Join(t.TempDir(), "out.zip")
    result, err := runEmlExport(context.Background(), sources, output, fakeEmlFetcher(messages, ""), func(int, int) {})
    if err != nil || result.Exported != 2 || result.Failed != 0 {
        t.Fatalf("export %v, error %v", result, err)
    }
    fileName := subject + ".eml"
    entry, found := zipEntries(t, output)[fileName]
    if !found {
        t.Fatalf("missing %q", fileName)
    }
    inputSum := sha256.Sum256([]byte(raw))
    if got := sha256.Sum256([]byte(entry)); got != inputSum {
        t.Fatalf("SHA-256 input %x vs exported %x", inputSum, got)
    }
    t.Logf("%s, SHA-256 %x", fileName, inputSum)
}
'''


def read_pinned_sources(root):
    sources = {}
    for filename, expected in FILE_HASHES.items():
        path = root / "desktop" / filename
        try:
            data = path.read_bytes()
        except OSError as error:
            raise SystemExit(f"读不到 {path}，请传入 Meron v0.5.5 源码根目录。") from error
        # Git 可按本机配置检出 CRLF。这三个文本文件的固定摘要使用 LF。
        data = data.replace(b"\r\n", b"\n")
        if hashlib.sha256(data).hexdigest() != expected:
            raise SystemExit(f"{path} 与固定版 v0.5.5 的内容不符，请检查输入目录。")
        sources[filename] = data.decode("utf-8").splitlines(keepends=True)
    return sources


def main():
    parser = argparse.ArgumentParser(
        description="用本机 Meron v0.5.5 源码和 Go 1.21+ 运行 8 个上游用例及 1 个中文原件用例。"
    )
    parser.add_argument("source_root", type=Path, help="上游源码树的根目录（包含 desktop/）")
    args = parser.parse_args()
    sources = read_pinned_sources(args.source_root)
    go = shutil.which("go")
    if not go:
        raise SystemExit("未找到 go，请使用有 Go 1.21 或以上版本的本机环境。")

    with tempfile.TemporaryDirectory(prefix="meron-eml-study-") as scratch:
        work = Path(scratch)
        export = sources["eml_export.go"]
        mail = sources["mail.go"]
        # 上游从 1 开始计行。取导入表中的标准库、20–43 行类型和常量、
        # 223–427 行导出流程，再从 mail.go 取 925–960 行文件名处理函数。
        harness = "".join(export[:15]) + '\t"unicode/utf8"\n)\n'
        harness += "".join(export[19:43] + export[222:427] + mail[924:960])
        (work / "export.go").write_text(harness, encoding="utf-8")
        # 前 235 行包括模拟取件器和八个上游用例。后续用例依赖桌面主程序。
        tests = "".join(sources["eml_export_test.go"][:235])
        (work / "upstream_test.go").write_text(tests, encoding="utf-8")
        (work / "chinese_test.go").write_text(CHINESE_CASE, encoding="utf-8")
        env = dict(
            os.environ,
            GO111MODULE="off", GOWORK="off", GOPROXY="off", GOSUMDB="off",
            GOTOOLCHAIN="local", GOFLAGS="", GOENV="off", CGO_ENABLED="0",
        )
        print(f"Meron v0.5.5 · {SOURCE_COMMIT} · 已核对三份固定源码", flush=True)
        print("用合成取件器检查导出函数，覆盖范围为本机文件和 ZIP 字节。", flush=True)
        result = subprocess.run([go, "test", "-v", "-count=1"], cwd=work, env=env)
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
