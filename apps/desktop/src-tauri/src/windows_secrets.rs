use std::{ptr, slice};

use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_NOT_FOUND},
    Security::Credentials::{
        CredDeleteW, CredEnumerateW, CredFree, CredReadW, CredWriteW, CREDENTIALW,
        CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    },
};

const ERROR: &str = "无法访问 Windows 凭据管理器。请使用本机用户登录后重试。";

fn wide(value: &str) -> Result<Vec<u16>, String> {
    if value.is_empty() || value.contains('\0') {
        return Err("凭据名称无效。".into());
    }
    Ok(value.encode_utf16().chain([0]).collect())
}

fn target(service: &str, key: &str) -> Result<Vec<u16>, String> {
    wide(&format!("{service}/{key}"))
}

pub(super) fn get(service: &str, key: &str) -> Result<Option<Vec<u8>>, String> {
    let name = target(service, key)?;
    let mut item = ptr::null_mut();
    // On success CredReadW owns one allocation, including the blob until CredFree.
    unsafe {
        if CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut item) == 0 {
            return if GetLastError() == ERROR_NOT_FOUND {
                Ok(None)
            } else {
                Err(ERROR.into())
            };
        }
        let bytes = if (*item).CredentialBlobSize == 0 {
            Vec::new()
        } else {
            slice::from_raw_parts((*item).CredentialBlob, (*item).CredentialBlobSize as usize)
                .to_vec()
        };
        CredFree(item.cast());
        Ok(Some(bytes))
    }
}

pub(super) fn set(service: &str, key: &str, value: &[u8]) -> Result<(), String> {
    if value.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
        return Err("凭据超过 Windows 允许的大小。".into());
    }
    let mut name = target(service, key)?;
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: name.as_mut_ptr(),
        CredentialBlobSize: value.len() as u32,
        CredentialBlob: value.as_ptr().cast_mut(),
        // Generic credentials persist for this user on this computer across logins.
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..Default::default()
    };
    // CredWriteW copies the caller's buffers before returning.
    if unsafe { CredWriteW(&credential, 0) } == 0 {
        return Err(ERROR.into());
    }
    Ok(())
}

fn remove(service: &str, key: &str) -> Result<(), String> {
    let name = target(service, key)?;
    unsafe {
        if CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) == 0
            && GetLastError() != ERROR_NOT_FOUND
        {
            return Err(ERROR.into());
        }
    }
    Ok(())
}

fn is_account_key(key: &str, address: &str) -> bool {
    key == address
        || key
            .strip_prefix(address)
            .and_then(|rest| rest.strip_prefix(':'))
            .is_some_and(|revision| Uuid::parse_str(revision).is_ok())
}

pub(super) fn delete_account(service: &str, address: &str, active: &str) -> Result<(), String> {
    if !is_account_key(active, address) {
        return Err("邮箱凭据与账号不匹配。".into());
    }
    let prefix = format!("{service}/");
    // Filter only on the fixed service. An address may contain wildcard characters.
    let filter = wide(&format!("{prefix}*"))?;
    let mut count = 0;
    let mut items = ptr::null_mut();
    let mut obsolete = Vec::new();
    unsafe {
        if CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut items) == 0 {
            if GetLastError() != ERROR_NOT_FOUND {
                return Err(ERROR.into());
            }
        } else {
            // All returned pointers and their NUL-terminated target names share one allocation.
            for &item in slice::from_raw_parts(items, count as usize) {
                let name = (*item).TargetName;
                if (*item).Type != CRED_TYPE_GENERIC || name.is_null() {
                    continue;
                }
                let mut len = 0;
                while *name.add(len) != 0 {
                    len += 1;
                }
                let Ok(name) = String::from_utf16(slice::from_raw_parts(name, len)) else {
                    continue;
                };
                if let Some(key) = name.strip_prefix(&prefix) {
                    if key != active && is_account_key(key, address) {
                        obsolete.push(key.to_owned());
                    }
                }
            }
            CredFree(items.cast());
        }
    }
    // Remove superseded revisions first so a failed deletion preserves the current login.
    for key in obsolete {
        remove(service, &key)?;
    }
    remove(service, active)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolated_windows_credentials_round_trip_and_selective_removal() {
        let service = format!("org.lofold.fixture.{}", Uuid::new_v4());
        let address = "sample@example.test";
        let other_service = format!("{service}.other");
        let current = format!("{address}:{}", Uuid::new_v4());
        let old = format!("{address}:{}", Uuid::new_v4());
        let malformed = format!("{address}:suffix");
        let adjacent = format!("x{address}:{}", Uuid::new_v4());
        struct Fixture(Vec<(String, String)>);
        impl Drop for Fixture {
            fn drop(&mut self) {
                for (service, key) in &self.0 {
                    let _ = remove(service, key);
                }
            }
        }
        let entries = [
            (&service, address),
            (&service, &current),
            (&service, &old),
            (&service, malformed.as_str()),
            (&service, adjacent.as_str()),
            (&other_service, address),
        ];
        let _fixture = Fixture(
            entries
                .iter()
                .map(|(s, k)| ((*s).clone(), (*k).into()))
                .collect(),
        );
        let bytes = [0, 42, 255, 0, 3];
        for (service, key) in entries {
            assert_eq!(get(service, key).unwrap(), None);
            set(service, key, &bytes).unwrap();
            assert_eq!(get(service, key).unwrap().unwrap(), bytes);
        }
        assert!(delete_account(&service, address, &adjacent).is_err());
        for _ in 0..2 {
            delete_account(&service, address, &current).unwrap();
            for (index, (service, key)) in entries.iter().enumerate() {
                let expected = (index >= 3).then(|| bytes.to_vec());
                assert_eq!(get(service, key).unwrap(), expected);
            }
        }
    }
}
