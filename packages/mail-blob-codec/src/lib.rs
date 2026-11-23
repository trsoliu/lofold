//! 邮件原件和文件共用的无损存储块。最大原始块为 256 KiB，最后一块可更短。
//!
//! v1 块头为 `MB`、版本字节 1、编码字节（0 原样、1 Zstandard）、原始字节数和
//! 负载字节数（两个小端 u32）。其后紧跟一块负载。Zstandard 负载为单个无字典、
//! 有已知内容长度的标准帧；窗口最多 256 KiB。写入器使用级别 3。
//!
//! 上层须把整个记录及对象/块身份纳入认证加密，读取时先验证身份与认证标签，
//! 再调用解码。调用方负责按序重组、检查总长度和原件摘要。本组件不修改原信，
//! 也不将任何中间数据写入文件。

use std::io::{self, ErrorKind};

pub const MAX_BLOCK_BYTES: usize = 256 * 1024;
pub const HEADER_BYTES: usize = 12;
const MIN_COMPRESS_BYTES: usize = 1024;
const MAGIC: &[u8; 2] = b"MB";
const VERSION: u8 = 1;
const RAW: u8 = 0;
const ZSTD: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressionHint {
    /// 试压达到门槛的块，收益不足则保留原样。
    Auto,
    /// 上层已确认该独立文件是压缩媒体或归档，跳过试压。
    AlreadyCompressed,
}

fn invalid_data(message: &'static str) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, message)
}

fn worthwhile(raw_len: usize, compressed_len: usize) -> bool {
    let minimum_saving = 64.max(raw_len.div_ceil(100));
    compressed_len.saturating_add(minimum_saving) <= raw_len
}

/// 将一块原始字节编码为带版本的块记录。原样和压缩记录使用相同大小的头。
pub fn encode_block(bytes: &[u8], hint: CompressionHint) -> io::Result<Vec<u8>> {
    if bytes.len() > MAX_BLOCK_BYTES {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "原始块超过 256 KiB",
        ));
    }
    let mut codec = RAW;
    let mut payload = bytes;
    let candidate;
    if hint == CompressionHint::Auto && bytes.len() >= MIN_COMPRESS_BYTES {
        candidate = zstd::bulk::compress(bytes, 3)?;
        if worthwhile(bytes.len(), candidate.len()) {
            codec = ZSTD;
            payload = &candidate;
        }
    }

    let mut record = Vec::with_capacity(HEADER_BYTES + payload.len());
    record.extend_from_slice(MAGIC);
    record.push(VERSION);
    record.push(codec);
    record.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    record.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    record.extend_from_slice(payload);
    Ok(record)
}

/// 解码一条完整且已经认证的记录。一次只处理一块，拒绝截断、尾随数据和未知编码。
pub fn decode_block(record: &[u8]) -> io::Result<Vec<u8>> {
    let header: &[u8; HEADER_BYTES] = record
        .get(..HEADER_BYTES)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| invalid_data("块头不完整"))?;
    if &header[..2] != MAGIC {
        return Err(invalid_data("块标识不匹配"));
    }
    if header[2] != VERSION {
        return Err(io::Error::new(ErrorKind::Unsupported, "未知块版本"));
    }
    let raw_len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    let stored_len = u32::from_le_bytes([header[8], header[9], header[10], header[11]]) as usize;
    let payload = &record[HEADER_BYTES..];
    if raw_len > MAX_BLOCK_BYTES || stored_len > MAX_BLOCK_BYTES || payload.len() != stored_len {
        return Err(invalid_data("块长度不符或超过 256 KiB"));
    }
    match header[3] {
        RAW if stored_len == raw_len => Ok(payload.to_vec()),
        RAW => Err(invalid_data("原样块的两项长度不符")),
        ZSTD => decode_zstd(payload, raw_len),
        _ => Err(io::Error::new(ErrorKind::Unsupported, "未知块编码")),
    }
}

fn decode_zstd(frame: &[u8], raw_len: usize) -> io::Result<Vec<u8>> {
    let [0x28, 0xb5, 0x2f, 0xfd, descriptor, rest @ ..] = frame else {
        return Err(invalid_data("需要标准 Zstandard 帧"));
    };
    // RFC 8878 §3.1.1.1。最高允许的窗口描述符 0x40 对应 2^18 字节。
    // 单段帧的窗口由下方校验的内容长度限定。
    let has_window = descriptor & 0x20 == 0;
    if descriptor & 0x03 != 0 || (has_window && !matches!(rest.first(), Some(0..=0x40))) {
        return Err(invalid_data("帧包含字典标识、过大的窗口或不完整的窗口字段"));
    }
    if zstd::zstd_safe::get_frame_content_size(frame).ok() != Some(Some(raw_len as u64)) {
        return Err(invalid_data("帧内容长度不符"));
    }
    if zstd::zstd_safe::find_frame_compressed_size(frame).ok() != Some(frame.len()) {
        return Err(invalid_data("需要一条完整帧，无尾随数据"));
    }
    let mut output = vec![0; raw_len];
    let actual = zstd::bulk::decompress_to_buffer(frame, &mut output[..])
        .map_err(|_| invalid_data("Zstandard 解码失败"))?;
    if actual != raw_len {
        return Err(invalid_data("解码结果长度不符"));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(bytes: &[u8]) -> Vec<u8> {
        encode_block(bytes, CompressionHint::Auto).unwrap()
    }

    #[test]
    fn raw_record_has_stable_header_and_round_trips_binary() {
        let original = b"\0\r\n\xff";
        let stored = encode(original);
        assert_eq!(&stored[..HEADER_BYTES], b"MB\x01\x00\x04\0\0\0\x04\0\0\0");
        assert_eq!(decode_block(&stored).unwrap(), original);
        assert_eq!(decode_block(&encode(b"")).unwrap(), b"");
    }

    #[test]
    fn round_trips_chinese_mail_and_maximum_size() {
        let original = "Subject: 预算\r\n\r\n出差报销与明细\r\n".repeat(200);
        for bytes in [original.as_bytes(), &[b'a'; MAX_BLOCK_BYTES][..]] {
            let record = encode(bytes);
            assert_eq!(record[3], ZSTD);
            assert_eq!(decode_block(&record).unwrap(), bytes);
        }
        assert!(encode_block(&vec![0; MAX_BLOCK_BYTES + 1], CompressionHint::Auto).is_err());
    }

    #[test]
    fn skips_small_precompressed_and_incompressible_inputs() {
        assert_eq!(encode(&[7; MIN_COMPRESS_BYTES - 1])[3], RAW);
        assert_eq!(encode(&[7; MIN_COMPRESS_BYTES])[3], ZSTD);
        let skipped = encode_block(&[7; 8192], CompressionHint::AlreadyCompressed).unwrap();
        assert_eq!(skipped[3], RAW);
        let mut state: u32 = 0x5ca1_ab1e;
        let sample: Vec<u8> = (0..8192)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as u8
            })
            .collect();
        let record = encode(&sample);
        assert_eq!(record[3], RAW);
        assert_eq!(decode_block(&record).unwrap(), sample);
    }

    #[test]
    fn requires_both_absolute_and_percentage_savings() {
        assert!(worthwhile(1024, 960));
        assert!(!worthwhile(1024, 961));
        assert!(worthwhile(10_001, 9900));
        assert!(!worthwhile(10_001, 9901));
    }

    #[test]
    fn reads_a_v1_record_using_a_reference_cli_frame() {
        // 官方 zstd 1.5.7，使用命令 zstd -3 --no-check 压缩 4096 个 ASCII A。
        let record = [
            0x4d, 0x42, 0x01, 0x01, 0x00, 0x10, 0x00, 0x00, 0x13, 0x00, 0x00, 0x00, 0x28, 0xb5,
            0x2f, 0xfd, 0x60, 0x00, 0x0f, 0x4d, 0x00, 0x00, 0x10, 0x41, 0x41, 0x01, 0x00, 0xfb,
            0xf7, 0x01, 0x16,
        ];
        assert_eq!(decode_block(&record).unwrap(), vec![b'A'; 4096]);
    }

    #[test]
    fn rejects_unknown_versions_codecs_and_inconsistent_lengths() {
        let record = encode(b"raw");
        assert!(decode_block(&record[..HEADER_BYTES - 1]).is_err());
        for offset in [0, 2, 3, 4, 8] {
            let mut bad = record.clone();
            bad[offset] ^= 0xff;
            assert!(decode_block(&bad).is_err());
        }
        for length_offset in [4, 8] {
            let mut bad = record.clone();
            bad[length_offset..length_offset + 4].copy_from_slice(&u32::MAX.to_le_bytes());
            assert!(decode_block(&bad).is_err());
        }
        assert!(decode_block(&record[..record.len() - 1]).is_err());
    }

    #[test]
    fn rejects_truncated_and_concatenated_frames_even_with_adjusted_payload_header() {
        let record = encode(&[42; 2048]);
        let payload = &record[HEADER_BYTES..];
        let mut doubled = payload.to_vec();
        doubled.extend_from_slice(payload);
        for invalid_payload in [&payload[..payload.len() - 1], doubled.as_slice()] {
            let mut invalid = record[..HEADER_BYTES].to_vec();
            invalid[8..12].copy_from_slice(&(invalid_payload.len() as u32).to_le_bytes());
            invalid.extend_from_slice(invalid_payload);
            assert!(decode_block(&invalid).is_err());
        }
        let mut wrong_size = record;
        wrong_size[4..8].copy_from_slice(&2049_u32.to_le_bytes());
        assert!(decode_block(&wrong_size).is_err());
    }

    #[test]
    fn rejects_oversized_window_dictionary_and_skippable_frames() {
        let record = encode(&[42; 4096]);
        let mut window = record.clone();
        window[HEADER_BYTES + 4] &= !0x20;
        window[HEADER_BYTES + 5] = 0xff;
        assert!(decode_block(&window).is_err());
        let mut dictionary = record.clone();
        dictionary[HEADER_BYTES + 4] |= 0x01;
        assert!(decode_block(&dictionary).is_err());
        let mut skippable = record;
        skippable[HEADER_BYTES..HEADER_BYTES + 4].copy_from_slice(&[0x50, 0x2a, 0x4d, 0x18]);
        assert!(decode_block(&skippable).is_err());
    }
}
