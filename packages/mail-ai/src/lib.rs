use std::time::Duration;

use reqwest::{redirect::Policy, Client, RequestBuilder};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;

mod compatible;
mod protocol;
pub use compatible::{
    canonical_base_url, is_loopback_base_url, valid_api_key, valid_compatible_model,
    CompatibleClient, CompatibleError,
};
pub use protocol::{generation_url, ApiProtocol};

pub const DEFAULT_PORT: u16 = 11434;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub enum AiError {
    #[error(transparent)]
    Compatible(#[from] CompatibleError),
    #[error("本机端口应为 1 至 65535 的整数。")]
    InvalidPort,
    #[error("此端口的 Ollama 未确认已关闭云功能。请启用 OLLAMA_NO_CLOUD=1 并重启该服务。")]
    CloudStatus,
    #[error("无法连接本机 Ollama。请启动本地服务后刷新模型。")]
    Unavailable,
    #[error("当前模型不是可用的本机 GGUF 模型。请刷新模型列表。")]
    ModelUnavailable,
    #[error("模型无法完成本次请求。请检查模型能力和可用内存后重试。")]
    ModelFailed,
    #[error("本机模型响应超时。请缩小范围或切换模型后重试。")]
    TimedOut,
    #[error("本机模型返回了无法读取的结果。")]
    InvalidResponse,
}

#[derive(Deserialize, Serialize)]
pub struct ModelDetails {
    format: String,
}

#[derive(Deserialize, Serialize)]
pub struct Model {
    pub name: String,
    size: u64,
    details: ModelDetails,
    #[serde(default, skip_serializing)]
    remote_host: Option<String>,
    #[serde(default, skip_serializing)]
    remote_model: Option<String>,
}

impl Model {
    fn is_local(&self) -> bool {
        self.details.format.eq_ignore_ascii_case("gguf")
            && self.size >= 1024 * 1024
            && local_name(&self.name)
            && !remote(&self.remote_host, &self.remote_model)
    }
}

fn local_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !name.is_empty()
        && name.len() <= 200
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:/".contains(&byte))
        && !name.contains("://")
        && !lower.ends_with(":cloud")
        && !lower.ends_with("-cloud")
}

fn remote(host: &Option<String>, model: &Option<String>) -> bool {
    [host, model]
        .into_iter()
        .any(|value| value.as_ref().is_some_and(|text| !text.trim().is_empty()))
}

#[derive(Deserialize)]
struct Tags {
    models: Vec<Model>,
}

#[derive(Deserialize)]
struct Show {
    details: ModelDetails,
    capabilities: Vec<String>,
    remote_host: Option<String>,
    remote_model: Option<String>,
}

#[derive(Deserialize)]
struct Chat {
    message: ChatMessage,
    done: bool,
    done_reason: Option<String>,
}

#[derive(Deserialize)]
struct ChatMessage {
    content: String,
}

pub struct Answer {
    pub text: String,
    pub incomplete: bool,
}

pub struct Ollama {
    client: Client,
    port: u16,
}

#[derive(Deserialize)]
struct Status {
    cloud: CloudSettings,
}

#[derive(Deserialize)]
struct CloudSettings {
    disabled: bool,
}

impl Ollama {
    pub fn new() -> Result<Self, AiError> {
        Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(120))
            .build()
            .map(|client| Self {
                client,
                port: DEFAULT_PORT,
            })
            .map_err(|_| AiError::Unavailable)
    }

    pub fn at_port(&self, port: u16) -> Result<Self, AiError> {
        if port == 0 {
            return Err(AiError::InvalidPort);
        }
        Ok(Self {
            client: self.client.clone(),
            port,
        })
    }

    fn endpoint(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    async fn check_cloud_status(&self) -> Result<(), AiError> {
        if self.port == DEFAULT_PORT {
            return Ok(());
        }
        let status: Status = read(
            self.client
                .get(self.endpoint("/api/status"))
                .timeout(Duration::from_secs(5)),
        )
        .await
        .map_err(|error| match error {
            AiError::Unavailable | AiError::TimedOut => error,
            _ => AiError::CloudStatus,
        })?;
        if status.cloud.disabled {
            Ok(())
        } else {
            Err(AiError::CloudStatus)
        }
    }

    pub async fn models(&self) -> Result<Vec<Model>, AiError> {
        self.check_cloud_status().await?;
        let tags: Tags = read(
            self.client
                .get(self.endpoint("/api/tags"))
                .timeout(Duration::from_secs(5)),
        )
        .await?;
        let mut models: Vec<_> = tags.models.into_iter().filter(Model::is_local).collect();
        models.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(models)
    }

    pub async fn select(&self, name: &str) -> Result<LocalModel<'_>, AiError> {
        if !local_name(name) || !self.models().await?.iter().any(|model| model.name == name) {
            return Err(AiError::ModelUnavailable);
        }
        let show: Show = read(
            self.client
                .post(self.endpoint("/api/show"))
                .timeout(Duration::from_secs(10))
                .json(&json!({ "model": name })),
        )
        .await?;
        if !show.details.format.eq_ignore_ascii_case("gguf")
            || remote(&show.remote_host, &show.remote_model)
            || !show.capabilities.iter().any(|kind| kind == "completion")
        {
            return Err(AiError::ModelUnavailable);
        }
        Ok(LocalModel {
            runtime: self,
            thinking: show.capabilities.iter().any(|kind| kind == "thinking"),
            name: name.to_owned(),
        })
    }
}

pub struct LocalModel<'a> {
    runtime: &'a Ollama,
    thinking: bool,
    name: String,
}

impl LocalModel<'_> {
    pub async fn generate(
        &self,
        system: &str,
        input: &str,
        tokens: u32,
        json_output: bool,
    ) -> Result<Answer, AiError> {
        self.runtime.check_cloud_status().await?;
        // Thinking models place reasoning in a separate field. Only content is rendered as mail.
        let thinking = self.thinking && !json_output;
        let budget = if thinking {
            tokens.saturating_add(2048)
        } else {
            tokens
        };
        let mut request = json!({
            "model": self.name,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": input }
            ],
            "stream": false,
            "think": thinking,
            "keep_alive": "2m",
            "options": { "num_ctx": 8192, "num_predict": budget, "temperature": 0.2 },
        });
        if json_output {
            request["format"] = json!("json");
        }
        let chat: Chat = read(
            self.runtime
                .client
                .post(self.runtime.endpoint("/api/chat"))
                .json(&request),
        )
        .await?;
        let text = chat.message.content.trim().to_owned();
        if !chat.done || text.is_empty() {
            return Err(AiError::InvalidResponse);
        }
        Ok(Answer {
            text,
            incomplete: chat.done_reason.as_deref() == Some("length"),
        })
    }
}

async fn read<T: DeserializeOwned>(request: RequestBuilder) -> Result<T, AiError> {
    let response = request.send().await.map_err(request_error)?;
    if !response.status().is_success() {
        return Err(AiError::ModelFailed);
    }
    read_json(response).await
}

async fn read_json<T: DeserializeOwned>(mut response: reqwest::Response) -> Result<T, AiError> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err(AiError::InvalidResponse);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if chunk.len() > MAX_RESPONSE_BYTES - bytes.len() {
            return Err(AiError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| AiError::InvalidResponse)
}

fn request_error(error: reqwest::Error) -> AiError {
    if error.is_timeout() {
        AiError::TimedOut
    } else {
        AiError::Unavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_final_answer_is_used_as_mail() {
        let reply: Chat = serde_json::from_value(json!({
            "message":{"content":"周五见。","thinking":"仅供模型处理的中间过程。"},
            "done":true, "done_reason":"stop",
        }))
        .unwrap();
        assert_eq!(reply.message.content, "周五见。");
    }

    #[test]
    fn ports_are_loopback_only_and_cloud_confirmation_must_be_boolean() {
        let runtime = Ollama::new().unwrap();
        assert!(matches!(runtime.at_port(0), Err(AiError::InvalidPort)));
        assert_eq!(
            runtime.endpoint("/api/chat"),
            "http://127.0.0.1:11434/api/chat"
        );
        assert_eq!(
            runtime.at_port(65535).unwrap().endpoint("/api/chat"),
            "http://127.0.0.1:65535/api/chat"
        );
        for status in [
            r#"{}"#,
            r#"{"cloud":{}}"#,
            r#"{"cloud":{"disabled":"true"}}"#,
        ] {
            assert!(serde_json::from_str::<Status>(status).is_err());
        }
    }

    #[test]
    fn cloud_models_and_empty_placeholders_are_excluded() {
        let model = |name: &str, size, host| Model {
            name: name.to_owned(),
            size,
            details: ModelDetails {
                format: "gguf".into(),
            },
            remote_host: host,
            remote_model: None,
        };
        assert!(model("qwen2.5:3b", 2_000_000, None).is_local());
        assert!(!model("deepseek-v3.1:671b-cloud", 2_000_000, None).is_local());
        assert!(!model(
            "remote-alias",
            2_000_000,
            Some("https://example.test".into())
        )
        .is_local());
        assert!(!model("alias", 600, None).is_local());
    }
}
