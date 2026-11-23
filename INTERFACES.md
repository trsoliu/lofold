# 接口开发

LoFold 的主接口是桌面渲染进程与本机宿主间的 Tauri IPC。公共站点为静态页面。协议请求由原生宿主按账号授权发往邮箱服务商。

| 调用场景 | 渲染端入口 | 主机注册与实现 |
| --- | --- | --- |
| 归档列表、阅读、导出 | [archive.ts](apps/desktop/src/archive.ts) | [lib.rs](apps/desktop/src-tauri/src/lib.rs) |
| 草稿、投递、目录和状态 | [mail-workspace.ts](apps/desktop/src/mail-workspace.ts) | [workspace.rs](apps/desktop/src-tauri/src/workspace.rs) · [mailboxes.rs](apps/desktop/src-tauri/src/mailboxes.rs) |
| 账号授权与连接测试 | [accounts.tsx](apps/desktop/src/accounts.tsx) | [accounts.rs](apps/desktop/src-tauri/src/accounts.rs) |
| 读写当前发件身份的资料和记忆 | [writing-profile.ts](apps/desktop/src/writing-profile.ts) | [writing.rs](apps/desktop/src-tauri/src/writing.rs) |
| 本机模型、邮件问答和文本生成 | [ai-panel.tsx](apps/desktop/src/ai-panel.tsx) | [ai.rs](apps/desktop/src-tauri/src/ai.rs) |
| Agent MCP 开关、邮件共享、草稿交接 | [agent-mcp.tsx](apps/desktop/src/agent-mcp.tsx) | [mcp.rs](apps/desktop/src-tauri/src/mcp.rs) |
| 长图、暗水印和打印 | [message-body.tsx](apps/desktop/src/message-body.tsx) | [message_image.rs](apps/desktop/src-tauri/src/message_image.rs) |

Android 的 EML 导入使用系统文档选择器，将返回的内容 URI 交给原生宿主限长读取。每封最多 16 MiB，取消选择会保持当前工作区。

新增或改名时先核对所属模块、输入字段的类型与序列化、失败结果和权限，再同步宿主注册与调用端。涉及已存数据时，以 [CONTRACTS.md](CONTRACTS.md) 检查兼容性。运行 `pnpm verify:workspace` 核对字面量 IPC 调用的注册，再按 [TESTING.md](TESTING.md) 验证参数和实际行为。

[Agent MCP](docs/16-Agent-MCP.md) 通过本机 stdio 接收工具调用。授权和写入由正在运行的 LoFold 宿主处理，窗口通过本机事件接收打开搜索和草稿的请求。[Agent Skill](docs/lofold-skill/README.md) 可通过客户端配置的 MCP 工具或随附的 Python 脚本调用相同入口。
