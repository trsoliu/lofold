use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{canonical_base_url, valid_compatible_model, AiError, Answer, CompatibleError};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApiProtocol {
    #[default]
    ChatCompletions,
    Responses,
    Anthropic,
    Gemini,
}

pub(crate) fn gemini_id(input: &str) -> Option<&str> {
    let id = input.strip_prefix("models/").unwrap_or(input);
    (id.len() <= 256
        && id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)))
    .then_some(id)
}

/// The same URL used on the wire and shown when asking permission to send the material.
pub fn generation_url(
    protocol: ApiProtocol,
    base_url: &str,
    model: &str,
) -> Result<String, AiError> {
    let base = canonical_base_url(base_url)?;
    if protocol == ApiProtocol::Gemini {
        let id = gemini_id(model).ok_or(CompatibleError::InvalidModel)?;
        return Ok(format!("{base}/models/{id}:generateContent"));
    }
    if !valid_compatible_model(model) {
        return Err(CompatibleError::InvalidModel.into());
    }
    Ok(format!(
        "{base}/{}",
        match protocol {
            ApiProtocol::ChatCompletions => "chat/completions",
            ApiProtocol::Responses => "responses",
            ApiProtocol::Anthropic => "messages",
            ApiProtocol::Gemini => unreachable!(),
        }
    ))
}

impl ApiProtocol {
    pub(crate) fn generation_body(
        self,
        model: &str,
        system: &str,
        prompt: &str,
        tokens: u32,
    ) -> Value {
        match self {
            Self::ChatCompletions => json!({
                "model": model,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
                "max_completion_tokens": tokens,
            }),
            Self::Responses => json!({
                "model": model, "instructions": system, "input": prompt,
                "max_output_tokens": tokens, "store": false,
            }),
            Self::Anthropic => json!({
                "model": model, "system": system, "messages": [{"role": "user", "content": prompt}],
                "max_tokens": tokens,
            }),
            Self::Gemini => json!({
                "systemInstruction": { "parts": [{"text": system}] },
                "contents": [{"role":"user", "parts":[{"text":prompt}]}],
                "generationConfig": { "maxOutputTokens": tokens },
            }),
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct Chat {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChatMessage,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct ChatMessage {
    content: Option<String>,
}

impl Chat {
    pub(crate) fn answer(self) -> Result<Answer, CompatibleError> {
        let choice = self
            .choices
            .into_iter()
            .next()
            .ok_or(CompatibleError::InvalidResponse)?;
        answer(
            choice.message.content.unwrap_or_default(),
            choice.finish_reason.as_deref() != Some("stop"),
        )
    }
}

#[derive(Deserialize)]
pub(crate) struct Responses {
    status: String,
    #[serde(default)]
    output: Vec<OutputItem>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutputItem {
    Message {
        role: String,
        phase: Option<String>,
        content: Vec<OutputPart>,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutputPart {
    OutputText {
        text: String,
    },
    #[serde(other)]
    Other,
}

impl Responses {
    pub(crate) fn answer(self) -> Result<Answer, CompatibleError> {
        let incomplete = match self.status.as_str() {
            "completed" => false,
            "incomplete" => true,
            _ => return Err(CompatibleError::Rejected),
        };
        let mut messages = Vec::new();
        for item in self.output {
            if let OutputItem::Message {
                role,
                phase,
                content,
            } = item
            {
                if role == "assistant" && matches!(phase.as_deref(), None | Some("final_answer")) {
                    let text: String = content
                        .into_iter()
                        .filter_map(|part| match part {
                            OutputPart::OutputText { text } => Some(text),
                            OutputPart::Other => None,
                        })
                        .collect();
                    if !text.is_empty() {
                        messages.push(text);
                    }
                }
            }
        }
        answer(messages.join("\n"), incomplete)
    }
}

#[derive(Deserialize)]
pub(crate) struct AnthropicMessage {
    content: Vec<AnthropicBlock>,
    stop_reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AnthropicBlock {
    Text {
        text: String,
    },
    #[serde(other)]
    Other,
}

impl AnthropicMessage {
    pub(crate) fn answer(self) -> Result<Answer, CompatibleError> {
        let incomplete = match self.stop_reason.as_deref() {
            Some("end_turn" | "stop_sequence") => false,
            Some("max_tokens" | "model_context_window_exceeded") => true,
            _ => return Err(CompatibleError::Rejected),
        };
        let text = self
            .content
            .into_iter()
            .filter_map(|block| match block {
                AnthropicBlock::Text { text } => Some(text),
                AnthropicBlock::Other => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        answer(text, incomplete)
    }
}

#[derive(Deserialize)]
pub(crate) struct GeminiResponse {
    #[serde(default)]
    candidates: Vec<Candidate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    content: Option<GeminiContent>,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Deserialize)]
struct GeminiPart {
    #[serde(default)]
    thought: bool,
    text: Option<String>,
}

impl GeminiResponse {
    pub(crate) fn answer(self) -> Result<Answer, CompatibleError> {
        let candidate = self
            .candidates
            .into_iter()
            .next()
            .ok_or(CompatibleError::Rejected)?;
        let incomplete = match candidate.finish_reason.as_deref() {
            Some("STOP") => false,
            Some("MAX_TOKENS") => true,
            _ => return Err(CompatibleError::Rejected),
        };
        let parts = candidate
            .content
            .ok_or(CompatibleError::InvalidResponse)?
            .parts;
        answer(
            parts
                .into_iter()
                .filter(|part| !part.thought)
                .filter_map(|part| part.text)
                .collect(),
            incomplete,
        )
    }
}

fn answer(text: String, incomplete: bool) -> Result<Answer, CompatibleError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(CompatibleError::InvalidResponse);
    }
    Ok(Answer {
        text: text.to_owned(),
        incomplete,
    })
}
