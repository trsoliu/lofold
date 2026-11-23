#![cfg(target_os = "macos")]

mod bridge;
mod server;

pub use bridge::{socket_path, Bridge};
pub use server::run_stdio;

use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SearchScope {
    Inbox,
    Archive,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Search {
    /// Keyword query shown in the LoFold window. Results stay in LoFold.
    pub query: String,
    /// Local search view to open.
    pub scope: SearchScope,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedId {
    /// Share ID returned by lofold_list_shared_mail.
    pub share_id: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DraftText {
    /// To addresses separated by commas. Optional when saving an early draft.
    #[serde(default)]
    pub recipient: String,
    /// Cc addresses separated by commas.
    #[serde(default)]
    pub cc: String,
    /// Bcc addresses separated by commas.
    #[serde(default)]
    pub bcc: String,
    /// Subject line.
    pub subject: String,
    /// Plain text body. Attachments and delivery are handled in LoFold.
    pub body: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftId {
    /// The draft ID returned by lofold_create_draft in this access session.
    pub draft_id: i64,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftUpdate {
    /// The draft ID returned by lofold_create_draft.
    pub draft_id: i64,
    /// Exact revision returned by the last successful create or update.
    pub revision: i64,
    /// Complete replacement subject, recipient fields and plain-text body.
    pub fields: DraftText,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "operation", content = "input", rename_all = "snake_case")]
pub enum Command {
    Status,
    OpenSearch(Search),
    ListSharedMail,
    ReadSharedMail(SharedId),
    CreateDraft(DraftText),
    UpdateDraft(DraftUpdate),
    OpenDraft(DraftId),
}
