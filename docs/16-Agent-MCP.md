# Agent MCP

LoFold 的 macOS 版本可以让同一台 Mac 上支持本地 stdio MCP 的 AI 客户端操作邮件工作区。使用前打开 LoFold 的「设置 → Agent MCP」，开启连接并复制配置到你认可的 MCP 客户端。

```json
{
  "mcpServers": {
    "lofold": {
      "command": "/Applications/LoFold.app/Contents/MacOS/lofold-client",
      "args": ["--mcp"]
    }
  }
}
```

以 LoFold 设置里展示的实际路径为准。客户端启动同一个可执行文件的 `--mcp` 模式，LoFold 界面负责授权和执行。新启动的 LoFold 会话默认关闭 Agent 连接。

## 可调用的工具

| 工具 | 作用 |
| --- | --- |
| `lofold_status` | 检查会话是否开启及共享邮件数量。 |
| `lofold_open_search` | 在 LoFold 的收件箱或本机归档中打开关键词搜索。结果在应用内查看。 |
| `lofold_list_shared_mail` | 列出人工明确共享的邮件和共享标识。 |
| `lofold_read_shared_mail` | 按共享标识读取主题、发件人和最多 12,000 字符的纯文本正文。 |
| `lofold_create_draft` | 保存可编辑草稿，返回标识和修订号。 |
| `lofold_update_draft` | 使用修订号更新本会话创建的草稿。 |
| `lofold_open_draft` | 将 Agent 草稿交接给 LoFold 编辑器供本人审阅。 |

示例指令可以是「在 LoFold 的本机归档里打开搜索‘会议纪要’」，也可以是「给 demo@example.test 写一封确认周五会议的草稿，然后打开给我审阅」。

## 共享与交接

- 读信时，通过「更多邮件操作 → 共享给 Agent MCP」逐封确认。公司和受限资料留在本机。附件仍在 LoFold 内处理。
- 可在设置里撤回任意共享。关闭连接或退出 LoFold 后，本次共享和 Agent 写入权限结束。已被读取的内容仍由接收客户端管理。
- 草稿保存在现有加密归档中，进入 LoFold 编辑器后由本人继续编辑并发送。Agent 不接触邮箱凭据。

## 验证

```sh
cargo test --locked -p lofold-agent-mcp
cargo test --locked -p lofold-client mcp::tests
```

从 MCP 客户端连接测试版本，检查只可读显式共享的合成邮件。创建草稿后更新一次，再用旧修订号重试。交接到编辑器后检查草稿留存与写入权限回收。关闭连接后再次调用读取工具应收到错误。
