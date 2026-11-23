# 数据契约

| 边界 | 当前约定和代码 |
| --- | --- |
| 邮件原件 | 导入以邮件原始字节为准，按 SHA-256 去重。导出重组分块后核验原始大小和摘要。见 [归档内核](packages/mail-store/src/lib.rs)。 |
| 归档与账号 | SQLCipher 数据库版本由 `PRAGMA user_version` 管理，升级在事务中完成。账号区分授权、服务器设置和缓存世代。凭据由宿主保存。Apple 平台使用钥匙串，Windows 使用凭据管理器，Android 使用 Keystore 保护的加密存储。鸿蒙离线归档的密钥由 Asset Store 保护。见 [归档说明](packages/mail-store/README.md) 与 [账号命令](apps/desktop/src-tauri/src/accounts.rs)。 |
| 大模型服务 | 客户端保存接口类型、地址和模型标识。原生宿主按协议和规范化的完整基础地址隔离 API Key。Chat Completions 沿用原有凭据标识。更换域名、端口或服务路径后使用对应地址的凭据。原有 Ollama 端口和按端口保存的模型可继续使用。 |
| 写作资料 | SQLCipher v10 为每个邮箱和未选邮箱的草稿各保留独立资料。整份资料按修订号在事务内保存，旧修订不能覆盖新值。移除邮箱时级联清除该账号资料。见 [写作资料存储](packages/mail-store/src/writing.rs)。 |
| 草稿与发送 | 保存和提交需要当前草稿修订号。提交前保留待确认状态，SMTP 明确接受后保存所提交 MIME；不确定回执禁止自动重发。见 [草稿存储](packages/mail-store/src/workspace.rs) 和 [发件命令](apps/desktop/src-tauri/src/workspace.rs)。 |
| 阅读状态 | SQLCipher v11 将本机已读与待确认的服务器标记分别保存。正文打开成功后更新当前邮箱项目，以账号、文件夹、UIDVALIDITY 和 UID 限定写回。收取同一文件夹时重试待同步标记。旧归档升级时不为过去的阅读补发标记。 |
| 协议与身份 | IMAP 项目归属账户、文件夹、UIDVALIDITY 和 UID。SMTP 的密送地址保留在信封，邮件头省略该字段。见 [文件夹操作](packages/mail-network/src/folders.rs) 和 [邮件组装](packages/mail-network/src/workspace.rs)。 |
| 压缩块 | 块头记录版本、编码和长度。256 KiB 上限、解码范围及完整性约束见 [分块组件](packages/mail-blob-codec/README.md)。 |

修改持久化结构时，补旧数据升级和原件字节一致性验证。修改跨进程字段时，同时核对 TypeScript 调用和 Rust 返回值。命令清单与变更流程见 [INTERFACES.md](INTERFACES.md)。
