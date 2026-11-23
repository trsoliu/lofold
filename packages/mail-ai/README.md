# 本机模型适配

只连接 `127.0.0.1:11434`，直接访问 Ollama，关闭 HTTP 代理与重定向。模型需出现在本机已安装列表中，并经详情接口确认是可生成文本的 GGUF 模型。结果为有界的纯文本推理输出。

邮件范围、摘要与翻译提示词、引用映射和取消由[桌面宿主](../../apps/desktop/src-tauri/src/ai.rs)负责。运行 `cargo test --locked -p lofold-mail-ai` 测试模型选择边界。
