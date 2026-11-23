use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    thread,
};

use lofold_mail_ai::{
    canonical_base_url, generation_url, is_loopback_base_url, valid_api_key,
    valid_compatible_model, AiError, ApiProtocol, CompatibleClient, CompatibleError,
};
use serde_json::{json, Value};

struct Request {
    request_line: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn fixture(responses: Vec<String>) -> (String, thread::JoinHandle<Vec<Request>>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let base = format!("http://{}/gateway/v1", listener.local_addr().unwrap());
    let requests = thread::spawn(move || {
        let mut requests = Vec::new();
        for response in responses {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(&stream);
            let mut lines = reader.by_ref().lines();
            let request_line = lines.next().unwrap().unwrap();
            let mut headers = BTreeMap::new();
            let mut size = 0;
            for line in lines
                .map(Result::unwrap)
                .take_while(|line| !line.is_empty())
            {
                let (name, value) = line.split_once(':').unwrap();
                headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
                if name.eq_ignore_ascii_case("content-length") {
                    size = value.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; size];
            reader.read_exact(&mut body).unwrap();
            requests.push(Request {
                request_line,
                headers,
                body,
            });
            stream.write_all(response.as_bytes()).unwrap();
        }
        requests
    });
    (base, requests)
}

fn reply(status: &str, body: Value) -> String {
    let data = body.to_string();
    format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}", data.len())
}

fn run<F: std::future::Future>(task: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(task)
}

fn completion(reason: &str) -> Value {
    json!({"choices":[{"message":{"content":"  合成回复  ","reasoning_content":"hidden"},"finish_reason":reason}]})
}

#[test]
fn address_and_credentials_have_a_single_service_identity() {
    assert_eq!(
        canonical_base_url(" https://API.EXAMPLE.test:443/api/v1/ ").unwrap(),
        "https://api.example.test/api/v1"
    );
    assert_ne!(
        canonical_base_url("https://api.example.test/a").unwrap(),
        canonical_base_url("https://api.example.test/b").unwrap()
    );
    for url in [
        "http://localhost:8080/v1",
        "http://127.1.2.3/v1",
        "https://[::1]/api",
    ] {
        assert!(is_loopback_base_url(url).unwrap());
    }
    for url in [
        "https://api.example.test/v1",
        "https://127.0.0.1.example.test",
        "https://ai.localhost",
    ] {
        assert!(!is_loopback_base_url(url).unwrap());
    }
    for url in [
        "",
        "localhost:11434",
        "http://10.0.0.1",
        "http://api.example.test/v1",
        "http://ai.localhost",
        "http://[::ffff:127.0.0.1]",
        "http://127.0.0.1.example.test",
        "https://user@server/v1",
        "https://@server/v1",
        "https://:secret@server/v1",
        "https://server/v1?token=test",
        "https://server/#abc",
        "ftp://server/v1",
        "https://localhost:0",
        "https:////server/v1",
        "https://server\\other/path",
    ] {
        assert!(canonical_base_url(url).is_err(), "{url}");
    }
    assert!(valid_api_key("fixture:key+/="));
    assert!(!valid_api_key(""));
    assert!(!valid_api_key("x\r\nx-test: secret"));
    assert!(valid_compatible_model("provider/name:variant@v1"));
    assert!(!valid_compatible_model("model\nsecond"));
    assert!(!valid_compatible_model(&"x".repeat(257)));
    assert!(CompatibleClient::new("https://service.example/v1", Some("bad key")).is_err());
}

#[test]
fn lists_models_and_reuses_the_same_service_and_bearer_for_completions() {
    let (base, server) = fixture(vec![
        reply(
            "200 OK",
            json!({"data":[{"id":"model-z"},{"id":"model-b"},{"id":"model-z"},{"id":"\nbad"}]}),
        ),
        reply("200 OK", completion("stop")),
        reply("200 OK", completion("length")),
    ]);
    let client = CompatibleClient::new(&base, Some("synthetic-key")).unwrap();
    run(async {
        assert_eq!(client.models().await.unwrap(), ["model-b", "model-z"]);
        let answer = client
            .generate("model-b", "合成系统文本", "提取关键词", 120, true)
            .await
            .unwrap();
        assert_eq!(answer.text, "合成回复");
        assert!(!answer.incomplete);
        assert!(
            client
                .generate("model-b", "system", "prompt", 512, false)
                .await
                .unwrap()
                .incomplete
        );
    });
    let requests = server.join().unwrap();
    assert_eq!(requests[0].request_line, "GET /gateway/v1/models HTTP/1.1");
    assert_eq!(
        requests[1].request_line,
        "POST /gateway/v1/chat/completions HTTP/1.1"
    );
    assert!(requests.iter().all(|request| request
        .headers
        .get("authorization")
        .map(String::as_str)
        == Some("Bearer synthetic-key")));
    let payload: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(payload["model"], "model-b");
    assert_eq!(payload["messages"][1]["content"], "提取关键词");
    assert!(payload["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("JSON"));
    assert!(payload.get("response_format").is_none());
    assert_eq!(payload["max_completion_tokens"], 120);
}

#[test]
fn direct_chat_allows_manual_ids_without_auth_or_model_discovery_and_supports_legacy_token_limits()
{
    let (base, server) = fixture(vec![
        reply(
            "400 Bad Request",
            json!({"error":{"param":"max_completion_tokens","code":"unsupported_parameter"}}),
        ),
        reply("200 OK", completion("stop")),
    ]);
    let client = CompatibleClient::new(&base, None).unwrap();
    assert_eq!(
        run(client.generate("provider/manual", "system", "prompt", 125, false))
            .unwrap()
            .text,
        "合成回复"
    );
    let requests = server.join().unwrap();
    for request in &requests {
        assert_eq!(
            request.request_line,
            "POST /gateway/v1/chat/completions HTTP/1.1"
        );
        assert!(!request.headers.contains_key("authorization"));
    }
    let payload: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert!(payload.get("max_completion_tokens").is_none());
    assert_eq!(payload["max_tokens"], 125);
    assert_eq!(payload["messages"][0]["content"], "system");
}

#[test]
fn failures_never_forward_raw_responses_or_redirect_credentials_and_response_size_is_bounded() {
    let redirection = "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:1/synthetic-key\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned();
    let oversized =
        "HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\nConnection: close\r\n\r\n".to_owned();
    let (base, server) = fixture(vec![
        redirection,
        reply(
            "401 Unauthorized",
            json!({"error":{"message":"synthetic-key raw fixture response"}}),
        ),
        reply(
            "400 Bad Request",
            json!({"error":{"message":"synthetic-key raw fixture response"}}),
        ),
        oversized,
        reply(
            "200 OK",
            json!({"choices":[{"message":{"content":null},"finish_reason":"stop"}]}),
        ),
    ]);
    let client = CompatibleClient::new(&base, Some("synthetic-key")).unwrap();
    run(async {
        assert!(matches!(
            client.models().await,
            Err(AiError::Compatible(CompatibleError::Redirect))
        ));
        let err = client.models().await.unwrap_err();
        assert!(matches!(
            err,
            AiError::Compatible(CompatibleError::Authentication)
        ));
        for result in [err.to_string(), format!("{err:?}")] {
            assert!(
                !result.contains("synthetic-key")
                    && !result.contains("raw fixture")
                    && !result.contains(&base)
            );
        }
        assert!(matches!(
            client.generate("m", "s", "p", 10, false).await,
            Err(AiError::Compatible(CompatibleError::Rejected))
        ));
        assert!(matches!(
            client.models().await,
            Err(AiError::Compatible(CompatibleError::InvalidResponse))
        ));
        assert!(matches!(
            client.generate("m", "s", "p", 10, false).await,
            Err(AiError::Compatible(CompatibleError::InvalidResponse))
        ));
    });
    assert_eq!(server.join().unwrap().len(), 5);
}

fn assert_auth(request: &Request, protocol: ApiProtocol) {
    let expected = match protocol {
        ApiProtocol::ChatCompletions | ApiProtocol::Responses => {
            [Some("Bearer synthetic-key"), None, None, None]
        }
        ApiProtocol::Anthropic => [None, Some("synthetic-key"), None, Some("2023-06-01")],
        ApiProtocol::Gemini => [None, None, Some("synthetic-key"), None],
    };
    let actual = [
        "authorization",
        "x-api-key",
        "x-goog-api-key",
        "anthropic-version",
    ]
    .map(|header| request.headers.get(header).map(String::as_str));
    assert_eq!(actual, expected);
    assert!(!request.request_line.contains("synthetic-key"));
}

#[test]
fn responses_lists_models_and_only_uses_final_answer_output_text() {
    let response = |status: &str| {
        json!({"status": status, "output": [
            {"type":"reasoning","summary":[{"text":"hidden reasoning"}]},
            {"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"intermediate"}]},
            {"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"合成"},{"type":"output_text","text":"回复"}]},
            {"type":"function_call","arguments":"sensitive"},
        ]})
    };
    let (base, server) = fixture(vec![
        reply("200 OK", json!({"data":[{"id":"r-1"}]})),
        reply("200 OK", response("completed")),
        reply("200 OK", response("incomplete")),
        reply("200 OK", response("failed")),
    ]);
    let client =
        CompatibleClient::with_protocol(ApiProtocol::Responses, &base, Some("synthetic-key"))
            .unwrap();
    run(async {
        assert_eq!(client.models().await.unwrap(), ["r-1"]);
        let answer = client
            .generate("r-1", "指令", "合成邮件", 120, true)
            .await
            .unwrap();
        assert_eq!(answer.text, "合成回复");
        assert!(!answer.incomplete);
        assert!(
            client
                .generate("r-1", "s", "p", 120, false)
                .await
                .unwrap()
                .incomplete
        );
        assert!(matches!(
            client.generate("r-1", "s", "p", 120, false).await,
            Err(AiError::Compatible(CompatibleError::Rejected))
        ));
    });
    let requests = server.join().unwrap();
    for request in &requests {
        assert_auth(request, ApiProtocol::Responses);
    }
    assert_eq!(requests[0].request_line, "GET /gateway/v1/models HTTP/1.1");
    assert_eq!(
        requests[1].request_line,
        "POST /gateway/v1/responses HTTP/1.1"
    );
    let body: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(body["store"], false);
    assert_eq!(body["input"], "合成邮件");
    assert_eq!(body["max_output_tokens"], 120);
    assert_eq!(body["model"], "r-1");
    assert!(body["instructions"].as_str().unwrap().contains("JSON"));
    assert!(body.get("messages").is_none());
}

#[test]
fn anthropic_lists_all_pages_and_preserves_text_blocks_without_thinking_or_tools() {
    let result = |stop: &str| {
        json!({"role":"assistant","type":"message","stop_reason":stop,"content":[
            {"type":"thinking","thinking":"internal"}, {"type":"text","text":"摘要"},
            {"type":"tool_use","input":{"text":"hidden"}}, {"type":"text","text":"结束"},
        ]})
    };
    let (base, server) = fixture(vec![
        reply(
            "200 OK",
            json!({"data":[{"id":"m2"}],"has_more":true,"last_id":"m/2"}),
        ),
        reply("200 OK", json!({"data":[{"id":"m1"}],"has_more":false})),
        reply("200 OK", result("end_turn")),
        reply("200 OK", result("max_tokens")),
        reply("200 OK", result("tool_use")),
    ]);
    let client =
        CompatibleClient::with_protocol(ApiProtocol::Anthropic, &base, Some("synthetic-key"))
            .unwrap();
    run(async {
        assert_eq!(client.models().await.unwrap(), ["m1", "m2"]);
        let answer = client
            .generate("m1", "指令", "合成邮件", 240, true)
            .await
            .unwrap();
        assert_eq!(answer.text, "摘要\n结束");
        assert!(!answer.incomplete);
        assert!(
            client
                .generate("m1", "s", "p", 240, false)
                .await
                .unwrap()
                .incomplete
        );
        assert!(matches!(
            client.generate("m1", "s", "p", 240, false).await,
            Err(AiError::Compatible(CompatibleError::Rejected))
        ));
    });
    let requests = server.join().unwrap();
    for request in &requests {
        assert_auth(request, ApiProtocol::Anthropic);
    }
    assert_eq!(requests[0].request_line, "GET /gateway/v1/models HTTP/1.1");
    assert_eq!(
        requests[1].request_line,
        "GET /gateway/v1/models?after_id=m%2F2 HTTP/1.1"
    );
    assert_eq!(
        requests[2].request_line,
        "POST /gateway/v1/messages HTTP/1.1"
    );
    let body: Value = serde_json::from_slice(&requests[2].body).unwrap();
    assert!(body["system"].as_str().unwrap().contains("JSON"));
    assert_eq!(body["max_tokens"], 240);
    assert_eq!(body["model"], "m1");
    assert_eq!(
        body["messages"],
        json!([{"role":"user","content":"合成邮件"}])
    );
}

#[test]
fn gemini_normalizes_generation_models_and_uses_only_non_thought_parts_of_first_candidate() {
    let result = |stop: &str| {
        json!({"candidates":[{"finishReason":stop,"content":{"role":"model","parts":[
        {"thought":true,"text":"private"}, {"text":"合成"}, {"functionCall":{"name":"skip"}}, {"text":"回复","thoughtSignature":"hidden"},
    ]}},{"finishReason":"STOP","content":{"parts":[{"text":"other"}]}}]})
    };
    let (base, server) = fixture(vec![
        reply(
            "200 OK",
            json!({"models":[{"name":"models/g-model.2","supportedGenerationMethods":["generateContent"]},{"name":"models/embed","supportedGenerationMethods":["embedContent"]},{"name":"models/../../escape","supportedGenerationMethods":["generateContent"]}],"nextPageToken":"a+b/c"}),
        ),
        reply(
            "200 OK",
            json!({"models":[{"name":"models/g-model.2","supportedGenerationMethods":["generateContent"]}]}),
        ),
        reply("200 OK", result("STOP")),
        reply("200 OK", result("MAX_TOKENS")),
        reply("200 OK", result("SAFETY")),
    ]);
    let client =
        CompatibleClient::with_protocol(ApiProtocol::Gemini, &base, Some("synthetic-key")).unwrap();
    run(async {
        assert_eq!(client.models().await.unwrap(), ["g-model.2"]);
        let answer = client
            .generate("models/g-model.2", "指令", "合成邮件", 320, true)
            .await
            .unwrap();
        assert_eq!(answer.text, "合成回复");
        assert!(!answer.incomplete);
        assert!(
            client
                .generate("g-model.2", "s", "p", 320, false)
                .await
                .unwrap()
                .incomplete
        );
        assert!(matches!(
            client.generate("g-model.2", "s", "p", 320, false).await,
            Err(AiError::Compatible(CompatibleError::Rejected))
        ));
    });
    let requests = server.join().unwrap();
    for request in &requests {
        assert_auth(request, ApiProtocol::Gemini);
    }
    assert_eq!(requests[0].request_line, "GET /gateway/v1/models HTTP/1.1");
    assert_eq!(
        requests[1].request_line,
        "GET /gateway/v1/models?pageToken=a%2Bb%2Fc HTTP/1.1"
    );
    assert_eq!(
        requests[2].request_line,
        "POST /gateway/v1/models/g-model.2:generateContent HTTP/1.1"
    );
    let body: Value = serde_json::from_slice(&requests[2].body).unwrap();
    assert!(body["systemInstruction"]["parts"][0]["text"]
        .as_str()
        .unwrap()
        .contains("JSON"));
    assert_eq!(body["generationConfig"]["maxOutputTokens"], 320);
    assert_eq!(
        body["contents"],
        json!([{"role":"user","parts":[{"text":"合成邮件"}]}])
    );
    assert!(body.get("model").is_none());
}

#[test]
fn endpoint_identity_never_interprets_model_input_as_a_url() {
    let base = "https://example.test/proxy/";
    assert_eq!(ApiProtocol::default(), ApiProtocol::ChatCompletions);
    for (wire, protocol, path) in [
        (
            "chat_completions",
            ApiProtocol::ChatCompletions,
            "chat/completions",
        ),
        ("responses", ApiProtocol::Responses, "responses"),
        ("anthropic", ApiProtocol::Anthropic, "messages"),
        (
            "gemini",
            ApiProtocol::Gemini,
            "models/test-model:generateContent",
        ),
    ] {
        assert_eq!(
            serde_json::from_value::<ApiProtocol>(json!(wire)).unwrap(),
            protocol
        );
        assert_eq!(
            generation_url(protocol, base, "test-model").unwrap(),
            format!("https://example.test/proxy/{path}")
        );
    }
    for id in [
        "",
        ".",
        "..",
        "-bad",
        "models/",
        "x/y",
        "x%2fy",
        "x%252fy",
        "x\\y",
        "x:y",
        "?k",
        "x#part",
        "//host",
        "models/models/a",
        "models/../a",
    ] {
        assert!(
            generation_url(ApiProtocol::Gemini, base, id).is_err(),
            "{id}"
        );
    }
    assert!(generation_url(ApiProtocol::Gemini, base, &"a".repeat(257)).is_err());
    assert_eq!(
        generation_url(ApiProtocol::Gemini, base, "models/gemini-2.5-flash").unwrap(),
        "https://example.test/proxy/models/gemini-2.5-flash:generateContent"
    );
}

#[test]
fn each_native_protocol_rejects_redirects_sanitizes_server_errors_and_never_adds_an_unconfigured_key(
) {
    for protocol in [
        ApiProtocol::Responses,
        ApiProtocol::Anthropic,
        ApiProtocol::Gemini,
    ] {
        let (base,server)=fixture(vec![
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:1/synthetic-key\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
            reply("401 Unauthorized",json!({"error":{"message":"raw-secret-body"}})),
            reply("429 Too Many Requests",json!({"error":{"message":"raw-secret-body"}})),
        ]);
        let client = CompatibleClient::with_protocol(protocol, &base, None).unwrap();
        run(async {
            assert!(matches!(
                client.generate("m", "s", "p", 64, false).await,
                Err(AiError::Compatible(CompatibleError::Redirect))
            ));
            let error = client.models().await.unwrap_err();
            assert!(matches!(
                error,
                AiError::Compatible(CompatibleError::Authentication)
            ));
            assert!(!error.to_string().contains("raw-secret-body"));
            assert!(matches!(
                client.generate("m", "s", "p", 64, false).await,
                Err(AiError::Compatible(CompatibleError::RateLimited))
            ));
        });
        for req in server.join().unwrap() {
            assert!(["authorization", "x-api-key", "x-goog-api-key"]
                .iter()
                .all(|name| !req.headers.contains_key(*name)));
        }
    }
}
