# 接口开发

LoFold 的主接口是桌面渲染进程与本机宿主间的 Tauri IPC。公共站点为静态页面。协议请求由原生宿主按账号授权发往邮箱服务商。

| 调用场景 | 渲染端入口 | 主机注册与实现 |
| --- | --- | --- |
| 归档列表、阅读、导出 | [archive.ts](apps/desktop/src/archive.ts) | [main.rs](apps/desktop/src-tauri/src/main.rs) |
| 草稿、投递、目录和状态 | [mail-workspace.ts](apps/desktop/src/mail-workspace.ts) | [workspace.rs](apps/desktop/src-tauri/src/workspace.rs) · [mailboxes.rs](apps/desktop/src-tauri/src/mailboxes.rs) |
| 账号授权与连接测试 | [accounts.tsx](apps/desktop/src/accounts.tsx) | [accounts.rs](apps/desktop/src-tauri/src/accounts.rs) |
| 本机模型、邮件问答和文本生成 | [ai-panel.tsx](apps/desktop/src/ai-panel.tsx) | [ai.rs](apps/desktop/src-tauri/src/ai.rs) |
| 长图、暗水印和打印 | [message-body.tsx](apps/desktop/src/message-body.tsx) | [message_image.rs](apps/desktop/src-tauri/src/message_image.rs) |

新增或改名时先核对所属模块、输入字段的类型与序列化、失败结果和权限，再同步宿主注册与调用端。涉及已存数据时，以 [CONTRACTS.md](CONTRACTS.md) 检查兼容性。运行 `pnpm verify:workspace` 核对字面量 IPC 调用的注册，再按 [TESTING.md](TESTING.md) 验证参数和实际行为。
