"""Inspect the actual packaged resources and ARM64 native library before publication."""
import json
import struct
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as apk:
    for resource in ("assets/LICENSE", "assets/NOTICE"):
        if not apk.read(resource).strip():
            raise SystemExit(f"Empty {resource}")
    config = json.loads(apk.read("assets/tauri.conf.json"))
    if config["identifier"] != "org.lofold.client" or config["build"].get("devUrl"):
        raise SystemExit("Unexpected application identity or development URL")
    image = apk.read("lib/arm64-v8a/liblofold_client_lib.so")
    if image[:6] != b"\x7fELF\x02\x01":
        raise SystemExit("Expected a 64-bit little-endian native library")
    header = struct.unpack_from("<16sHHIQQQIHHHHHH", image)
    if header[2] != 183:
        raise SystemExit("Expected AArch64")
    table, entry_size, count = header[5], header[9], header[10]
    segments = [struct.unpack_from("<IIQQQQQQ", image, table + i * entry_size) for i in range(count)]
    alignment = [s[-1] for s in segments if s[0] == 1]
    if not alignment or min(alignment) < 16384:
        raise SystemExit(f"ELF load segments require 16 KiB or larger alignment: {alignment}")
    print(f'{config["productName"]} {config["version"]} release resources OK, ARM64 PT_LOAD alignment {alignment}.')
