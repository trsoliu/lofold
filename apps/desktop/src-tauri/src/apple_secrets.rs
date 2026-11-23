use security_framework::passwords::{get_generic_password, set_generic_password};

pub fn get(service: &str, key: &str) -> Result<Option<Vec<u8>>, String> {
    match get_generic_password(service, key) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(_) => Err("无法访问系统钥匙串，请解锁设备后重试。".into()),
    }
}

pub fn set(service: &str, key: &str, value: &[u8]) -> Result<(), String> {
    set_generic_password(service, key, value).map_err(|_| "无法写入系统钥匙串。".into())
}

pub fn delete_account(
    service: &str,
    address: &str,
    active_key: &str,
) -> Result<(), String> {
    use security_framework::{
        item::{ItemClass, ItemSearchOptions, Limit},
        passwords::delete_generic_password,
    };

    const ITEM_NOT_FOUND: i32 = -25300;
    const KEYCHAIN_ERROR: &str = "无法清除本机邮箱授权，请解锁或允许 macOS 钥匙串访问后重试。";

    let revision_prefix = format!("{address}:");
    let mut keys = match ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(service)
        .load_attributes(true)
        .limit(Limit::All)
        .search()
    {
        Ok(items) => items
            .into_iter()
            .filter_map(|item| item.simplify_dict()?.remove("acct"))
            .filter(|key| {
                key == address
                    || key
                        .strip_prefix(&revision_prefix)
                        .is_some_and(|suffix| uuid::Uuid::parse_str(suffix).is_ok())
            })
            .collect::<Vec<_>>(),
        Err(error) if error.code() == ITEM_NOT_FOUND => Vec::new(),
        Err(_) => return Err(KEYCHAIN_ERROR.into()),
    };
    // Revoke superseded server revisions first. An ACL failure leaves the current login usable.
    keys.retain(|key| key != active_key);
    keys.push(active_key.to_owned());
    for key in keys {
        match delete_generic_password(service, &key) {
            Err(error) if error.code() != ITEM_NOT_FOUND => return Err(KEYCHAIN_ERROR.into()),
            _ => {}
        }
    }
    Ok(())
}
