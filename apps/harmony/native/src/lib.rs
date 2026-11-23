//! Exposes the archive subset used by the HarmonyOS file picker and reader.
use lofold_mail_store::MailArchive;
use serde_json::{json, Value};
use std::{
    ffi::{c_char, CStr, CString},
    path::Path,
    slice,
};

fn dispatch(
    path: &Path,
    key: &[u8; 32],
    operation: &str,
    argument: &str,
    offset: u32,
    raw: &[u8],
) -> Result<Value, String> {
    let mut archive = MailArchive::open(path, key).map_err(|e| e.to_string())?;
    match operation {
        "list" => Ok(json!(archive
            .list(argument, offset)
            .map_err(|e| e.to_string())?)),
        "import" => Ok(json!(archive.import(raw).map_err(|e| e.to_string())?)),
        "detail" => {
            let id = argument.parse().map_err(|_| "邮件编号无效。")?;
            let mut value = json!(archive.detail(id).map_err(|e| e.to_string())?);
            if let Some(detail) = value.as_object_mut() {
                // The native reader displays text. Keep embedded images out of the UI bridge.
                detail.remove("richBody");
            }
            Ok(value)
        }
        _ => Err("无法识别该归档操作。".into()),
    }
}

/// Returns a JSON object containing either data or an error. The N-API wrapper
/// validates buffers and strings and owns the inputs for this call.
///
/// # Safety
/// All strings must be valid NUL-terminated pointers, key must have 32 bytes,
/// and non-empty raw must be readable for exactly raw_len bytes.
#[no_mangle]
pub unsafe extern "C" fn lofold_archive(
    database: *const c_char,
    key: *const u8,
    operation: *const c_char,
    argument: *const c_char,
    offset: u32,
    raw: *const u8,
    raw_len: usize,
) -> *mut c_char {
    let result = std::panic::catch_unwind(|| {
        let path = CStr::from_ptr(database)
            .to_str()
            .map_err(|_| "归档路径无效。")?;
        let action = CStr::from_ptr(operation)
            .to_str()
            .map_err(|_| "操作无效。")?;
        let arg = CStr::from_ptr(argument)
            .to_str()
            .map_err(|_| "搜索文本无效。")?;
        let key = &*(key as *const [u8; 32]);
        let bytes = if raw_len == 0 {
            &[]
        } else {
            slice::from_raw_parts(raw, raw_len)
        };
        dispatch(Path::new(path), key, action, arg, offset, bytes)
    });
    let reply = match result {
        Ok(Ok(data)) => json!({ "data": data }),
        Ok(Err(error)) => json!({ "error": error }),
        Err(_) => json!({ "error": "本机归档操作失败。" }),
    };
    CString::new(reply.to_string())
        .expect("JSON escapes NUL characters")
        .into_raw()
}

/// # Safety
/// The pointer must be a live result from lofold_archive and freed exactly once.
#[no_mangle]
pub unsafe extern "C" fn lofold_free_json(value: *mut c_char) {
    drop(CString::from_raw(value));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_import_reopen_search_and_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archive.db");
        let key = [0xA5; 32];
        let raw =
            include_bytes!("../../../../packages/mail-store/tests/fixtures/chinese-attachment.eml");
        let first = dispatch(&path, &key, "import", "", 0, raw).unwrap();
        assert_eq!(first["duplicate"], false);
        assert_eq!(
            dispatch(&path, &key, "import", "", 0, raw).unwrap()["duplicate"],
            true
        );
        let page = dispatch(&path, &key, "list", "差旅", 0, &[]).unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        let detail = dispatch(&path, &key, "detail", &first["id"].to_string(), 0, &[]).unwrap();
        assert!(detail["body"].as_str().unwrap().contains("合成测试邮件"));
        assert_eq!(detail["attachments"][0]["name"], "差旅行程.csv");
        assert!(detail.get("richBody").is_none());
        assert!(dispatch(&path, &[0; 32], "list", "", 0, &[]).is_err());
    }
}
