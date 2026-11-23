# 代码地图

| 目录 | 负责内容 |
| --- | --- |
| [apps/desktop](apps/desktop/) | React 邮件工作区和 Tauri 原生宿主。原生入口注册 IPC 并组装邮件组件。 |
| [apps/design-preview](apps/design-preview/) | 可用浏览器演练的设计原型，包含合成邮件和附件。 |
| [packages/branding](packages/branding/) | 两个应用共享的标志、品牌信息和主题选项。 |
| [packages/mail-store](packages/mail-store/) | SQLCipher 归档、迁移、邮件索引、草稿和附件。 |
| [packages/mail-network](packages/mail-network/) | IMAP、SMTP、TLS、文件夹动作和 MIME 发件。 |
| [packages/mail-blob-codec](packages/mail-blob-codec/) | 邮件与文件的有界无损分块编码。 |
| [scripts](scripts/) | 工作区检查及本地研发复验脚本。 |
| [docs](docs/) | 工程和研究材料。GitHub Pages 从此目录发布静态页。 |

桌面 UI 调用 `apps/desktop/src-tauri` 注册的命令。宿主协调存储和协议层。协议层产出邮件原件，存储层经分块组件写入本机归档。共享主题由两个应用消费，应用的业务源码和演示状态各自维护。配置入口见 [pnpm 工作区](pnpm-workspace.yaml)、[Turbo 任务](turbo.json) 和 [Cargo 工作区](Cargo.toml)。
