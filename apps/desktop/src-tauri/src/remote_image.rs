use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use lofold_mail_store::{mail_raster_info, MAX_IMAGE_BYTES};
use reqwest::{header, redirect::Policy, Client, Url};
use tokio::{net::lookup_host, time::timeout};

const UNAVAILABLE: &str = "图片服务器未返回可显示的图片。";
const DESTINATION: &str = "图片地址不属于可访问的公网 HTTPS 站点。";
const TOO_LARGE: &str = "图片超过阅读器的大小上限。";

fn image_host(url: &Url) -> Option<&str> {
    let host = url.domain()?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || !host.contains('.')
        || host.ends_with('.')
        || [
            "localhost",
            "local",
            "internal",
            "lan",
            "home.arpa",
            "onion",
        ]
        .iter()
        .any(|suffix| {
            host == *suffix || host.strip_suffix(suffix).is_some_and(|p| p.ends_with('.'))
        })
    {
        return None;
    }
    Some(host)
}

// Require ordinary public unicast endpoints. Pin those addresses for the whole
// request, including redirects, while retaining the hostname for TLS verification.
fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_documentation()
                || a == 0
                || a >= 224
                || a == 100 && (64..=127).contains(&b)
                || a == 198 && (b == 18 || b == 19)
                || a == 192 && ((b == 0 && c == 0) || (b == 88 && c == 99)))
        }
        IpAddr::V6(ip) => {
            let [first, second, ..] = ip.segments();
            (0x2000..0x4000).contains(&first)
                && !(first == 0x2001 && (second < 0x200 || second == 0xdb8)
                    || first == 0x2002
                    || first == 0x3fff && second < 0x1000)
        }
    }
}

async fn fetch_image(url: Url) -> Result<String, &'static str> {
    let host = image_host(&url).ok_or(DESTINATION)?;
    let addresses: Vec<SocketAddr> = lookup_host((host, 443))
        .await
        .map_err(|_| UNAVAILABLE)?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|addr| !public_address(addr.ip())) {
        return Err(DESTINATION);
    }
    let origin = url.origin();
    let client = Client::builder()
        .no_proxy()
        .https_only(true)
        .referer(false)
        .resolve_to_addrs(host, &addresses)
        .redirect(Policy::custom(move |attempt| {
            if attempt.previous().len() <= 3
                && attempt.url().origin() == origin
                && image_host(attempt.url()).is_some()
            {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| UNAVAILABLE)?;
    download_image(client, url).await
}

async fn download_image(client: Client, url: Url) -> Result<String, &'static str> {
    let mut response = client
        .get(url)
        .header(header::ACCEPT, "image/png,image/jpeg,image/gif,image/webp")
        .send()
        .await
        .map_err(|_| UNAVAILABLE)?;
    if !response.status().is_success() {
        return Err(UNAVAILABLE);
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_IMAGE_BYTES as u64)
    {
        return Err(TOO_LARGE);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNAVAILABLE)? {
        if chunk.len() > MAX_IMAGE_BYTES - bytes.len() {
            return Err(TOO_LARGE);
        }
        bytes.extend_from_slice(&chunk);
    }
    let (mime, _) = mail_raster_info(&bytes).ok_or(UNAVAILABLE)?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
pub(super) async fn load_mail_image(url: String) -> Result<String, &'static str> {
    if url.len() > 8192 {
        return Err(DESTINATION);
    }
    let url = Url::parse(&url).map_err(|_| DESTINATION)?;
    timeout(Duration::from_secs(15), fetch_image(url))
        .await
        .map_err(|_| UNAVAILABLE)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_bounded_raster_response_without_credentials() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::thread;
        let image = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
        let bytes = STANDARD.decode(image).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = Url::parse(&format!(
            "http://{}/flower.gif",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let reader = BufReader::new(&socket);
            let headers: Vec<_> = reader
                .lines()
                .map(Result::unwrap)
                .take_while(|s| !s.is_empty())
                .collect();
            assert!(headers[0].starts_with("GET /flower.gif "));
            assert!(!headers
                .iter()
                .any(|line| ["cookie:", "referer:", "authorization:"]
                    .iter()
                    .any(|prefix| line.to_lowercase().starts_with(prefix))));
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: image/gif\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).unwrap();
            socket.write_all(&bytes).unwrap();
        });
        let result = tauri::async_runtime::block_on(async {
            download_image(Client::builder().no_proxy().build().unwrap(), url).await
        })
        .unwrap();
        server.join().unwrap();
        assert_eq!(result, format!("data:image/gif;base64,{image}"));
    }

    #[test]
    fn accepts_only_public_https_image_hosts() {
        for url in [
            "http://images.example.org/a",
            "https://127.0.0.1/image",
            "https://[::1]/image",
            "https://localhost./image",
            "https://files.local/image",
            "https://local/image",
            "https://name@images.example.org/image",
            "https://images.example.org:8443/image",
        ] {
            assert!(image_host(&Url::parse(url).unwrap()).is_none(), "{url}");
        }
        assert_eq!(
            image_host(&Url::parse("https://images.example.org:443/photo?id=1").unwrap()),
            Some("images.example.org")
        );
    }

    #[test]
    fn excludes_private_reserved_and_translated_endpoints() {
        for ip in [
            "0.1.2.3",
            "10.0.0.1",
            "172.20.0.1",
            "100.64.1.1",
            "127.0.0.1",
            "169.254.169.254",
            "192.168.1.1",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::ffff:127.0.0.1",
            "64:ff9b::a00:1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "2002::1",
            "2001:db8::1",
        ] {
            assert!(!public_address(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "2606:4700:4700::1111"] {
            assert!(public_address(ip.parse().unwrap()));
        }
    }
}
