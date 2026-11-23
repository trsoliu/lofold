# 邮件协议

[lib.rs](src/lib.rs) 管理连接、授权和样信，[folders.rs](src/folders.rs) 实现远端文件夹操作，[workspace.rs](src/workspace.rs) 创建实际提交的 MIME。从根目录运行 `cargo test --locked -p lofold-mail-network`。回环联测见 [复验脚本](../../scripts/README.md)。
