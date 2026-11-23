# LoFold Agent MCP

用 Rust MCP SDK 提供 stdio 工具。CLI 切换由 [桌面入口](../../apps/desktop/src-tauri/src/main.rs) 完成。请求经仅当前 macOS 用户可访问的 Unix socket 交给 [桌面宿主](../../apps/desktop/src-tauri/src/mcp.rs)。

该包定义工具契约和通道，桌面宿主管理访问会话、共享资料和归档。客户端接入见 [Agent MCP](../../docs/16-Agent-MCP.md)。
