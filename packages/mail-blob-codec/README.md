# 邮件分块编码

[lib.rs](src/lib.rs) 将最多 256 KiB 的原始块编码成原样或 Zstandard 记录。归档层负责记录认证、顺序和整件摘要。从根目录运行 `cargo test --locked -p mail-blob-codec`。
