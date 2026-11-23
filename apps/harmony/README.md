# LoFold 鸿蒙离线归档

面向 HarmonyOS 5.0（API 12）及以上的 ARM64 手机和平板。ArkUI 提供文件选择、归档列表、正文阅读和搜索。首次导入使用系统文件选择器，可选多封 EML，单封上限 16 MiB。按主题、地址、正文或附件名搜索，阅读页以纯文本显示正文，列出附件名称及大小。

鸿蒙端与桌面端共用 [Rust 归档库](../../packages/mail-store) 和 [无损分块实现](../../packages/mail-blob-codec)。归档写入应用私有目录中的 SQLCipher 数据库，去重依据是原始字节的 SHA-256。应用从系统随机数服务生成 32 字节归档密钥，由 Asset Store 按解锁状态保护。鸿蒙离线版没有联网权限。账号连接、IMAP/SMTP、写信和附件导出属于其他端的功能。

## 构建

从仓库检出根目录开始，使用仓库指定的 Rust 工具链、HarmonyOS 5.0 API 12 Command Line Tools，以及 JDK 17。将工具包中的 Node.js、ohpm 和 hvigorw 加入 PATH，并将 DEVECO_SDK_HOME 指向其中的 sdk 目录。[华为命令行构建指南](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/ide-command-line-building-app/)

```sh
rustup target add aarch64-unknown-linux-ohos
apps/harmony/scripts/build-hap.sh
```

脚本用 HarmonyOS SDK 的 NDK 为 ARM64 编译归档库和 N-API 模块，再调用 ohpm、Hvigor 编译 ArkTS，生成 entry 模块的 HAP。在 DevEco Studio 中直接运行前，先执行 `apps/harmony/scripts/build-native.sh`，用 OHOS_NDK_HOME 指定当前系统可运行的 NDK native 目录。

未配置产品签名时，构建产物是开发验证用的 unsigned HAP。真机调试要求 LoFold 应用专属证书及包含测试设备的 profile。公开分发须通过应用开发者账号在 AppGallery Connect 配置发布签名、构建 APP 包并走发布流程。签名文件保存在仓库外。[华为应用签名和发布指南](https://developer.huawei.com/consumer/en/doc/HarmonyOS-Guides/ide-publish-app/) · [Profile 范围](https://developer.huawei.com/consumer/en/doc/app/agc-help-profile-overview-0000002283260125/)

## 验证

```sh
cargo test --locked --manifest-path apps/harmony/native/Cargo.toml
```

此测试在主机上以合成中文 EML 验证归档桥接层，覆盖首次导入、完全相同原件去重、数据库重开、按附件名搜索、读取正文、附件名和错误密钥拒绝。真机验收应在 LoFold 已获授权的设备上从系统选择器导入[同一份样例](../../packages/mail-store/tests/fixtures/chinese-attachment.eml)，退出后重新打开并搜索“差旅”，检查中文正文及附件“差旅行程.csv”。设备验收与主机测试分开记录。
