# 验证指南

在装有 Xcode、rustup、Node.js 和 pnpm 的 Mac 上，从仓库根目录运行。

[GitHub 工作流](.github/workflows/verify.yml) 在拉取请求和 `main` 更新时运行同一套 `pnpm ci:check`，Node.js 版本由 [.node-version](.node-version) 固定。

```sh
export PATH="$HOME/.cargo/bin:$PATH"
pnpm install --frozen-lockfile
pnpm ci:check
pnpm build -- --locked
```

| 变更 | 对应检查 |
| --- | --- |
| 工作区布局、Markdown 入口、IPC 注册 | `pnpm verify:workspace` 检查实际清单、文档本地链接和命令注册。 |
| TypeScript、主题或共享包 | `pnpm check` 和 `pnpm build:workspace`。原型再验证回环服务和生成的离线入口。 |
| Rust 存储、MIME 或网络 | `cargo fmt --all -- --check` 和 `pnpm test`。真实协议路径用回环 TLS 合成邮箱复验。 |
| 原生窗口、权限或打包 | `pnpm build -- --locked`，核对 `LoFold.app`、其资源及受影响流程。 |
| 本机 AI | 使用合成邮件检查账号范围、无命中、原信引用、推理取消以及草稿保存。真实 Ollama 联测见 [本机 AI 文档](docs/15-本机AI.md)。 |
| Agent MCP | 校验 stdio 工具发现、关闭连接、逐封授权与撤回、草稿修订冲突及交接。使用 [MCP 验证指南](docs/16-Agent-MCP.md#验证) 的合成数据。 |
| Pages | 检查桌面、窄屏和深色模式。部署后验证公开入口、样式和联系图片。 |

使用 [合成 EML](packages/mail-store/tests/fixtures/chinese-attachment.eml) 复验导入、重启、搜索「差旅」和导出，核对原件与附件字节。回环 TLS 联测见 [测试脚本](scripts/README.md)。默认验收不接触用户账号或钥匙串。
