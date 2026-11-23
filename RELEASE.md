# 发布与分发

## 0.6.0 安装与开发构建

从[官网下载区](https://trsoliu.github.io/lofold/#downloads)按设备选择。每个公开文件的 SHA-256 随 [GitHub Release](https://github.com/trsoliu/lofold/releases/tag/v0.6.0) 提供。

| 平台 | 安装与验证 |
| --- | --- |
| macOS | 打开 DMG，将 LoFold 拖入「应用程序」。本版采用临时签名，未经过 Apple 公证。通用包须同时核验 Intel 和 Apple 芯片二进制架构、签名、资源以及挂载后的应用。 |
| Windows x64 | 运行 EXE，按提示安装到当前用户。程序依赖 Microsoft Edge WebView2，缺少时安装器会下载运行时。此开发版没有 Authenticode 签名。使用 [Windows 工作流](.github/workflows/windows-installer.yml) 构建 NSIS 包并实装，导入示例 EML 后重启、搜索和复验附件。 |
| Android ARM64 | 下载已签名的 APK，在 Android 7.0 及以上设备上按系统提示安装。相同包名的后续更新须沿用相同签名。[Android 构建](.github/workflows/android-installer.yml)产出未签名 APK，发布者在本机运行[签名脚本](scripts/android/sign-release.sh)，用 apksigner 和 zipalign 校验后上传。签名密钥和口令留在本机。 |
| iOS 模拟器 | 在 Apple 芯片 Mac 上解压 ZIP，将 LoFold.app 拖到已经启动的 iPhone 或 iPad 模拟器。可用 [iOS 构建脚本](scripts/apple/build-simulator.sh) 重建。iPhone、iPad 真机尚无签名包与 TestFlight 渠道。 |
| HarmonyOS NEXT | [鸿蒙离线版](apps/harmony/README.md)可从源码编译，支持 EML 导入、本机归档、搜索与阅读。公开安装需要本项目的华为发行证书和签名配置。 |

## macOS 构建

从干净检出运行 [验证命令](TESTING.md)。`pnpm build -- --locked` 生成 `target/release/bundle/macos/LoFold.app`。核对应用版本、处理器、签名及 `Contents/Resources` 下的 `LICENSE` 与 `NOTICE`。正式分发需独立验证 Developer ID 签名、公证和安装。

调整版本时同步更新 [桌面包](apps/desktop/package.json)、[Tauri 配置](apps/desktop/src-tauri/tauri.conf.json)、[Rust 宿主](apps/desktop/src-tauri/Cargo.toml) 和 [Cargo 锁文件](Cargo.lock)。发布记录包含源码提交、平台、版本、验证范围和产物摘要。工作区包随应用构建。

## 源码和 Pages

公开源码带上 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。Pages 从 `main:/docs` 发布。部署后核对 [项目主页](https://trsoliu.github.io/lofold/)、仓库 About 和尾注链接。源码推送、Pages 部署和安装包分发分别核验。
