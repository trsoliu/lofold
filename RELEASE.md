# 发布与分发

## macOS 构建

从干净检出运行 [验证命令](TESTING.md)。`pnpm build -- --locked` 生成 `target/release/bundle/macos/LoFold.app`。核对应用版本、处理器、签名及 `Contents/Resources` 下的 `LICENSE` 与 `NOTICE`。正式分发需独立验证 Developer ID 签名、公证和安装。

调整版本时同步更新 [桌面包](apps/desktop/package.json)、[Tauri 配置](apps/desktop/src-tauri/tauri.conf.json)、[Rust 宿主](apps/desktop/src-tauri/Cargo.toml) 和 [Cargo 锁文件](Cargo.lock)。发布记录包含源码提交、平台、版本、验证范围和产物摘要。工作区包随应用构建。

## 源码和 Pages

公开源码带上 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。Pages 从 `main:/docs` 发布。部署后核对 [项目主页](https://trsoliu.github.io/lofold/)、仓库 About 和尾注链接。源码推送、Pages 部署和安装包分发分别核验。
