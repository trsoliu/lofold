use base64::{engine::general_purpose::STANDARD, Engine};
use mail_parser::Message;
use serde::Serialize;
use std::collections::BTreeMap;

const MAX_HTML_BYTES: usize = 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_INLINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_INLINE_PIXELS: u64 = 12_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RichBody {
    html: String,
    inline_images: BTreeMap<String, String>,
}

// Only content selected by the MIME parser for this message's body is eligible.
// HTML remains untrusted until the reader constructs its allowlisted document.
pub(super) fn extract(message: &Message<'_>) -> Option<RichBody> {
    if !message
        .html_body()
        .any(|part| part.is_content_type("text", "html"))
    {
        return None;
    }
    let mut html = String::new();
    for part in message.html_bodies() {
        if html.len() + part.len() + 1 > MAX_HTML_BYTES {
            return None;
        }
        html.push_str(&part);
        html.push('\n');
    }
    let mut inline_images = BTreeMap::new();
    let mut bytes_left = MAX_INLINE_BYTES;
    let mut pixels_left = MAX_INLINE_PIXELS;
    for part in message.parts() {
        let Some(id) = part.content_id() else {
            continue;
        };
        if inline_images.len() >= 32 || bytes_left == 0 || pixels_left == 0 {
            break;
        }
        let id = id.trim().trim_matches(['<', '>']);
        if id.is_empty()
            || id.len() > 255
            || inline_images.contains_key(id)
            || part.decoded_len() > MAX_IMAGE_BYTES.min(bytes_left)
        {
            continue;
        }
        let png = part.is_content_type("image", "png");
        if !png && !part.is_content_type("image", "jpeg") {
            continue;
        }
        let (bytes, problems) = part.decoded_checked();
        if !problems.is_empty() {
            continue;
        }
        let Some((w, h)) = dimensions(&bytes, png) else {
            continue;
        };
        let pixels = u64::from(w) * u64::from(h);
        if pixels == 0 || pixels > pixels_left || w > 8192 || h > 8192 {
            continue;
        }
        let mime = if png { "image/png" } else { "image/jpeg" };
        inline_images.insert(
            id.to_owned(),
            format!("data:{mime};base64,{}", STANDARD.encode(&bytes)),
        );
        pixels_left -= pixels;
        bytes_left -= bytes.len();
    }
    Some(RichBody {
        html,
        inline_images,
    })
}

fn dimensions(bytes: &[u8], png: bool) -> Option<(u32, u32)> {
    if png {
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR") {
            return None;
        }
        return Some((
            u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?),
            u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?),
        ));
    }
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut i = 2;
    while bytes.get(i) == Some(&0xff) {
        i += 1;
        while bytes.get(i) == Some(&0xff) {
            i += 1;
        }
        let marker = *bytes.get(i)?;
        i += 1;
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        let field = |offset| -> Option<u16> {
            Some(u16::from_be_bytes(
                bytes.get(offset..offset + 2)?.try_into().ok()?,
            ))
        };
        let size = usize::from(field(i)?);
        if size < 2 || i + size > bytes.len() {
            return None;
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) && size >= 8 {
            return Some((field(i + 5)?.into(), field(i + 3)?.into()));
        }
        i += size;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use mail_parser::MessageParser;

    #[test]
    fn alternatives_and_local_image_parts() {
        let mime = concat!("From: a@example.test\r\nContent-Type: multipart/related; boundary=b\r\n\r\n",
            "--b\r\nContent-Type: text/html\r\n\r\n<table><tr><td>Grid</td></tr></table><img src='cid:x'>\r\n",
            "--b\r\nContent-Type: image/png\r\nContent-ID: <x>\r\nContent-Transfer-Encoding: base64\r\n\r\n",
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/9ioAAAAASUVORK5CYII=\r\n",
            "--b\r\nContent-Type: image/svg+xml\r\nContent-ID: <svg>\r\n\r\n<svg/>\r\n--b--\r\n");
        let message = MessageParser::default().parse(mime.as_bytes()).unwrap();
        let rich = extract(&message).unwrap();
        assert!(rich.html.contains("<table>"));
        assert_eq!(rich.inline_images.len(), 1);
        assert!(rich.inline_images["x"].starts_with("data:image/png;base64,"));
        let plain = MessageParser::default()
            .parse(b"From: a@example.test\r\n\r\nplain")
            .unwrap();
        assert!(extract(&plain).is_none());
    }
}
