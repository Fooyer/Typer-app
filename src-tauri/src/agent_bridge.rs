//! Rust port of `electron/agentBridge.ts`. The MCP server the agent talks to (see the `typer-mcp`
//! binary) runs as its own OS process, spawned by `opencode` — not by us — so it has no direct
//! access to Tauri's state or the webview. This is the loopback HTTP bridge that gives it one
//! anyway: reads/search go straight through to the Atelier API, and writes block here until the
//! frontend resolves them (via the `agent_resolve_pending_write` command), so a proposed edit
//! really does pause the agent until a human approves it.

use crate::atelier::{self, AtelierConnectionConfig};
use crate::specs;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::SyncSender;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Response, Server};

#[derive(Debug, Clone, Serialize)]
pub struct WriteResolution {
    pub approved: bool,
    pub saved: bool,
    #[serde(rename = "compileOutput", skip_serializing_if = "Option::is_none")]
    pub compile_output: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone)]
struct Session {
    token: String,
    namespace: String,
    config: AtelierConnectionConfig,
    app: AppHandle,
    run_id: String,
    specs_dir: String,
}

struct PendingEntry {
    session_token: String,
    name: String,
    content: String,
    sender: SyncSender<WriteResolution>,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Session>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static PENDING: LazyLock<Mutex<HashMap<String, PendingEntry>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SERVER_PORT: LazyLock<Mutex<Option<u16>>> = LazyLock::new(|| Mutex::new(None));

fn ensure_server() -> u16 {
    let mut port_guard = SERVER_PORT.lock().unwrap();
    if let Some(port) = *port_guard {
        return port;
    }
    let server = Server::http("127.0.0.1:0").expect("failed to bind agent bridge server");
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    *port_guard = Some(port);
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            std::thread::spawn(move || handle_request(request));
        }
    });
    port
}

pub fn register_session(
    app: AppHandle,
    namespace: String,
    config: AtelierConnectionConfig,
    run_id: String,
    specs_dir: String,
) -> (u16, String) {
    let port = ensure_server();
    let token = uuid::Uuid::new_v4().to_string();
    SESSIONS.lock().unwrap().insert(
        token.clone(),
        Session { token: token.clone(), namespace, config, app, run_id, specs_dir },
    );
    (port, token)
}

/// Ends the session and rejects any of its writes still waiting on a human decision — otherwise an
/// aborted run would leave the MCP tool call (and the now-dead opencode process behind it) hanging.
pub fn end_session(token: &str) {
    let removed = SESSIONS.lock().unwrap().remove(token).is_some();
    if !removed {
        return;
    }
    let mut pending = PENDING.lock().unwrap();
    let ids: Vec<String> =
        pending.iter().filter(|(_, entry)| entry.session_token == token).map(|(id, _)| id.clone()).collect();
    for id in ids {
        if let Some(entry) = pending.remove(&id) {
            let _ = entry.sender.send(WriteResolution {
                approved: false,
                saved: false,
                compile_output: None,
                error: Some("Sessão do agente encerrada.".to_string()),
                message: None,
            });
        }
    }
}

/// Returns the resolution (not just success/failure) so the frontend can tell a real save from a
/// compile failure — only refreshing the explorer/editor when the write actually landed.
#[tauri::command]
pub async fn agent_resolve_pending_write(
    pending_id: String,
    approved: bool,
) -> Result<Option<WriteResolution>, String> {
    let entry = PENDING.lock().unwrap().remove(&pending_id);
    let Some(entry) = entry else { return Ok(None) };

    if !approved {
        let result = WriteResolution { approved: false, saved: false, compile_output: None, error: None, message: None };
        let _ = entry.sender.send(result.clone());
        return Ok(Some(result));
    }

    let session = SESSIONS.lock().unwrap().get(&entry.session_token).cloned();
    let result = match session {
        None => WriteResolution {
            approved: true,
            saved: false,
            compile_output: None,
            error: Some("Sessão do agente encerrada.".to_string()),
            message: None,
        },
        Some(session) => {
            let content_lines: Vec<String> = entry.content.split('\n').map(|s| s.to_string()).collect();
            match atelier::save_document(&session.config, &session.namespace, &entry.name, content_lines).await {
                Ok(()) => match atelier::compile_documents(&session.config, &session.namespace, vec![entry.name.clone()]).await {
                    Ok(compile_output) => WriteResolution {
                        approved: true,
                        saved: true,
                        compile_output: Some(compile_output),
                        error: None,
                        message: None,
                    },
                    Err(error) => WriteResolution { approved: true, saved: false, compile_output: None, error: Some(error), message: None },
                },
                // The human said yes — a failure here is a save/compile problem, not a rejection.
                Err(error) => WriteResolution { approved: true, saved: false, compile_output: None, error: Some(error), message: None },
            }
        }
    };
    let _ = entry.sender.send(result.clone());
    Ok(Some(result))
}

async fn handle_write(session: &Session, name: String, content: String) -> WriteResolution {
    let current = atelier::get_document(&session.config, &session.namespace, &name).await.ok();
    let server_content = current.map(|doc| doc.content.join("\n")).unwrap_or_default();
    if server_content == content {
        return WriteResolution {
            approved: true,
            saved: true,
            compile_output: None,
            error: None,
            message: Some("Sem alterações — conteúdo já é igual ao do servidor.".to_string()),
        };
    }
    let patch = similar::TextDiff::from_lines(&server_content, &content)
        .unified_diff()
        .header("servidor (atual)", "opencode (proposto)")
        .to_string();
    let pending_id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = std::sync::mpsc::sync_channel::<WriteResolution>(1);
    PENDING.lock().unwrap().insert(
        pending_id.clone(),
        PendingEntry { session_token: session.token.clone(), name: name.clone(), content, sender },
    );
    let _ = session.app.emit(
        "agent:pendingWrite",
        serde_json::json!({ "pendingId": pending_id, "runId": session.run_id, "name": name, "patch": patch }),
    );
    receiver.recv().unwrap_or(WriteResolution {
        approved: false,
        saved: false,
        compile_output: None,
        error: Some("Falha ao aguardar aprovação.".to_string()),
        message: None,
    })
}

fn respond_json(request: tiny_http::Request, status: u16, body: &serde_json::Value) {
    let json = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let response = Response::from_string(json).with_status_code(status).with_header(header);
    let _ = request.respond(response);
}

fn handle_request(mut request: tiny_http::Request) {
    let token = request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("X-Agent-Token"))
        .map(|h| h.value.as_str().to_string());
    let session = token.as_deref().and_then(|t| SESSIONS.lock().unwrap().get(t).cloned());
    let Some(session) = session else {
        respond_json(request, 403, &serde_json::json!({ "error": "Sessão inválida ou expirada." }));
        return;
    };

    let method = request.method().as_str().to_string();
    let raw_url = request.url().to_string();
    let (path, query) = raw_url.split_once('?').unwrap_or((raw_url.as_str(), ""));
    let path = path.to_string();

    let mut body = String::new();
    if method == "POST" {
        let _ = request.as_reader().read_to_string(&mut body);
    }

    let result: Result<(u16, serde_json::Value), String> = tauri::async_runtime::block_on(async {
        route(&session, &method, &path, query, body).await
    });

    match result {
        Ok((status, body)) => respond_json(request, status, &body),
        Err(error) => respond_json(request, 500, &serde_json::json!({ "error": error })),
    }
}

/// Every route below that talks to the real IRIS server goes through this — a hard ceiling on top
/// of whatever timeout `atelier.rs`'s own HTTP client already applies, so that if a tool call ever
/// gets stuck somewhere else in the chain (e.g. waiting on the per-connection concurrency
/// semaphore), the MCP tool call still gets an answer instead of hanging opencode's turn forever.
/// Deliberately NOT used for the write/approval route below — that one waits on a human, which can
/// legitimately take much longer than any of this.
const ATELIER_ROUTE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(40);

async fn with_route_timeout<T>(
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    match tokio::time::timeout(ATELIER_ROUTE_TIMEOUT, future).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "Tempo limite excedido ({}s) consultando o servidor IRIS através da ponte do agente.",
            ATELIER_ROUTE_TIMEOUT.as_secs()
        )),
    }
}

async fn route(
    session: &Session,
    method: &str,
    path: &str,
    query: &str,
    body: String,
) -> Result<(u16, serde_json::Value), String> {
    if method == "GET" && path == "/documents" {
        let docs =
            with_route_timeout(atelier::list_documents(&session.config, &session.namespace, false)).await?;
        return Ok((200, serde_json::to_value(docs).unwrap()));
    }
    if method == "GET" && path.starts_with("/documents/") {
        let name = urlencoding::decode(&path["/documents/".len()..]).map_err(|e| e.to_string())?.into_owned();
        let doc =
            with_route_timeout(atelier::get_document(&session.config, &session.namespace, &name)).await?;
        return Ok((200, serde_json::json!({ "content": doc.content.join("\n") })));
    }
    if method == "GET" && path == "/specs" {
        let files = specs::specs_list(session.specs_dir.clone())?;
        let names: Vec<String> = files.into_iter().map(|f| f.name).collect();
        return Ok((200, serde_json::to_value(names).unwrap()));
    }
    if method == "GET" && path.starts_with("/specs/") {
        let name = urlencoding::decode(&path["/specs/".len()..]).map_err(|e| e.to_string())?.into_owned();
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
            return Ok((400, serde_json::json!({ "error": "Nome de spec inválido." })));
        }
        let file_path = PathBuf::from(&session.specs_dir).join(&name);
        let content = specs::specs_read(file_path.to_string_lossy().into_owned())?;
        return Ok((200, serde_json::json!({ "content": content })));
    }
    if method == "POST" && path.starts_with("/specs/") {
        let name = urlencoding::decode(&path["/specs/".len()..]).map_err(|e| e.to_string())?.into_owned();
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
            return Ok((400, serde_json::json!({ "error": "Nome de spec inválido." })));
        }
        let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let content = parsed.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let file_name = specs::resolve_spec_file_name(&name)?;
        let file_path = PathBuf::from(&session.specs_dir).join(&file_name);
        specs::specs_write(file_path.to_string_lossy().into_owned(), content)?;
        return Ok((200, serde_json::json!({ "name": file_name })));
    }
    if method == "GET" && path == "/search" {
        let query_param = form_query(query).get("q").cloned().unwrap_or_default();
        match with_route_timeout(atelier::search_in_files(
            &session.config,
            &session.namespace,
            &query_param,
            "*.cls,*.mac,*.int,*.inc",
            false,
        ))
        .await
        {
            Ok(results) => return Ok((200, serde_json::to_value(results).unwrap())),
            Err(error) => {
                return Ok((
                    200,
                    serde_json::json!({
                        "error": error,
                        "note": "Busca não disponível neste servidor; leia documentos específicos em vez disso.",
                    }),
                ));
            }
        }
    }
    if method == "POST" && path.starts_with("/documents/") {
        let name = urlencoding::decode(&path["/documents/".len()..]).map_err(|e| e.to_string())?.into_owned();
        let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let content = parsed.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let result = handle_write(session, name, content).await;
        return Ok((200, serde_json::to_value(result).unwrap()));
    }
    Ok((404, serde_json::json!({ "error": "Rota desconhecida." })))
}

fn form_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter(|s| !s.is_empty())
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            let value = urlencoding::decode(value).ok()?.into_owned();
            Some((key.to_string(), value))
        })
        .collect()
}
