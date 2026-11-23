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
| 邮件阅读、三栏排版和附件 | `pnpm test:reader` 在 Chromium 和原生 WKWebView 执行构建后的合成邮件用例。 |
| 原生窗口、权限或打包 | `pnpm build -- --locked`，核对 `LoFold.app`、其资源及受影响流程。 |
| 写作资料和记忆 | `pnpm test` 检查收件人范围、归档迁移和修订冲突。手动复验选中并记住表述、切换发件账号、添加抄送或密送、预览润色、撤销和重新打开草稿。 |
| 邮件 AI | 用回环服务分别核对 Chat Completions、Responses、Messages、generateContent 的实际路径、鉴权头、模型列表和邮件请求。用模拟远程地址复验逐次确认和取消。检查查信范围、原信引用及草稿预览。Ollama 联测见 [大模型配置](docs/15-本机AI.md)。 |
| Agent MCP | 校验 stdio 工具发现、关闭连接、逐封授权与撤回、草稿修订冲突及交接。使用 [MCP 验证指南](docs/16-Agent-MCP.md#验证) 的合成数据。 |
| Agent Skill | 按[安装说明](docs/lofold-skill/README.md)在临时目录安装。使用支持 MCP 的 macOS 测试包检查 `tools`、`status`、合成草稿、未共享邮件拒绝和退出码。安装两次时检查已有 Skill 完好。 |
| Pages | 检查桌面、窄屏和深色模式。部署后验证公开入口、样式和联系图片。 |

使用 [合成 EML](packages/mail-store/tests/fixtures/chinese-attachment.eml) 复验导入、重启、搜索「差旅」和导出，核对原件与附件字节。回环 TLS 联测见 [测试脚本](scripts/README.md)。默认验收不接触用户账号或钥匙串。

## 阅读器回归

```sh
pnpm --filter @lofold/desktop exec playwright install --no-shell chromium
pnpm test:reader
```

CI 使用 `pnpm ci:check` 生成的生产构建执行同一套回归。本机已有构建时，可直接运行 `pnpm --filter @lofold/desktop test:reader:chromium` 或 `pnpm --filter @lofold/desktop test:reader:wk`。WKWebView 验收需要 macOS 和 Xcode 命令行工具。Chromium 的六类正文在 420 和 1200 CSS 像素下覆盖白色和曜金主题。

| 用例 | 验收 |
| --- | --- |
| [合成告警 EML](packages/mail-store/tests/fixtures/reader-alert.eml) | 7 个短标签保持单行且与对应值同行，长值完整，内嵌图表解码并等比缩放。Rust 验证 MIME、CID、原件和附件字节。 |
| 结构化字段和旧式邮件 | 跨栏标题、行标题、定义列表和常见的两列字段样式保留。固定宽度容器收敛，长链接和代码可读，引用可展开并保持顺序。 |
| 多栏数据表 | 列头和单元格保留，内容宽于阅读栏时只在表内滚动，键盘可达最右列。长图和打印保留右侧数据及末尾内容。 |
| 图片、视频和正文回退 | 外链默认阻止，显式加载、解码失败、单图重试和本地视频可测。邮件脚本及主动内容被过滤，HTML 不可用时显示纯文本。 |
| 工作区与附件中心 | 320、420、760、761、965、966、1200、1512 CSS 像素的白色／曜金组合覆盖三栏断点、时间与按钮位置、独立滚动、搜索和返回状态、未读点、长文件名及原信和下载按钮。正文末尾的附件顺序覆盖 HTML 和纯文本，长邮件可滚动到附件并下载。 |

用例通过合成邮件和模拟桌面命令执行，浏览器会阻止外部请求。诊断尺寸和失败截图写到 `target/reader-layout/`，可用 `LOFOLD_READER_ARTIFACTS` 指定其他目录。

原生分发复验分别见 [macOS 通用包](.github/workflows/macos-installer.yml)、[Windows 安装与重启](.github/workflows/windows-installer.yml)、[Android 安装与导入](.github/workflows/android-emulator.yml)、[iOS 模拟器安装与启动](.github/workflows/ios-simulator.yml)和[鸿蒙归档验证](apps/harmony/README.md)。模拟器、主机集成测试与真机测试分别记录。
