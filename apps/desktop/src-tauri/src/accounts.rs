use std::net::IpAddr;

use lofold_mail_network::{is_valid_address, Connection, MailError, MailServer, Provider};
use lofold_mail_store::{
    mailmaster_addresses, AccountRemoval, MailAccount, ProbeOutcome, Server, ServerSettings,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::LocalArchive;

const KEYCHAIN_SERVICE: &str = "org.lofold.client.mail-accounts";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    #[serde(flatten)]
    account: MailAccount,
    can_authorize: bool,
}

#[tauri::command]
pub async fn list_accounts(state: State<'_, LocalArchive>) -> Result<Vec<AccountView>, String> {
    Ok(state
        .run(|store| store.accounts())
        .await?
        .into_iter()
        .map(|account| AccountView {
            can_authorize: account.servers.is_some()
                || Provider::for_address(&account.address).is_some(),
            account,
        })
        .collect())
}

#[tauri::command]
pub async fn import_mailmaster(
    app: AppHandle,
    state: State<'_, LocalArchive>,
) -> Result<u32, String> {
    if !cfg!(target_os = "macos") {
        return Err("邮箱大师本机导入支持 macOS。其他平台请手动添加邮箱。".into());
    }
    let path = app
        .path()
        .home_dir()
        .map_err(|_| "无法读取本机用户目录。")?
        .join(
            "Library/Containers/com.netease.macmail/Data/Library/Application Support/data/app.db",
        );
    let addresses = worker(move || {
        let mut addresses = mailmaster_addresses(&path)
            .map_err(|_| "无法读取邮箱大师的本机账号表。可以手动添加邮箱地址。")?;
        addresses.retain(|address| Provider::for_address(address).is_some());
        Ok(addresses)
    })
    .await?;
    state.run(move |store| store.add_accounts(&addresses)).await
}

#[tauri::command]
pub async fn add_mail_account(
    state: State<'_, LocalArchive>,
    address: String,
) -> Result<u32, String> {
    let address = address.trim().to_owned();
    if !is_valid_address(&address) {
        return Err("请输入有效的邮箱地址。".into());
    }
    state.run(move |store| store.add_accounts(&[address])).await
}

#[tauri::command]
pub async fn preview_account_removal(
    state: State<'_, LocalArchive>,
    id: i64,
) -> Result<AccountRemoval, String> {
    state.run(move |store| store.account_removal(id)).await
}

#[tauri::command]
pub async fn remove_mail_account(state: State<'_, LocalArchive>, id: i64) -> Result<(), String> {
    let _operation = state.mail_operation.lock().await;
    let account = state.run(move |store| store.account(id)).await?;
    worker(move || delete_account_secrets(&account)).await?;
    state.run(move |store| store.remove_account(id)).await
}

#[tauri::command]
pub async fn save_mail_servers(
    state: State<'_, LocalArchive>,
    id: i64,
    mut servers: ServerSettings,
    authorization: Option<String>,
) -> Result<bool, String> {
    let authorization = authorization.map(Zeroizing::new);
    normalize_server(&mut servers.imap, "IMAP")?;
    normalize_server(&mut servers.smtp, "SMTP")?;
    let revision = Uuid::new_v4().to_string();
    let _operation = state.mail_operation.lock().await;
    let changed = state
        .run(move |store| store.save_server_settings(id, &servers, &revision))
        .await?;
    if let Some(authorization) = authorization {
        authorize_account(&state, id, authorization)
            .await
            .map_err(|error| format!("服务器配置已保存。验证失败：{error}"))?;
    }
    Ok(changed)
}

fn normalize_server(server: &mut Server, protocol: &str) -> Result<(), String> {
    let host = server.host.trim();
    let dns_name = host.len() <= 253
        && host.split('.').all(|label| {
            let valid_edge = |byte: &u8| byte.is_ascii_alphanumeric();
            label.len() <= 63
                && label.as_bytes().first().is_some_and(valid_edge)
                && label.as_bytes().last().is_some_and(valid_edge)
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        });
    if !dns_name && host.parse::<IpAddr>().is_err() {
        return Err(format!("请输入有效的 {protocol} 服务器主机名。"));
    }
    if server.port == 0 {
        return Err(format!("{protocol} 端口须在 1–65535 之间。"));
    }
    let username = server.username.trim();
    if username.is_empty() || username.len() > 254 || username.chars().any(char::is_control) {
        return Err(format!("请输入有效的 {protocol} 登录名。"));
    }
    server.host = host.to_ascii_lowercase();
    server.username = username.to_owned();
    Ok(())
}

#[tauri::command]
pub async fn authorize_mail_account(
    state: State<'_, LocalArchive>,
    id: i64,
    authorization: String,
) -> Result<(), String> {
    let authorization = Zeroizing::new(authorization);
    let _operation = state.mail_operation.lock().await;
    authorize_account(&state, id, authorization).await
}

async fn authorize_account(
    state: &LocalArchive,
    id: i64,
    authorization: Zeroizing<String>,
) -> Result<(), String> {
    let account = state.run(move |store| store.account(id)).await?;
    let revision = account.server_revision.clone();
    worker(move || {
        let secret = if account.servers.is_none() {
            authorization.trim()
        } else {
            authorization.as_str()
        };
        if secret.trim().is_empty() || secret.len() > 256 || secret.chars().any(char::is_control) {
            return Err("请输入有效的客户端授权码或应用专用密码。".into());
        }
        let gmail_secret;
        let secret = if account.servers.is_none()
            && account.address.to_ascii_lowercase().ends_with("@gmail.com")
        {
            gmail_secret = Zeroizing::new(secret.replace(' ', ""));
            if gmail_secret.len() != 16
                || !gmail_secret.bytes().all(|byte| byte.is_ascii_lowercase())
            {
                return Err("请填写 Gmail 的 16 位应用专用密码。".into());
            }
            gmail_secret.as_str()
        } else {
            secret
        };
        connection(&account)?
            .verify(&account.address, secret)
            .map_err(|error| error.to_string())?;
        save_secret(&credential_key(&account), secret)
    })
    .await?;
    state
        .run(move |store| store.mark_server_connected(id, revision.as_deref()))
        .await
}

#[tauri::command]
pub async fn send_mail_probe(state: State<'_, LocalArchive>, id: i64) -> Result<(), String> {
    let _operation = state.mail_operation.lock().await;
    let account = state.run(move |store| store.account(id)).await?;
    let (account, secret) = worker(move || {
        connected_connection(&account)?;
        let secret = read_secret(&account)?;
        Ok((account, secret))
    })
    .await?;
    let idempotency_key = Uuid::new_v4();
    let token = idempotency_key.to_string();
    let stored_token = token.clone();
    state
        .run(move |store| store.begin_probe(id, &stored_token))
        .await?;
    let sent = worker(move || {
        Ok(connected_connection(&account)?.send_probe(&account.address, &secret, idempotency_key))
    })
    .await?;
    let result = match &sent {
        Ok(()) => Some(ProbeOutcome::Accepted),
        Err(MailError::Message | MailError::SmtpConnection | MailError::SmtpRejected) => {
            Some(ProbeOutcome::Rejected)
        }
        Err(_) => None,
    };
    if let Some(result) = result {
        state
            .run(move |store| store.finish_probe(id, &token, result))
            .await?;
    }
    sent.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn check_mail_probe(
    state: State<'_, LocalArchive>,
    id: i64,
) -> Result<Option<i64>, String> {
    let _operation = state.mail_operation.lock().await;
    let account = state.run(move |store| store.account(id)).await?;
    connected_connection(&account)?;
    let probe = account.probe.as_ref().ok_or("还没有测试邮件。")?;
    if probe.status == "received" {
        return Ok(probe.message_id);
    }
    if probe.status == "rejected" {
        return Err("样信未提交。可以发起一次新的测试。".into());
    }
    let token = Uuid::parse_str(&probe.token).map_err(|_| "样信标识无效。")?;
    let probe_token = probe.token.clone();
    let raw = worker(move || {
        let secret = read_secret(&account)?;
        connected_connection(&account)?
            .read_probe(&account.address, &secret, token)
            .map_err(|error| error.to_string())
    })
    .await?;
    if let Some(raw) = raw {
        let message = state
            .run(move |store| {
                let message = store.import(&raw)?.id;
                store.finish_probe(id, &probe_token, ProbeOutcome::Received(message))?;
                Ok(message)
            })
            .await?;
        return Ok(Some(message));
    }
    Ok(None)
}

pub(crate) fn connected_connection(account: &MailAccount) -> Result<Connection<'_>, String> {
    if !account.connected {
        return Err("请先授权邮箱。".into());
    }
    connection(account)
}

fn connection(account: &MailAccount) -> Result<Connection<'_>, String> {
    fn endpoint(server: &Server) -> MailServer<'_> {
        MailServer {
            host: &server.host,
            port: server.port,
            username: &server.username,
            start_tls: server.start_tls,
        }
    }
    if let Some(servers) = &account.servers {
        return Ok(Connection::manual(
            endpoint(&servers.imap),
            endpoint(&servers.smtp),
        ));
    }
    Provider::for_address(&account.address)
        .map(Connection::provider)
        .ok_or_else(|| "请先配置 IMAP 和 SMTP 服务器。".into())
}

pub(crate) async fn worker<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| "邮箱操作中断。".to_owned())?
}

fn save_secret(key: &str, secret: &str) -> Result<(), String> {
    crate::platform_secrets::set(KEYCHAIN_SERVICE, key, secret.as_bytes())
}

pub(crate) fn read_secret(account: &MailAccount) -> Result<Zeroizing<String>, String> {
    let bytes = crate::platform_secrets::get(KEYCHAIN_SERVICE, &credential_key(account))?
        .ok_or_else(|| "找不到此邮箱的授权码，请重新授权。".to_string())?;
    String::from_utf8(bytes)
        .map(Zeroizing::new)
        .map_err(|_| "邮箱授权码无效，请重新授权。".into())
}

fn delete_account_secrets(account: &MailAccount) -> Result<(), String> {
    crate::platform_secrets::delete_account(
        KEYCHAIN_SERVICE,
        &account.address.to_ascii_lowercase(),
        &credential_key(account),
    )
}

fn credential_key(account: &MailAccount) -> String {
    let address = account.address.to_ascii_lowercase();
    match &account.server_revision {
        Some(revision) => format!("{address}:{revision}"),
        None => address,
    }
}

#[cfg(all(test, target_os = "macos"))]
#[test]
#[ignore = "temporarily stores synthetic credentials in the macOS Keychain"]
fn removal_clears_only_the_selected_keychain_account() {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    struct Fixture {
        service: String,
        keys: Vec<String>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for key in &self.keys {
                let _ = delete_generic_password(&self.service, key);
            }
        }
    }

    let address = "remove@example.test";
    let current = format!("{address}:{}", Uuid::new_v4());
    let fixture = Fixture {
        service: format!("org.lofold.fixture.{}", Uuid::new_v4()),
        keys: vec![
            address.to_owned(),
            format!("{address}:{}", Uuid::new_v4()),
            current.clone(),
            "keep@example.test".to_owned(),
        ],
    };
    for key in &fixture.keys {
        set_generic_password(&fixture.service, key, b"synthetic fixture").unwrap();
    }
    for _ in 0..2 {
        crate::platform_secrets::delete_account(&fixture.service, address, &current).unwrap();
        for key in &fixture.keys[..3] {
            assert_eq!(
                get_generic_password(&fixture.service, key)
                    .unwrap_err()
                    .code(),
                -25300
            );
        }
        assert_eq!(
            get_generic_password(&fixture.service, &fixture.keys[3]).unwrap(),
            b"synthetic fixture"
        );
    }
}
