# 邮件归档

[lib.rs](src/lib.rs) 管理 SQLCipher 归档和迁移，[workspace.rs](src/workspace.rs) 管理草稿和发信状态。原件和附件使用 [分块组件](../mail-blob-codec/) 存储。根目录执行 `cargo test --locked -p lofold-mail-store` 覆盖旧库、合成邮件、附件与草稿。兼容性见 [数据契约](../../CONTRACTS.md)。
