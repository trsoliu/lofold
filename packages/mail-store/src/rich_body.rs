use base64::{engine::general_purpose::STANDARD, Engine};
use mail_parser::{Message, MessagePart};
use serde::Serialize;
use std::collections::BTreeMap;

const MAX_HTML_BYTES: usize = 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_INLINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES: usize = 12 * 1024 * 1024;
const MAX_VIDEO_REFERENCES: usize = 16;
const MAX_INLINE_PIXELS: u64 = 12_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RichBody {
    html: String,
    inline_images: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    inline_videos: BTreeMap<String, VideoPart>,
}

#[derive(Clone, Copy, Serialize)]
struct VideoPart {
    ordinal: usize,
    mime: &'static str,
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
        if inline_images.len() >= 32 || bytes_left == 0 || pixels_left == 0 {
            break;
        }
        let aliases: Vec<_> = media_references(&part)
            .filter(|key| !inline_images.contains_key(*key))
            .collect();
        if aliases.is_empty()
            || part.decoded_len() > MAX_IMAGE_BYTES.min(bytes_left)
            || !["png", "jpeg", "gif", "webp"]
                .iter()
                .any(|kind| part.is_content_type("image", kind))
        {
            continue;
        }
        let (bytes, problems) = part.decoded_checked();
        if !problems.is_empty() {
            continue;
        }
        let Some((mime, pixels)) = mail_raster_info(&bytes) else {
            continue;
        };
        if pixels > pixels_left || !part.is_content_type("image", &mime["image/".len()..]) {
            continue;
        }
        let data = format!("data:{mime};base64,{}", STANDARD.encode(&bytes));
        for key in aliases {
            if inline_images.len() == 32 || bytes.len() > bytes_left {
                break;
            }
            bytes_left -= bytes.len();
            inline_images.insert(key.to_owned(), data.clone());
        }
        pixels_left -= pixels;
    }
    let mut inline_videos = BTreeMap::new();
    for (ordinal, part) in message.attachments().enumerate() {
        let Some(mime) = video_type(&part) else {
            continue;
        };
        for key in media_references(&part) {
            if inline_videos.len() == MAX_VIDEO_REFERENCES {
                break;
            }
            inline_videos
                .entry(key.to_owned())
                .or_insert(VideoPart { ordinal, mime });
        }
    }
    Some(RichBody {
        html,
        inline_images,
        inline_videos,
    })
}

fn media_references<'a>(part: &MessagePart<'a>) -> impl Iterator<Item = &'a str> {
    let id = part
        .content_id()
        .map(|value| value.trim().trim_matches(['<', '>']));
    let location = part
        .content_location()
        .map(str::trim)
        .filter(|value| Some(*value) != id);
    [id, location]
        .into_iter()
        .flatten()
        .filter(|key| !key.is_empty() && key.len() <= 2048 && !key.chars().any(char::is_control))
}

fn video_type(part: &MessagePart<'_>) -> Option<&'static str> {
    if !(12..=MAX_VIDEO_BYTES).contains(&part.decoded_len()) {
        return None;
    }
    if part.is_content_type("video", "mp4") {
        Some("video/mp4")
    } else if part.is_content_type("video", "webm") {
        Some("video/webm")
    } else {
        None
    }
}

pub(super) fn inline_video(
    message: &Message<'_>,
    ordinal: usize,
) -> Result<Vec<u8>, super::ArchiveError> {
    use super::ArchiveError;
    let part = message
        .attachments()
        .nth(ordinal)
        .ok_or(ArchiveError::MissingAttachment)?;
    let mime = video_type(&part).ok_or(ArchiveError::UnsupportedInlineVideo)?;
    if media_references(&part).next().is_none() {
        return Err(ArchiveError::UnsupportedInlineVideo);
    }
    let (bytes, problems) = part.decoded_checked();
    if !problems.is_empty() {
        return Err(ArchiveError::AttachmentEncoding);
    }
    let valid = match mime {
        "video/mp4" => {
            bytes.get(4..8) == Some(b"ftyp")
                && bytes.get(..4).is_some_and(|n| {
                    let length = u32::from_be_bytes(n.try_into().expect("box size is four bytes"));
                    length >= 16 && (length as usize) <= bytes.len()
                })
        }
        "video/webm" => {
            bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
                && bytes[..bytes.len().min(256)]
                    .windows(7)
                    .any(|value| value == b"\x42\x82\x84webm")
        }
        _ => false,
    };
    if !valid || bytes.len() > MAX_VIDEO_BYTES {
        return Err(ArchiveError::UnsupportedInlineVideo);
    }
    Ok(bytes.into_owned())
}

/// Supported raster MIME type and canvas size, shared by offline MIME and on-demand images.
pub fn mail_raster_info(bytes: &[u8]) -> Option<(&'static str, u64)> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let (mime, (width, height)) = if bytes.starts_with(b"\x89PNG") {
        ("image/png", dimensions(bytes, true)?)
    } else if bytes.starts_with(&[0xff, 0xd8]) {
        ("image/jpeg", dimensions(bytes, false)?)
    } else {
        let mime = if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            "image/gif"
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12)? == b"WEBP" {
            "image/webp"
        } else {
            return None;
        };
        let size = imagesize::blob_size(bytes).ok()?;
        (
            mime,
            (
                u32::try_from(size.width).ok()?,
                u32::try_from(size.height).ok()?,
            ),
        )
    };
    let pixels = u64::from(width) * u64::from(height);
    (pixels > 0 && pixels <= MAX_INLINE_PIXELS && width <= 8192 && height <= 8192)
        .then_some((mime, pixels))
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
    fn gif_and_webp_use_header_dimensions_and_image_limits() {
        let gif = STANDARD
            .decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")
            .unwrap();
        let webp = STANDARD
            .decode("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==")
            .unwrap();
        assert_eq!(mail_raster_info(&gif), Some(("image/gif", 1)));
        assert_eq!(mail_raster_info(&webp), Some(("image/webp", 1)));
        let mut oversized = gif;
        oversized[6..10].copy_from_slice(&[0xff; 4]);
        assert!(mail_raster_info(&oversized).is_none());
        assert!(mail_raster_info(b"<svg/>").is_none());
    }

    #[test]
    fn inline_video_aliases_only_refer_to_local_video_parts() {
        let mp4 = b"\0\0\0\x10ftypmp42\0\0\0\0";
        let raw = format!(concat!("From: sender@example.test\r\n",
            "Content-Type: multipart/related; boundary=b\r\n\r\n",
            "--b\r\nContent-Type: text/html\r\n\r\n<video src='cid:movie'></video>\r\n",
            "--b\r\nContent-Type: video/mp4\r\nContent-ID: <movie>\r\nContent-Location: videos/movie.mp4\r\n",
            "Content-Transfer-Encoding: base64\r\n\r\n{}\r\n",
            "--b\r\nContent-Type: video/mp4\r\nContent-ID: <invalid>\r\n\r\nthis is not a video file\r\n--b--\r\n"),
            STANDARD.encode(mp4));
        let message = MessageParser::default().parse(raw.as_bytes()).unwrap();
        let rich = extract(&message).unwrap();
        let video = rich.inline_videos["movie"];
        assert_eq!(video.mime, "video/mp4");
        assert_eq!(
            video.ordinal,
            rich.inline_videos["videos/movie.mp4"].ordinal
        );
        assert_eq!(inline_video(&message, video.ordinal).unwrap(), mp4);
        assert!(matches!(
            inline_video(&message, rich.inline_videos["invalid"].ordinal),
            Err(super::super::ArchiveError::UnsupportedInlineVideo)
        ));
    }

    #[test]
    fn alternatives_and_local_image_parts() {
        let mime = concat!("From: a@example.test\r\nContent-Type: multipart/related; boundary=b\r\n\r\n",
            "--b\r\nContent-Type: text/html\r\n\r\n<table><tr><td>Grid</td></tr></table><img src='cid:x'>\r\n",
            "--b\r\nContent-Type: image/png\r\nContent-ID: <x>\r\nContent-Location: assets/hero.png\r\nContent-Transfer-Encoding: base64\r\n\r\n",
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/9ioAAAAASUVORK5CYII=\r\n",
            "--b\r\nContent-Type: image/svg+xml\r\nContent-ID: <svg>\r\n\r\n<svg/>\r\n--b--\r\n");
        let message = MessageParser::default().parse(mime.as_bytes()).unwrap();
        let rich = extract(&message).unwrap();
        assert!(rich.html.contains("<table>"));
        assert_eq!(rich.inline_images.len(), 2);
        assert_eq!(
            rich.inline_images["assets/hero.png"],
            rich.inline_images["x"]
        );
        assert!(rich.inline_images["x"].starts_with("data:image/png;base64,"));
        let plain = MessageParser::default()
            .parse(b"From: a@example.test\r\n\r\nplain")
            .unwrap();
        assert!(extract(&plain).is_none());
    }
}
