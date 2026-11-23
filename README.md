# LoFold

开源本地邮件客户端。在设备上收发、搜索和归档邮件。

[项目主页](https://trsoliu.github.io/lofold/) · [按系统下载](https://trsoliu.github.io/lofold/#downloads) · [GitHub Releases](https://github.com/trsoliu/lofold/releases) · [技术栈](#技术栈与架构) · [Agent 接入](https://trsoliu.github.io/lofold/#agent) · [从源码构建](#本机运行) · [联系方式](#联系方式) · [开源许可](#开源许可)

[代码地图](CODEMAP.md) · [接口与数据](INTERFACES.md) · [测试](TESTING.md) · [发布](RELEASE.md) · [变更记录](CHANGELOG.md)

**All your inboxes, in one place.** 来信在手，心里有数。

macOS、Windows、Android 共用邮件工作区。iOS 提供模拟器开发版，鸿蒙提供原生离线版源码。各端安装条件见[发布说明](RELEASE.md)。用户打开应用就能离线查看、导入和整理邮件；添加已有邮箱后，设备直接向邮箱服务商收发邮件。以网易邮箱大师的个人使用流程和会员权益为第一阶段功能目标。另外增加自动无损压缩，减少邮件和文件对本机空间的占用，原件可逐字节恢复。

## 技术栈与架构

**一套 Rust 邮件内核，支撑多端客户端。** 邮件协议、加密归档、检索和无损编码各有独立的工作区模块。收发时由设备直连邮箱服务商。离线时，已归档的邮件、附件和草稿仍可在本机查阅。

| 层 | 技术 | LoFold 怎样用 |
| --- | --- | --- |
| 应用宿主 | React 19 · TypeScript · Vite · Tauri 2 | macOS、Windows、Android 和 iOS 模拟器复用自适应工作区及 Rust 宿主。HarmonyOS NEXT 用 ArkUI 和 N-API 接入同一套 Rust 归档库。[客户端](apps/desktop/) · [鸿蒙离线版](apps/harmony/) |
| 加密与检索 | Rust · SQLCipher · SQLite FTS5 | 邮件、索引、草稿保存在本机加密数据库。系统凭据服务保护归档密钥。FTS5 trigram 索引覆盖正文和附件名，短关键词另走子串查询。[归档源码](packages/mail-store/) |
| 原件存储 | Zstandard · SHA-256 | 原件按最多 256 KiB 分块，达到节省阈值才采用压缩记录。SHA-256 用于原件去重和重组校验，导出可以还原最初的 EML 字节。[无损分块源码](packages/mail-blob-codec/) |
| 收发协议 | IMAP · SMTP · TLS · MIME | 设备直接向邮箱服务商同步和发信。提交结果不明时保留草稿并阻止重复提交，避免服务器已收件时又发一封。[邮件协议源码](packages/mail-network/) |
| 本机 AI | Ollama · GGUF · 本机全文检索 | 在选定邮箱或归档范围内先检索，再把候选片段交给回环地址上的本机模型。答案可打开原信，写作资料按发件账号保存。[本机 AI](docs/15-本机AI.md) |
| Agent 接口 | MCP stdio · Unix socket · Agent Skills | macOS 上的外部 Agent 经本机通道调用 7 个工具。原信按封共享，草稿交回应用编辑器审阅。[Agent MCP](docs/16-Agent-MCP.md) · [LoFold Skill](docs/lofold-skill/README.md) |
| 工程与交付 | pnpm · Turborepo · Cargo · GitHub Actions | Monorepo 同时维护客户端、Rust 共享包和发布工作流。构建使用锁定依赖，覆盖类型检查、测试和各端安装产物验证。[代码地图](CODEMAP.md) · [验证指南](TESTING.md) · [发布说明](RELEASE.md) |

**原件保真有实测数据。** 分块对照中，合成中文纯文本 EML 的载荷从 **2,854 B 降到 550 B**（节省 80.73%），带 JPEG 的完整 EML 从 **231,888 B 降到 174,816 B**（节省 24.61%）。8 类样本均逐字节还原。这组数字衡量样本载荷，实际归档占用还受数据库、索引和文件系统影响。[实验口径和复跑脚本](docs/research/本地压缩实验.md)

## 文档导航

| 想先看什么 | 文档 |
| --- | --- |
| 查看原创图标及十种主题色，切换桌面、手机和场景 | [LoFold 主题预览](apps/design-preview/directions.html) · [配色来源与筛选](docs/14-Rill品牌与主题配色.md) |
| 查阅首轮高保真交接与后续画板 | [交付与验证](docs/11-原型定稿与高保真交接.md) |
| 查阅定稿原型与后续高保真画板 | [原型审阅入口](apps/design-preview/review.html) · [原型定稿与高保真交接](docs/11-原型定稿与高保真交接.md) |
| 体验多邮箱写信、固定常用搜索、等回复与出发前的离线准备 | [打开交互原型](apps/design-preview/index.html) · [原型说明](docs/08-交互原型.md) |
| 查看首批 163、QQ 邮箱的接入配置和验证范围 | [首批邮箱接入验证](docs/10-首批邮箱接入验证.md) |
| 四端系统、数据流、发件状态和 AI 如何实现（四张图） | [技术架构与选型图解](docs/07-技术架构与选型图解.md) |
| 三条候选路线、优缺点、证据和最终选择条件 | [完整方案与选型评审](docs/06-完整方案与选型评审.md) |
| 自动无损压缩对哪些邮件和文件有效、节省量怎样计算 | [本地压缩对照实验](docs/research/本地压缩实验.md) |
| 中文检索、附件、原件导出、投递与开源构建分别测到了哪一步 | [本机实验记录与复跑方法](docs/research/实验记录.md) |
| 产品怎么用、要做哪些功能、做到什么程度才可以发布 | [产品需求与验收](docs/01-产品需求与验收.md) |
| 大师会员的哪些权益能免费实现，哪些依赖原服务 | [竞品与会员功能对照](docs/02-竞品与会员功能对照.md) |
| 一封信从服务器怎样到手机，断网、换机、重复发送如何处理 | [架构设计](docs/03-架构设计.md) |
| 自有宿主有哪些技术选择，四个平台分别怎么构建、签名和安装 | [技术选型与四端安装](docs/04-技术选型与四端安装.md) |
| 哪个现成客户端可作为底座、哪些源码适合直接使用 | [开源项目与复用决策](docs/05-开源项目与复用决策.md) |

## 如何决定采用哪个项目

把 Meron 整机、Allodia 客户端的开源部分、Allodia 独立引擎加自有 React/Tauri 界面放在同一套验收条件下比较。Velo 提供桌面写信和阅读组件。选型看四端实装、中文处理、断线投递、换机与新增会员功能的实际改动量；目前保留三条路线。

第一项工程验证是**同一份客户端在四端装起来，断网导入一封带中文附件的邮件，再通过测试邮箱收发一封并在重启后找回**。这条链会同时暴露签名、中文解码、索引、凭据和同步问题。通过后再扩展完整工作流、会员功能与可选的设备间同步。第一封信收发成功只代表链路打通。

## macOS 开发版

桌面采用三栏工作区。左侧先提供所有收件箱和所有未读，再在「我的邮箱」下展开各账号的收件、未读、红旗、草稿、已发送、自定义、垃圾邮件和已删除文件夹。直接拖动邮箱账号行可调整顺序，单击展开或收起。聚焦账号行后也可按 Option＋↑／↓ 排序。排序保存在本机，窄窗口的「邮箱导航」沿用该顺序。[界面约束](DESIGN.md)

所有草稿、所有已发送、本机归档及各工具仍可从侧栏打开。macOS 顶部工具栏集中提供邮箱范围、收取、搜索与附件筛选，中间直接显示邮件列表，右侧阅读正文及附件。按 ⌘K 定位搜索，按 Esc 清空搜索。窄窗口的列表和正文依次显示。[Codex 桌面工作区参考](https://openai.com/index/codex-for-almost-everything/)

| 原型流程 | macOS 0.6.0 的实际行为 |
| --- | --- |
| 多邮箱收件、未读和阅读 | 已授权账号会读取 IMAP 文件夹目录。「收取」读取当前文件夹近期邮件，需要历史记录时可点「收取更早邮件」。侧栏数字是本机已缓存的未读数，中文搜索和会话查找在本机运行。 |
| 写信、回复、保存草稿 | 支持收件人、抄送、密送、回复、回复全部、正文转发和原件作为附件转发。草稿保存在加密归档，退出后可恢复。服务器草稿可编辑为本机副本。附件合计上限 8 MiB。 |
| 提交与已发送 | 通过 SMTP 提交。服务器接受后保存本机已发送副本，已发送列表也读取服务器 Sent 文件夹。回执不明时保留原稿、显示待确认并阻止再次提交。 |
| 附件中心 | 按附件文件名和归属账号查找已保存的附件。可以直接保存附件或定位原信，再返回原附件搜索。 |
| 固定搜索 | 保存当前邮件范围、关键词及「含附件」条件。取消固定只移除搜索入口。 |
| 离线准备 | 按账号查看已缓存的邮件、附件和存储块字节，按需收取最近 20 封。已经取回的原件可离线阅读、搜索和导出。 |
| 阅读与长图 | 左侧切换邮箱和文件夹，中间选信，右侧阅读。邮件时间右侧提供阅读操作，附件位于正文末尾。内嵌图片随栏宽调整，宽表格可在表内横向滚动。多轮回复可逐段展开，长图和打印收录完整历史。打开「更多邮件操作」可保存长图、打印和导出 EML 原件。 |
| 邮件整理 | 支持本机置顶和会话、服务器已读、红旗、移动、垃圾邮件、删除与恢复。彻底删除限已删除文件夹，需服务器支持定向删除。服务器操作失败时显示原因，本机归档保留已取回的原件。 |
| 写作记忆 | 在「设置 → 写信」管理每个发件身份的偏好和签名。写信时可记住选中的表述、在光标处插入常用语，并针对单个收件人保存专用表述。 |
| 邮件 AI | 在选定邮箱范围内自然语言查信和问答，打开参考原信。单封邮件可摘要、翻译或拟回复，写信时可按本次选用的资料拟稿、续写或润色，预览后应用。在设置中选择 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Google Gemini 或 Ollama。[配置与使用](docs/15-本机AI.md) |
| Agent Skill 与 MCP | 用本机 Agent 打开查信、创建或编辑草稿，以及读取逐封共享的邮件。[安装 Skill](docs/lofold-skill/README.md) · [MCP 连接与工具](docs/16-Agent-MCP.md) |
| 后续待接入 | 后台全量同步、自动整理规则、快捷文本和跟进提醒。 |

本机归档仍可导入 EML，并按主题、发件人、收件人、正文或附件名搜索。完全相同的原件只保存一份。点击侧栏底部的齿轮进入设置中心，默认打开「邮箱账号」。在「写信」设置默认发件邮箱，在「外观」切换十套主题，在「本机存储」查看离线准备。窄窗口的齿轮在右上角。

通过 LoFold 发送的新邮件、回复、转发和验证样信，都在提交时给正文末尾加上 `Sent with LoFold: https://trsoliu.github.io/lofold/`。写信时会提前显示提示，草稿和转发所附原件保留原样。

从「更多邮件操作」保存长图时，LoFold 将邮箱地址加密后写入 PNG 像素，画面不显示水印文字。导入邮件或含有多个关联账号的邮件可在保存前选定账号。若本机还未添加邮箱，可明确选择保存无水印版本。在「设置 → 本机存储 → 读取长图暗水印」选择原始 PNG，可用本机归档密钥验证并读取水印。裁剪、缩放和有损重编码可能使水印失效。

### 从邮箱大师迁移并联测

打开侧栏「邮箱账号」，选择「从邮箱大师导入」。LoFold 只读查询 macOS 邮箱大师 4.17 的账号表，迁移有效的个人 163、QQ 和 Gmail 邮箱地址。重复导入会去重，读取失败时可手动添加。其他域名添加后可点击「服务器配置」，在同一张表单填写 IMAP 和 SMTP 的主机名、端口、SSL/TLS 或 STARTTLS、登录名，以及管理员允许使用的客户端密码。「仅保存服务器」只写入本机配置。「保存并验证」会检查 IMAP 和 SMTP 连接，验证通过后将密码写入 macOS 钥匙串。验证失败时可以在原表单修正后重试。

选中邮箱后点击「授权」，输入服务商签发的客户端授权码或 Gmail 应用专用密码。应用通过 IMAP 和 SMTP 的 TLS 连接分别验证，授权通过后保存到 macOS 钥匙串。[网易授权和协议](https://help.mail.126.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089) · [QQ 授权](https://hiflow.tencent.com/document/applications/qq-mail/) · [Gmail 应用专用密码](https://support.google.com/accounts/answer/185833)

点击「发送样信给自己」后，LoFold 通过 SMTP 提交一封带合成 CSV 的邮件，并按随机 Message-ID 从只读收件箱查回。收信验证核对发件人、收件人、Message-ID、附件名和附件字节。成功后可离线查看样信。邮件尚未到达时，使用「查收样信」继续查原样信。一轮测试的标识和状态随归档保存。QQ 服务端改写邮件标识时，0.2.2 支持从其保留的原始标识查回同一封样信。

在「设置 → 邮箱账号」点击该账号右侧的垃圾桶图标，核对影响范围后确认。LoFold 将清除本机授权，并保留「本机归档」中的已下载邮件及附件。未发草稿留在「所有草稿」并解除发件邮箱关联，已提交的本机副本仍可在「所有已发送」查阅。重新添加该邮箱需要重新授权。

真实账号须由账号持有人授权。0.3.0 的一般收件和带附件发信已通过隔离 TLS 邮箱验收。

### 本机归档

归档使用 SQLCipher。Apple 平台用系统钥匙串，Windows 用凭据管理器，Android 用 Keystore 保护归档密钥。原件按 256 KiB 分块，满足节省阈值时使用现有 Rust 编解码器压缩。导出原件前校验 SHA-256。HTML 邮件在隔离环境中本地渲染，远程图片不自动加载。单封 EML 上限为 16 MiB。

### 本机运行

在装有 Xcode、Node.js 22.12 或以上版本、pnpm 11 和 rustup 的 Apple 芯片 Mac 上运行。

```sh
git clone https://github.com/trsoliu/lofold.git
cd lofold
export PATH="$HOME/.cargo/bin:$PATH"
pnpm install --frozen-lockfile
pnpm dev
```

构建本机应用和复验归档链路。

```sh
pnpm ci:check
pnpm build -- --locked
```

`pnpm ci:check` 核对工作区、文档链接、前端构建和 Rust 测试。应用在 `apps/`，共享模块在 `packages/`。开发协作见 [AGENTS.md](AGENTS.md)，设计、数据契约与历史规划入口见 [文档索引](docs/README.md)。

应用产物为 `target/release/bundle/macos/LoFold.app`。更新后先退出旧进程再打开新应用，可在 Finder 的应用简介查看版本号。本地开发包使用临时签名。重新构建后访问已有归档时，macOS 可能要求重新授权读取 LoFold 的钥匙串密钥。正式分发仍需 Developer ID 签名和 Apple 公证。[Tauri macOS 签名说明](https://v2.tauri.app/distribute/sign/macos/)

导入 [中文邮件与 CSV 附件样例](packages/mail-store/tests/fixtures/chinese-attachment.eml)，搜索「差旅」，保存附件和原件。退出并重开 LoFold 后，邮件仍可离线查看。此样例使用虚构地址。

2026-11-21 在 Apple 芯片 Mac 上实测导入样例、查看中文附件、退出重开后以「差旅」找回邮件。界面导出的 745 字节 EML 和 32 字节 CSV 均与样例逐字节一致。归档与压缩的 11 项 Rust 测试通过。

[客户端源码](apps/desktop)采用 React 和 Tauri，[归档内核](packages/mail-store)可独立运行测试。完整 IMAP 同步以及 iOS、Android、Windows 实装属于后续里程碑。原型可用于审阅计划中的功能。研发文档指向 `output/` 的历史截图和构建产物保留在本机。

## 联系方式

使用微信扫一扫，或保存二维码后在微信中识别。[项目主页联系区](https://trsoliu.github.io/lofold/#contact)

| LoFold 开源邮箱体验群 | 维护者微信 · 刘亚东 |
| --- | --- |
| <img src="docs/contact/wechat-group.png" width="168" alt="LoFold 开源邮箱体验群二维码"> | <img src="docs/contact/wechat-maintainer.png" width="168" alt="维护者刘亚东的微信二维码"> |
| 群码在 2026 年 11 月 30 日前有效 | 扫码添加好友 |

## 开源许可

LoFold 采用 [Apache License 2.0](LICENSE)。再分发 LoFold 或包含相关部分的衍生作品时，按许可第 4 节保留 [NOTICE](NOTICE) 中适用的署名，包括项目主页 [trsoliu.github.io/lofold](https://trsoliu.github.io/lofold/)。第三方依赖遵循各自许可。
