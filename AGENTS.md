# LoFold 仓库协作

修改前从 [CODEMAP.md](CODEMAP.md) 找到负责目录，进入组件后继续遵循该目录的 `AGENTS.md`。根目录的 [DESIGN.md](DESIGN.md)、[CONTRACTS.md](CONTRACTS.md) 和 [INTERFACES.md](INTERFACES.md) 分别约束界面、持久化数据和调用边界。

- 可运行应用放在 `apps/`，可复用模块放在 `packages/`。应用之间通过共享包复用，JavaScript 依赖声明为 `workspace:*`，Rust 依赖通过 Cargo 工作区声明。
- 保持邮件账号、归档、草稿与已发送数据的兼容性。真实账号、授权凭据、私有邮件和本机测试产物留在本机。仓库示例使用合成材料。
- 合并前按 [TESTING.md](TESTING.md) 运行关联检查。变更入口、接口或数据行为时同时更新对应文档，用户可感知的变化记入 [CHANGELOG.md](CHANGELOG.md)。
- 应用构建、正式分发和 Pages 发布遵循 [RELEASE.md](RELEASE.md)。
