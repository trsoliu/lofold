# 大模型服务适配

HTTP 客户端按所选协议构造请求并解码最终文本。支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Google Gemini generateContent。用户可直接填写模型 ID，模型列表按各协议的响应格式读取。非回环地址须使用 HTTPS。宿主按协议和完整服务地址读取凭据。详见[协议设置与基础地址](../../docs/15-本机AI.md)。

通过 IPv4 回环地址 `127.0.0.1` 直接连接 Ollama，默认端口为 11434，关闭 HTTP 代理与重定向。用户可在「设置 → 大模型」选择模型和指定其他本机端口。通过非默认端口列出模型和提交正文前会检查服务的禁云状态。模型需出现在本机已安装列表中，并经详情接口确认是可生成文本的 GGUF 模型。结果为有界的纯文本推理输出。

邮件范围、摘要与翻译提示词、引用映射和取消由[桌面宿主](../../apps/desktop/src-tauri/src/ai.rs)负责。运行 `cargo test --locked -p lofold-mail-ai` 测试模型选择边界。
