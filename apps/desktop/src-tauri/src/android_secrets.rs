use jni::{
    errors::Result as JniResult,
    objects::{JByteArray, JClass, JObject, JString, JValue},
    JNIEnv, JavaVM,
};
use std::{fs::File, os::fd::FromRawFd};

/// Rust worker threads do not inherit the application's class loader.
fn with_bridge<T>(
    failure: &str,
    call: impl FnOnce(&mut JNIEnv, &JClass, &JObject) -> JniResult<T>,
) -> Result<T, String> {
    let context = ndk_context::android_context();
    // Tao owns the VM and holds a global reference to the application context.
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }.map_err(|_| failure)?;
    let mut env = vm.attach_current_thread().map_err(|_| failure)?;
    let result = env.with_local_frame(16, |env| {
        let application = unsafe { JObject::from_raw(context.context().cast()) };
        let loader = env
            .call_method(
                &application,
                "getClassLoader",
                "()Ljava/lang/ClassLoader;",
                &[],
            )?
            .l()?;
        let name = env.new_string("org.lofold.client.LoFoldBridge")?;
        let class = env
            .call_method(
                loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[(&name).into()],
            )?
            .l()?;
        call(env, &JClass::from(class), &application)
    });
    if result.is_err() {
        // Clear the Java exception before this worker handles another IPC call.
        let _ = env.exception_clear();
    }
    result.map_err(|_| failure.to_owned())
}

pub(crate) fn get(service: &str, key: &str) -> Result<Option<Vec<u8>>, String> {
    with_bridge(
        "无法读取 Android 设备中的密钥。",
        |env, class, app| {
            let service = env.new_string(service)?;
            let key = env.new_string(key)?;
            let bytes = env
                .call_static_method(
                    class,
                    "get",
                    "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)[B",
                    &[app.into(), (&service).into(), (&key).into()],
                )?
                .l()?;
            if bytes.is_null() {
                Ok(None)
            } else {
                env.convert_byte_array(JByteArray::from(bytes)).map(Some)
            }
        },
    )
}

pub(crate) fn set(service: &str, key: &str, value: &[u8]) -> Result<(), String> {
    with_bridge("无法保存 Android 设备密钥。", |env, class, app| {
        let service = env.new_string(service)?;
        let key = env.new_string(key)?;
        let value = env.byte_array_from_slice(value)?;
        env.call_static_method(
            class,
            "set",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;[B)V",
            &[
                app.into(),
                (&service).into(),
                (&key).into(),
                (&value).into(),
            ],
        )?
        .v()
    })
}

pub(crate) fn delete_account(service: &str, address: &str, active: &str) -> Result<(), String> {
    with_bridge(
        "无法清除设备上的邮箱授权。",
        |env, class, app| {
            let service = env.new_string(service)?;
            let address = env.new_string(address)?;
            let active = env.new_string(active)?;
            env.call_static_method(class, "deleteAccount", "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V", &[app.into(), (&service).into(), (&address).into(), (&active).into()])?.v()
        },
    )
}

/// Open the exact content URI granted by the Android document picker.
pub(crate) fn open_document(uri: &str, write: bool) -> Result<File, String> {
    with_bridge("无法打开所选文件。", |env, class, app| {
        let uri = env.new_string(uri)?;
        let fd = env
            .call_static_method(
                class,
                "openDocument",
                "(Landroid/content/Context;Ljava/lang/String;Z)I",
                &[app.into(), (&uri).into(), JValue::Bool(write.into())],
            )?
            .i()?;
        // Java transfers ownership using ParcelFileDescriptor.detachFd().
        Ok(unsafe { File::from_raw_fd(fd) })
    })
}

pub(crate) fn document_name(uri: &str) -> Result<String, String> {
    with_bridge("无法读取附件名称。", |env, class, app| {
        let uri = env.new_string(uri)?;
        let name = env
            .call_static_method(
                class,
                "documentName",
                "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                &[app.into(), (&uri).into()],
            )?
            .l()?;
        let name = JString::from(name);
        let value: String = env.get_string(&name)?.into();
        Ok(value)
    })
}
