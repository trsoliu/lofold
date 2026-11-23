// Local, versioned export format. All bit indices are MSB-first in the blue
// channel of distinct pixels. AES-GCM authenticates both the address packet
// and the original image samples, ignoring only those selected low bits.
use std::{collections::HashSet, io::Cursor};

use png::{BitDepth, ColorType};
use ring::{
    aead, digest, hkdf, hmac,
    rand::{SecureRandom, SystemRandom},
};
use zeroize::Zeroizing;

pub(super) const MAX_PNG_BYTES: usize = 128 * 1024 * 1024;
const MAX_PIXELS: usize = 32_000_000;
const MAX_SIDE: u32 = 32768;
const MAX_ADDRESS: usize = 254;
const PLAIN_LEN: usize = 2 + MAX_ADDRESS; // version, UTF-8 byte count, padded address
const NONCE_LEN: usize = 12;
const SEALED_LEN: usize = PLAIN_LEN + 16;
const REQUIRED_PIXELS: usize = (NONCE_LEN + SEALED_LEN) * 8;
const FORMAT: &[u8] = b"LoFold PNG account watermark v1";

pub(super) fn derive_key(archive_key: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, FORMAT);
    let prk = salt.extract(archive_key);
    let mut result = Zeroizing::new([0u8; 32]);
    prk.expand(&[b"archive watermark master"], hkdf::HKDF_SHA256)
        .expect("one SHA-256 block is a valid HKDF length")
        .fill(result.as_mut())
        .expect("the output buffer is exactly one SHA-256 block");
    result
}

struct Image {
    info: png::Info<'static>,
    pixels: Vec<u8>,
}

impl Image {
    fn open(bytes: &[u8]) -> Result<Option<Self>, String> {
        if bytes.len() > MAX_PNG_BYTES {
            return Err("PNG 文件超过 128 MiB 上限。".into());
        }
        let invalid = |_| "无法读取完整的 PNG 图片。".to_owned();
        let mut decoder = png::Decoder::new_with_limits(
            Cursor::new(bytes),
            png::Limits {
                bytes: 16 * 1024 * 1024,
            },
        );
        decoder.set_ignore_text_chunk(true);
        let header = decoder.read_header_info().map_err(invalid)?;
        let count = u64::from(header.width) * u64::from(header.height);
        if count > MAX_PIXELS as u64 || header.width > MAX_SIDE || header.height > MAX_SIDE {
            return Err("PNG 超过 3200 万像素或单边尺寸上限。".into());
        }
        // Native RGB/RGBA exports are 8-bit. EXPAND also lets a lossless
        // palette optimization decode back into the same RGB sample values.
        if header.bit_depth == BitDepth::Sixteen {
            return Ok(None);
        }
        decoder.set_transformations(png::Transformations::EXPAND);
        let mut reader = decoder.read_info().map_err(invalid)?;
        let (color, depth) = reader.output_color_type();
        let source = reader.info();
        if source.animation_control.is_some() || !matches!(color, ColorType::Rgb | ColorType::Rgba)
        {
            return Ok(None);
        }
        let required = (count as usize) * color.samples();
        if depth != BitDepth::Eight || reader.output_buffer_size() != Some(required) {
            return Err("PNG 像素格式无效。".into());
        }
        // Preserve color management, without copying text, EXIF or application metadata.
        let mut info = png::Info::with_size(source.width, source.height);
        info.color_type = color;
        info.bit_depth = depth;
        info.source_gamma = source.source_gamma;
        info.source_chromaticities = source.source_chromaticities;
        info.srgb = source.srgb;
        info.icc_profile = source.icc_profile.clone();
        info.coding_independent_code_points = source.coding_independent_code_points;
        info.mastering_display_color_volume = source.mastering_display_color_volume;
        info.content_light_level = source.content_light_level;
        info.pixel_dims = source.pixel_dims;
        let mut pixels = vec![0; required];
        if reader
            .next_frame(&mut pixels)
            .map_err(invalid)?
            .buffer_size()
            != required
        {
            return Err("PNG 像素数据不完整。".into());
        }
        reader.finish().map_err(invalid)?;
        Ok(Some(Self { info, pixels }))
    }

    fn encode(&self) -> Result<Vec<u8>, String> {
        let failed = |_| "无法编码带水印的 PNG 图片。".to_owned();
        let mut output = Vec::new();
        let mut encoder =
            png::Encoder::with_info(&mut output, self.info.clone()).map_err(failed)?;
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(failed)?;
        writer.write_image_data(&self.pixels).map_err(failed)?;
        writer.finish().map_err(failed)?;
        if output.len() > MAX_PNG_BYTES {
            return Err("编码后的 PNG 超过 128 MiB 上限。".into());
        }
        Ok(output)
    }

    fn count(&self) -> usize {
        self.pixels.len() / self.info.color_type.samples()
    }

    fn geometry(&self) -> [u8; 9] {
        let mut result = [0; 9];
        result[..4].copy_from_slice(&self.info.width.to_be_bytes());
        result[4..8].copy_from_slice(&self.info.height.to_be_bytes());
        result[8] = self.info.color_type as u8;
        result
    }

    fn authenticated_image(&self, positions: &HashSet<usize>) -> digest::Digest {
        let mut offsets: Vec<_> = positions
            .iter()
            .map(|p| p * self.info.color_type.samples() + 2)
            .collect();
        offsets.sort_unstable();
        let mut hash = digest::Context::new(&digest::SHA256);
        hash.update(FORMAT);
        hash.update(&self.geometry());
        let mut start = 0;
        for offset in offsets {
            hash.update(&self.pixels[start..offset]);
            hash.update(&[self.pixels[offset] & !1]);
            start = offset + 1;
        }
        hash.update(&self.pixels[start..]);
        hash.finish()
    }

    fn read_bits<const N: usize>(&self, positions: &[usize]) -> [u8; N] {
        let mut result = [0; N];
        for (bit, &p) in positions.iter().enumerate() {
            let offset = p * self.info.color_type.samples() + 2;
            result[bit / 8] |= (self.pixels[offset] & 1) << (7 - bit % 8);
        }
        result
    }

    fn write_bits(&mut self, positions: &[usize], bytes: &[u8]) {
        for (bit, &p) in positions.iter().enumerate() {
            let offset = p * self.info.color_type.samples() + 2;
            self.pixels[offset] =
                (self.pixels[offset] & !1) | ((bytes[bit / 8] >> (7 - bit % 8)) & 1);
        }
    }
}

struct Locations {
    key: hmac::Key,
    geometry: [u8; 9],
    count: u32,
    occupied: HashSet<usize>,
}

impl Locations {
    fn new(image: &Image, key: &[u8; 32]) -> Self {
        Self {
            key: hmac::Key::new(hmac::HMAC_SHA256, key),
            geometry: image.geometry(),
            count: image.count() as u32,
            occupied: HashSet::with_capacity(REQUIRED_PIXELS),
        }
    }

    // Rejection sampling picks distinct uniformly distributed pixels. A fresh
    // nonce also changes the payload positions on repeated exports of one image.
    fn take(&mut self, label: &[u8], nonce: &[u8], n: usize) -> Vec<usize> {
        let mut seed = hmac::Context::with_key(&self.key);
        seed.update(FORMAT);
        seed.update(label);
        seed.update(&self.geometry);
        seed.update(nonce);
        let upper = u32::MAX - (u32::MAX % self.count);
        let mut selected = Vec::with_capacity(n);
        for counter in 0u32.. {
            let mut block = seed.clone();
            block.update(&counter.to_be_bytes());
            for word in block.sign().as_ref().chunks_exact(4) {
                let random = u32::from_be_bytes(word.try_into().expect("four bytes"));
                if random < upper {
                    let index = (random % self.count) as usize;
                    if self.occupied.insert(index) {
                        selected.push(index);
                        if selected.len() == n {
                            return selected;
                        }
                    }
                }
            }
        }
        unreachable!("HMAC counter space exhausted")
    }
}

fn cipher(key: &[u8; 32]) -> aead::LessSafeKey {
    let root = hmac::Key::new(hmac::HMAC_SHA256, key);
    let encryption = hmac::sign(&root, b"LoFold PNG account watermark v1 / AES-256-GCM");
    aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, encryption.as_ref())
            .expect("HMAC-SHA-256 supplies a 32-byte AES key"),
    )
}

fn valid_address(address: &str) -> bool {
    address.len() <= MAX_ADDRESS
        && !address.chars().any(|c| c.is_control() || c.is_whitespace())
        && address
            .rsplit_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && !domain.is_empty())
}

pub(super) fn embed_png(png: &[u8], address: &str, key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if !valid_address(address) {
        return Err("邮箱账号地址不适合写入水印。".into());
    }
    let mut image = Image::open(png)?.ok_or("此 PNG 像素格式不支持写入水印。")?;
    if image.count() < REQUIRED_PIXELS {
        return Err("PNG 像素不足，无法写入水印。".into());
    }
    let mut nonce = [0; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| "无法生成水印随机数。")?;
    let mut locations = Locations::new(&image, key);
    let header = locations.take(b"nonce", &[], NONCE_LEN * 8);
    let payload = locations.take(b"payload", &nonce, SEALED_LEN * 8);
    let fingerprint = image.authenticated_image(&locations.occupied);
    let mut sealed = Zeroizing::new([0u8; SEALED_LEN]);
    sealed[0] = 1;
    sealed[1] = address.len() as u8;
    sealed[2..2 + address.len()].copy_from_slice(address.as_bytes());
    let tag = cipher(key)
        .seal_in_place_separate_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(fingerprint.as_ref()),
            &mut sealed[..PLAIN_LEN],
        )
        .map_err(|_| "无法加密水印。")?;
    sealed[PLAIN_LEN..].copy_from_slice(tag.as_ref());
    image.write_bits(&header, &nonce);
    image.write_bits(&payload, sealed.as_ref());
    image.encode()
}

pub(super) fn read_png(png: &[u8], key: &[u8; 32]) -> Result<Option<String>, String> {
    let Some(image) = Image::open(png)? else {
        return Ok(None);
    };
    if image.count() < REQUIRED_PIXELS {
        return Ok(None);
    }
    let mut locations = Locations::new(&image, key);
    let header = locations.take(b"nonce", &[], NONCE_LEN * 8);
    let nonce = image.read_bits::<NONCE_LEN>(&header);
    let payload = locations.take(b"payload", &nonce, SEALED_LEN * 8);
    let fingerprint = image.authenticated_image(&locations.occupied);
    let mut sealed = Zeroizing::new(image.read_bits::<SEALED_LEN>(&payload));
    let Ok(plain) = cipher(key).open_in_place(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(fingerprint.as_ref()),
        sealed.as_mut(),
    ) else {
        return Ok(None);
    };
    let len = usize::from(plain[1]);
    if plain[0] != 1 || len > MAX_ADDRESS {
        return Ok(None);
    }
    Ok(std::str::from_utf8(&plain[2..2 + len])
        .ok()
        .filter(|address| valid_address(address))
        .map(str::to_owned))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(width: u32, height: u32, color: ColorType) -> Vec<u8> {
        let channels = color.samples();
        let pixels: Vec<u8> = (0..width as usize * height as usize * channels)
            .map(|i| ((i * 71 + i / 19) % 256) as u8)
            .collect();
        let mut output = Vec::new();
        let mut encoder = png::Encoder::new(&mut output, width, height);
        encoder.set_color(color);
        encoder.set_depth(BitDepth::Eight);
        encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
        encoder
            .add_text_chunk("Synthetic".into(), "discard this metadata".into())
            .unwrap();
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&pixels).unwrap();
        writer.finish().unwrap();
        output
    }

    #[test]
    fn authenticated_roundtrip_and_visible_sample_bounds() {
        let key = derive_key(&[0x71; 32]);
        assert_ne!(&*key, &[0x71; 32]);
        assert_eq!(&*key, &*derive_key(&[0x71; 32]));
        let account = "reader+模拟@example.test";
        for color in [ColorType::Rgb, ColorType::Rgba] {
            let source = fixture(109, 43, color);
            let encoded = embed_png(&source, account, &key).unwrap();
            assert_eq!(read_png(&encoded, &key).unwrap().as_deref(), Some(account));
            assert!(read_png(&encoded, &derive_key(&[0x52; 32]))
                .unwrap()
                .is_none());
            assert!(read_png(&source, &key).unwrap().is_none());
            assert_ne!(encoded, embed_png(&source, account, &key).unwrap());
            assert!(!encoded
                .windows(account.len())
                .any(|w| w == account.as_bytes()));
            assert!(!encoded.windows(21).any(|w| w == b"discard this metadata"));
            let original = Image::open(&source).unwrap().unwrap();
            let saved = Image::open(&encoded).unwrap().unwrap();
            assert_eq!(saved.geometry(), original.geometry());
            assert_eq!(saved.info.srgb, original.info.srgb);
            let mut changed = 0;
            for (i, (&a, &b)) in original.pixels.iter().zip(&saved.pixels).enumerate() {
                if a != b {
                    assert_eq!(i % color.samples(), 2);
                    assert_eq!(a ^ b, 1);
                    changed += 1;
                }
            }
            assert!((1..=REQUIRED_PIXELS).contains(&changed));
        }
    }

    #[test]
    fn rejects_tampering_with_payload_or_visible_content() {
        let key = derive_key(&[0x42; 32]);
        let encoded = embed_png(
            &fixture(87, 41, ColorType::Rgba),
            "local@example.test",
            &key,
        )
        .unwrap();
        let mut image = Image::open(&encoded).unwrap().unwrap();
        let mut locations = Locations::new(&image, &key);
        let nonce_positions = locations.take(b"nonce", &[], NONCE_LEN * 8);
        let nonce = image.read_bits::<NONCE_LEN>(&nonce_positions);
        let payload = locations.take(b"payload", &nonce, SEALED_LEN * 8);
        let bit_offset = payload[0] * image.info.color_type.samples() + 2;
        for offset in [bit_offset, 0, 3] {
            image.pixels[offset] ^= 1;
            assert!(read_png(&image.encode().unwrap(), &key).unwrap().is_none());
            image.pixels[offset] ^= 1;
        }
    }

    #[test]
    fn validates_format_limits_and_fixed_packet_capacity() {
        let key = [0x81; 32];
        let small = fixture(2, 2, ColorType::Rgb);
        assert!(embed_png(&small, "a@example.test", &key).is_err());
        assert!(read_png(&small, &key).unwrap().is_none());
        assert!(read_png(b"plain bytes", &key).is_err());
        let matching = fixture(REQUIRED_PIXELS as u32, 1, ColorType::Rgb);
        let long = format!("{}@example.test", "x".repeat(MAX_ADDRESS - 13));
        assert_eq!(long.len(), MAX_ADDRESS);
        let marked = embed_png(&matching, &long, &key).unwrap();
        assert_eq!(read_png(&marked, &key).unwrap(), Some(long.clone()));
        assert!(embed_png(&matching, &(long + "z"), &key).is_err());
        assert!(embed_png(&matching, "local\n@example.test", &key).is_err());
        assert!(read_png(&matching[..matching.len() / 2], &key).is_err());
        let wide = fixture(MAX_SIDE + 1, 1, ColorType::Rgb);
        assert!(read_png(&wide, &key).unwrap_err().contains("单边"));
        let mut oversized_header = Vec::new();
        png::Encoder::new(&mut oversized_header, 8000, 8000)
            .write_header()
            .unwrap();
        assert!(read_png(&oversized_header, &key)
            .unwrap_err()
            .contains("3200"));
        assert!(read_png(&vec![0; MAX_PNG_BYTES + 1], &key)
            .unwrap_err()
            .contains("128 MiB"));
        let gray = fixture(61, 61, ColorType::Grayscale);
        assert!(read_png(&gray, &key).unwrap().is_none());
    }
}
