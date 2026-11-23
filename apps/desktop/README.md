# LoFold 桌面应用

React、TypeScript 和 Vite 组成渲染层，`src-tauri/` 管理系统接口、账号凭据和应用打包。模块定位见 [代码地图](../../CODEMAP.md)，页面规则见 [本目录协作规则](AGENTS.md)。

在仓库根目录运行 `pnpm dev` 启动桌面应用，`pnpm build -- --locked` 构建 macOS 应用，`pnpm --filter @lofold/desktop build` 单独构建渲染产物。
