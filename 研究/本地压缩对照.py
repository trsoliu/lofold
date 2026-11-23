"""对确定性合成样本做本机无损压缩/恢复对照；只通过标准输入输出调用工具。"""
import hashlib
import io
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import zipfile
import zlib
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from pathlib import Path


BLOCK_BYTES = 256 * 1024


def command(arguments, payload):
    return subprocess.run(arguments, input=payload, capture_output=True, check=True).stdout


def make_jpeg():
    width, height = 640, 480
    noise = hashlib.shake_256(b"synthetic-mail-texture-v1").digest(width * height)
    pixels = bytearray()
    for index, sample in enumerate(noise):
        y, x = divmod(index, width)
        grain = (sample - 128) // 2
        for base in (48 + x * 150 // width, 52 + y * 148 // height, 64 + (x + y) % 110):
            pixels.append(max(0, min(255, base + grain)))
    ppm = f"P6\n{width} {height}\n255\n".encode() + pixels
    return command(["cjpeg", "-quality", "85", "-baseline"], ppm)


def stream_object(options, body):
    return b"<<" + options + b" /Length " + str(len(body)).encode() + b" >>\nstream\n" + body + b"\nendstream"


def make_pdf(content, jpeg=None):
    """构造完整的一页 PDF；文本样本保留未压内容流，图片样本保留 DCT 码流。"""
    resources = b"/Font << /F1 5 0 R >>" if jpeg is None else b"/XObject << /Im1 5 0 R >>"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 480] /Contents 4 0 R /Resources <<" + resources + b">> >>",
        stream_object(b"", content),
    ]
    if jpeg is None:
        objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    else:
        objects.append(stream_object(b"/Type /XObject /Subtype /Image /Width 640 /Height 480 "
                                     b"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", jpeg))
    result = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for idx, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f"{idx} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(result)
    result.extend(f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        result.extend(f"{offset:010d} 00000 n \n".encode())
    result.extend(f"trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(result)


def make_eml(body, attachment=None):
    msg = EmailMessage(policy=policy.SMTP)
    msg["From"] = "sender@example.test"
    msg["To"] = "reader@example.test"
    msg["Subject"] = "合成样本：确认十二月的行程"
    msg["Date"] = "Fri, 20 Nov 2026 08:00:00 +0000"
    msg.set_content(body, cte="8bit")
    if attachment is not None:
        msg.add_attachment(attachment, maintype="image", subtype="jpeg",
                           filename="合成现场图.jpg", cte="base64")
        msg.set_boundary("synthetic-mail-storage-20261120")
    raw = msg.as_bytes()
    if attachment is not None:
        decoded, = BytesParser(policy=policy.default).parsebytes(raw).iter_attachments()
        if decoded.get_payload(decode=True) != attachment:
            raise ValueError("合成 EML 附件与独立 JPEG 不一致")
    return raw


def fixtures():
    jpeg = make_jpeg()
    body = "\n".join(f"第 {i:02d} 项预订已确认，日期为十二月 {i % 28 + 1} 日，"
                     f"请在出发前核对车次 {310 + i * 7} 和座位 {i % 15 + 1} 排。"
                     for i in range(1, 25))
    csv = "序号,日期,类别,金额\r\n" + "".join(
        f"{i},2026-11-{i % 28 + 1:02d},{('车票','文具','餐饮','快递')[i % 4]},{(i * 79) % 3000}.50\r\n"
        for i in range(1, 16001))
    pdf_text = b"BT /F1 8 Tf 24 460 Td 11 TL\n" + b"".join(
        f"(Synthetic line {i:02d} - item {i * 31}, amount {i * 7}.50) Tj T*\n".encode()
        for i in range(1, 40)) + b"ET\n"
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w") as archive:
        info = zipfile.ZipInfo("synthetic.bin", (2026, 11, 20, 8, 0, 0))
        info.create_system = 3
        archive.writestr(info, hashlib.shake_256(b"synthetic-zip-v1").digest(96 * 1024),
                         compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
    return [
        ("中文纯文本 EML", make_eml(body)),
        ("带 JPEG 的 base64 EML", make_eml("请查看合成图片。", jpeg)),
        ("中文 CSV", csv.encode()),
        ("未压内容流 PDF", make_pdf(pdf_text)),
        ("内嵌 JPEG 的 PDF", make_pdf(b"q 640 0 0 480 0 0 cm /Im1 Do Q\n", jpeg)),
        ("独立 JPEG", jpeg),
        ("DEFLATE ZIP", zip_buffer.getvalue()),
        ("短文本", "收悉。".encode()),
    ]


def verify(original, restored, name):
    if restored != original or hashlib.sha256(restored).digest() != hashlib.sha256(original).digest():
        raise ValueError(f"{name} 未通过字节还原验证")


def zstd_frame(raw, level):
    return command(["zstd", "-q", "-c", f"-{level}", "-T1", "--check"], raw)


def adaptive(raw):
    """只返回载荷；示例旁路识别独立 JPEG 和 ZIP，PDF 和原始 EML 均参与试压。"""
    bypass = raw.startswith((b"\xff\xd8\xff", b"PK\x03\x04"))
    blocks = []
    for start in range(0, len(raw), BLOCK_BYTES):
        block = raw[start:start + BLOCK_BYTES]
        if not bypass and len(block) >= 1024:
            packed = zstd_frame(block, 3)
            needed = max(64, (len(block) + 99) // 100)
            if len(block) - len(packed) >= needed:
                blocks.append(("zstd", packed))
                continue
        blocks.append(("raw", block))
    return blocks


def restore(blocks):
    return b"".join(data if codec == "raw" else command(["zstd", "-q", "-d", "-c"], data)
                    for codec, data in blocks)


def allocated_pair(raw, blocks):
    """在本机临时目录测两个独立载荷文件的已分配块；对象封装、数据库等未计入。"""
    with tempfile.TemporaryDirectory(prefix="mail-compression-") as directory:
        allocated = []
        for name, parts in (("raw", [raw]), ("adaptive", [data for _, data in blocks])):
            path = Path(directory) / name
            with path.open("wb") as file:
                for part in parts:
                    file.write(part)
                file.flush()
                os.fsync(file.fileno())
            stat_blocks = getattr(path.stat(), "st_blocks", None)
            allocated.append(str(stat_blocks * 512) if stat_blocks is not None else "不可用")
        return "→".join(allocated)


def main():
    for binary in ("cjpeg", "zstd"):
        if not shutil.which(binary):
            sys.exit(f"未找到 {binary}，请准备 libjpeg-turbo 与 Zstandard 命令行工具")
    print(f"Python {platform.python_version()} / {platform.system()} {platform.machine()} / zlib {zlib.ZLIB_RUNTIME_VERSION}")
    for args in (["zstd", "--version"], ["cjpeg", "-version"]):
        version = subprocess.run(args, capture_output=True, text=True, check=True)
        print((version.stdout + version.stderr).strip())
    print("样本\t原始 B\tZstd-1 B\tZstd-3 B\tZstd-6 B\tzlib-6 B\t自适应 B\t压/原块\t自适应节省率\t分配 B 原→自适应\t原件 SHA-256")
    for name, raw in fixtures():
        sizes = []
        for level in (1, 3, 6):
            packed = zstd_frame(raw, level)
            verify(raw, command(["zstd", "-q", "-d", "-c"], packed), name)
            sizes.append(len(packed))
        packed = zlib.compress(raw, 6)
        verify(raw, zlib.decompress(packed), name)
        blocks = adaptive(raw)
        verify(raw, restore(blocks), name)
        compressed = sum(codec == "zstd" for codec, _ in blocks)
        stored_size = sum(len(data) for _, data in blocks)
        saving = (1 - stored_size / len(raw)) * 100
        print(name, len(raw), *sizes, len(packed), stored_size,
              f"{compressed}/{len(blocks) - compressed}", f"{saving:.2f}%", allocated_pair(raw, blocks),
              hashlib.sha256(raw).hexdigest(), sep="\t")
    mixed = b"A" * BLOCK_BYTES + hashlib.shake_256(b"mixed").digest(BLOCK_BYTES) + b"B" * 512
    blocks = adaptive(mixed)
    if [codec for codec, _ in blocks] != ["zstd", "raw", "raw"]:
        raise ValueError("跨块样本的决策异常")
    verify(mixed, restore(blocks), "跨块样本")
    print("跨块断言通过：可压块、不可压块、小尾块分别使用 zstd、原样、原样。")


if __name__ == "__main__":
    main()
