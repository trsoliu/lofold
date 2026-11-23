use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};

use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION},
    redirect::Policy,
    Client, RequestBuilder, Response, StatusCode, Url,
};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use thiserror::Error;

use crate::{
    generation_url,
    protocol::{gemini_id, AnthropicMessage, Chat, GeminiResponse, Responses},
    read_json, AiError, Answer, ApiProtocol,
};

#[derive(Debug, Error)]
pub enum CompatibleError {
    #[error("请输入完整的 API 基础地址。远程服务需要 HTTPS，本机可使用 HTTP。地址不能包含账号、密码、查询参数或片段。")]
    InvalidAddress,
    #[error("请输入有效的 API 密钥。")]
    InvalidKey,
    #[error("请输入有效的模型 ID。")]
    InvalidModel,
    #[error("无法连接 AI 服务。请检查基础地址和网络连接。")]
    Connection,
    #[error("AI 服务响应超时。请稍后重试。")]
    Timeout,
    #[error("AI 服务拒绝认证或授权。请检查 API 密钥和访问权限。")]
    Authentication,
    #[error("AI 服务找不到接口或模型。请检查基础地址和模型 ID。")]
    NotFound,
    #[error("AI 服务已限制请求。请检查配额或稍后重试。")]
    RateLimited,
    #[error("AI 服务返回了重定向。请填写最终的 API 基础地址。")]
    Redirect,
    #[error("AI 服务未能完成请求。请检查模型或服务协议。")]
    Rejected,
    #[error("AI 服务返回了无法读取的结果。")]
    InvalidResponse,
}

fn parse_base_url(input: &str) -> Result<Url, CompatibleError> {
    let value = input.trim();
    let authority = value
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or(""));
    if value.len() > 2048
        || value
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
        || authority.is_none_or(|s| s.is_empty() || s.contains('@'))
    {
        return Err(CompatibleError::InvalidAddress);
    }
    let url = Url::parse(value).map_err(|_| CompatibleError::InvalidAddress)?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port() == Some(0)
        || !(url.scheme() == "https" || url.scheme() == "http" && is_loopback(&url))
    {
        return Err(CompatibleError::InvalidAddress);
    }
    Ok(url)
}

fn is_loopback(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}

/// The complete service identity, including its path prefix, without a trailing slash.
pub fn canonical_base_url(input: &str) -> Result<String, AiError> {
    Ok(parse_base_url(input)?
        .as_str()
        .trim_end_matches('/')
        .to_owned())
}

pub fn is_loopback_base_url(input: &str) -> Result<bool, AiError> {
    Ok(is_loopback(&parse_base_url(input)?))
}

pub fn valid_api_key(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && value.bytes().all(|byte| byte.is_ascii_graphic())
}

pub fn valid_compatible_model(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

pub struct CompatibleClient {
    protocol: ApiProtocol,
    client: Client,
    base: String,
}

#[derive(Deserialize)]
struct Models {
    data: Vec<ModelId>,
    #[serde(default)]
    has_more: bool,
    last_id: Option<String>,
}

#[derive(Deserialize)]
struct ModelId {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiModels {
    #[serde(default)]
    models: Vec<GeminiModel>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiModel {
    name: String,
    #[serde(default)]
    supported_generation_methods: Vec<String>,
}

impl CompatibleClient {
    pub fn new(base_url: &str, api_key: Option<&str>) -> Result<Self, AiError> {
        Self::with_protocol(ApiProtocol::ChatCompletions, base_url, api_key)
    }

    pub fn with_protocol(
        protocol: ApiProtocol,
        base_url: &str,
        api_key: Option<&str>,
    ) -> Result<Self, AiError> {
        let url = parse_base_url(base_url)?;
        let mut headers = HeaderMap::new();
        if protocol == ApiProtocol::Anthropic {
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
        if let Some(key) = api_key {
            if !valid_api_key(key) {
                return Err(CompatibleError::InvalidKey.into());
            }
            let (name, value) = match protocol {
                ApiProtocol::ChatCompletions | ApiProtocol::Responses => {
                    (AUTHORIZATION, format!("Bearer {key}"))
                }
                ApiProtocol::Anthropic => (
                    reqwest::header::HeaderName::from_static("x-api-key"),
                    key.to_owned(),
                ),
                ApiProtocol::Gemini => (
                    reqwest::header::HeaderName::from_static("x-goog-api-key"),
                    key.to_owned(),
                ),
            };
            let mut auth =
                HeaderValue::from_str(&value).map_err(|_| CompatibleError::InvalidKey)?;
            auth.set_sensitive(true);
            headers.insert(name, auth);
        }
        let mut builder = Client::builder()
            .default_headers(headers)
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120));
        if is_loopback(&url) {
            builder = builder.no_proxy();
            if url.host_str() == Some("localhost") {
                let port = url
                    .port_or_known_default()
                    .ok_or(CompatibleError::InvalidAddress)?;
                builder = builder.resolve_to_addrs(
                    "localhost",
                    &[
                        SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port),
                        SocketAddr::new(Ipv6Addr::LOCALHOST.into(), port),
                    ],
                );
            }
        }
        Ok(Self {
            protocol,
            client: builder.build().map_err(|_| CompatibleError::Connection)?,
            base: url.as_str().trim_end_matches('/').to_owned(),
        })
    }

    pub async fn models(&self) -> Result<Vec<String>, AiError> {
        let endpoint = Url::parse(&format!("{}/models", self.base))
            .map_err(|_| CompatibleError::InvalidAddress)?;
        let mut next = endpoint.clone();
        let mut seen_cursors = HashSet::new();
        let mut names = Vec::new();
        for _ in 0..16 {
            let response = send(self.client.get(next).timeout(Duration::from_secs(15))).await?;
            let (parameter, cursor) = if self.protocol == ApiProtocol::Gemini {
                let page: GeminiModels = decode(response).await?;
                for model in page.models {
                    if model
                        .supported_generation_methods
                        .iter()
                        .any(|method| method == "generateContent")
                    {
                        if let Some(id) = gemini_id(&model.name) {
                            names.push(id.to_owned());
                        }
                    }
                }
                (
                    "pageToken",
                    page.next_page_token.filter(|token| !token.is_empty()),
                )
            } else {
                let page: Models = decode(response).await?;
                names.extend(
                    page.data
                        .into_iter()
                        .map(|model| model.id)
                        .filter(|id| valid_compatible_model(id)),
                );
                let cursor = if self.protocol == ApiProtocol::Anthropic && page.has_more {
                    Some(page.last_id.ok_or(CompatibleError::InvalidResponse)?)
                } else {
                    None
                };
                ("after_id", cursor)
            };
            let Some(cursor) = cursor else {
                names.sort();
                names.dedup();
                return Ok(names);
            };
            if cursor.is_empty()
                || cursor.len() > 2048
                || cursor.chars().any(char::is_control)
                || !seen_cursors.insert(cursor.clone())
            {
                return Err(CompatibleError::InvalidResponse.into());
            }
            next = endpoint.clone();
            next.query_pairs_mut().append_pair(parameter, &cursor);
        }
        Err(CompatibleError::InvalidResponse.into())
    }

    pub async fn generate(
        &self,
        model: &str,
        system: &str,
        prompt: &str,
        tokens: u32,
        json_output: bool,
    ) -> Result<Answer, AiError> {
        let url = generation_url(self.protocol, &self.base, model)?;
        let system = if json_output {
            format!("{system}\n只输出所要求的 JSON 对象，不加 Markdown 围栏或其他文字。")
        } else {
            system.to_owned()
        };
        let mut body = self
            .protocol
            .generation_body(model, &system, prompt, tokens);
        let completion = || self.client.post(&url);
        let mut response = send(completion().json(&body)).await?;
        if self.protocol == ApiProtocol::ChatCompletions
            && matches!(
                response.status(),
                StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY
            )
        {
            // Older compatible services only accept max_tokens. Retry only an explicit parameter rejection.
            let error: Value = read_json(response).await.unwrap_or(Value::Null);
            if !rejects_completion_limit(&error) {
                return Err(CompatibleError::Rejected.into());
            }
            body.as_object_mut()
                .expect("request is a JSON object")
                .remove("max_completion_tokens");
            body["max_tokens"] = json!(tokens);
            response = send(completion().json(&body)).await?;
        }
        let answer = match self.protocol {
            ApiProtocol::ChatCompletions => decode::<Chat>(response).await?.answer(),
            ApiProtocol::Responses => decode::<Responses>(response).await?.answer(),
            ApiProtocol::Anthropic => decode::<AnthropicMessage>(response).await?.answer(),
            ApiProtocol::Gemini => decode::<GeminiResponse>(response).await?.answer(),
        };
        Ok(answer?)
    }
}

fn rejects_completion_limit(error: &Value) -> bool {
    let error = &error["error"];
    if error["param"] == "max_completion_tokens" && error["code"] == "unsupported_parameter" {
        return true;
    }
    let message = error["message"].as_str().unwrap_or("").to_ascii_lowercase();
    message.contains("max_completion_tokens")
        && [
            "unsupported",
            "not supported",
            "unexpected",
            "unrecognized",
            "unknown",
            "not permitted",
        ]
        .iter()
        .any(|word| message.contains(word))
}

async fn send(request: RequestBuilder) -> Result<Response, CompatibleError> {
    request.send().await.map_err(|e| {
        if e.is_timeout() {
            CompatibleError::Timeout
        } else {
            CompatibleError::Connection
        }
    })
}

async fn decode<T: DeserializeOwned>(response: Response) -> Result<T, CompatibleError> {
    let status = response.status();
    if !status.is_success() {
        return Err(match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => CompatibleError::Authentication,
            StatusCode::NOT_FOUND => CompatibleError::NotFound,
            StatusCode::TOO_MANY_REQUESTS => CompatibleError::RateLimited,
            _ if status.is_redirection() => CompatibleError::Redirect,
            _ => CompatibleError::Rejected,
        });
    }
    read_json(response).await.map_err(|error| match error {
        AiError::TimedOut => CompatibleError::Timeout,
        AiError::Unavailable => CompatibleError::Connection,
        _ => CompatibleError::InvalidResponse,
    })
}
