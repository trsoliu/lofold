fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/message_image.m");
        cc::Build::new()
            .file("src/message_image.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("lofold_message_image");
        for framework in ["AppKit", "WebKit", "CoreGraphics", "ImageIO", "PDFKit"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        // Keep every loadable segment compatible with Android 16 KiB page-size devices.
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build()
}
