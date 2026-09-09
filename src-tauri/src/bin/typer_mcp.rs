//! Rust port of `electron/mcp/irisMcpServer.ts` and `specsMcpServer.ts`, merged into a single
//! sidecar binary with two modes (selected by `argv[1]`: "iris" or "specs") — replaces the two
//! standalone Node scripts opencode used to spawn, so the shipped app no longer needs a bundled
//! Node runtime just to run them.
//!
//! Spawned by `opencode` itself (per the `mcp` section of the `opencode.json` generated in
//! `agent_run.rs`), not by this app directly — it has no access to Tauri state, so every tool here
//! proxies to the loopback HTTP bridge in `agent_bridge.rs` instead of touching the Atelier API or
//! the filesystem directly. Talks MCP (JSON-RPC 2.0) over stdio, one message per line.

use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

struct Bridge {
    base_url: String,
    token: String,
}

impl Bridge {
    /// `timeout: None` is for the one call (`propose_write`) that waits on a human clicking
    /// approve/reject in the UI — that can legitimately take minutes, so it must not be bounded the
    /// same way a read/list/search call is. Everything else should pass a real timeout: the bridge
    /// (`agent_bridge.rs`) already bounds its own read routes, but this is the backstop for the
    /// bridge itself being unreachable or wedged, so a tool call never hangs the agent's turn
    /// forever no matter which side of the pipe actually got stuck.
    fn fetch(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        timeout: Option<std::time::Duration>,
    ) -> Result<Value, String> {
        let mut builder = reqwest::blocking::Client::builder();
        if let Some(timeout) = timeout {
            builder = builder.timeout(timeout);
        }
        let client = builder.build().map_err(|e| e.to_string())?;
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let mut request =
            client.request(method, format!("{}{}", self.base_url, path)).header("X-Agent-Token", &self.token);
        if let Some(body) = &body {
            request = request.header("Content-Type", "application/json").json(body);
        }
        let response = request.send().map_err(|e| e.to_string())?;
        let status = response.status();
        let text = response.text().map_err(|e| e.to_string())?;
        let data: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));
        if !status.is_success() {
            let message = data.get("error").and_then(|v| v.as_str()).unwrap_or(&text).to_string();
            return Err(message);
        }
        Ok(data)
    }
}

fn text_content(text: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }] })
}

fn error_content(text: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }], "isError": true })
}

fn iris_tools() -> Value {
    json!([
        {
            "name": "list_documents",
            "description": "Lista as classes e rotinas ObjectScript existentes no namespace conectado. \
                Sem argumentos, retorna um RESUMO por pacote (nome do pacote + quantidade de documentos) — \
                use isso primeiro para se situar. Para ver os documentos de um pacote específico (ex: todos \
                os arquivos do pacote 'Wiki'), chame de novo passando 'filter' com o nome do pacote ou um \
                trecho do nome do documento.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filter": {
                        "type": "string",
                        "description": "Pacote ou trecho do nome para filtrar (ex: 'Wiki'). Sem isso, retorna \
                            só o resumo por pacote em vez da lista completa.",
                    },
                },
            },
        },
        {
            "name": "read_document",
            "description": "Lê o conteúdo atual de uma classe ou rotina no servidor (ex: 'Pacote.Classe.cls'). \
                Sempre use isto antes de propor uma escrita, para editar em cima do conteúdo real e atual.",
            "inputSchema": {
                "type": "object",
                "properties": { "name": { "type": "string", "description": "Nome do documento, ex: Pacote.Classe.cls" } },
                "required": ["name"],
            },
        },
        {
            "name": "search",
            "description": "Busca um texto no código-fonte de todas as classes/rotinas do namespace.",
            "inputSchema": {
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"],
            },
        },
        {
            "name": "propose_write",
            "description": "Propõe salvar o CONTEÚDO COMPLETO de uma classe/rotina no servidor (não um diff \
                parcial). Isso NÃO salva imediatamente: fica pendente até um humano aprovar ou rejeitar na \
                interface. Confira os campos 'approved' (decisão do usuário) e 'saved' (se realmente foi \
                gravado) no resultado — 'approved: true, saved: false' significa que o usuário aprovou mas a \
                gravação falhou (ex: timeout com o servidor), então pode valer a pena tentar de novo; \
                'approved: false' significa que o usuário rejeitou e não deve ser tentado de novo sem perguntar.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Nome do documento, ex: Pacote.Classe.cls" },
                    "content": { "type": "string", "description": "Conteúdo completo do arquivo após a alteração" },
                },
                "required": ["name", "content"],
            },
        },
    ])
}

fn specs_tools() -> Value {
    json!([
        {
            "name": "list",
            "description": "Lista os arquivos .md da aba 'Specs' deste projeto — planos, notas e \
                especificações que o usuário escreveu sobre o que construir. NÃO tem relação com as \
                classes/rotinas do namespace IRIS (essas usam as ferramentas 'iris_*'); são arquivos locais \
                completamente separados.",
            "inputSchema": { "type": "object", "properties": {} },
        },
        {
            "name": "read",
            "description": "Lê o conteúdo de um arquivo .md da aba 'Specs' pelo nome (ex: 'plano.md'). Leia \
                apenas as specs cujo nome pareça relevante para a tarefa atual, não todas indiscriminadamente.",
            "inputSchema": {
                "type": "object",
                "properties": { "name": { "type": "string", "description": "Nome do arquivo .md, ex: plano.md" } },
                "required": ["name"],
            },
        },
        {
            "name": "write",
            "description": "Cria ou sobrescreve um arquivo .md da aba 'Specs' com o CONTEÚDO COMPLETO \
                informado (não um diff parcial — se o arquivo já existir, o conteúdo antigo é perdido). Cria \
                o arquivo se ele ainda não existir. Ao contrário de uma escrita de código (iris_propose_write), \
                isto NÃO espera aprovação humana — specs são notas locais de planejamento, não algo que é \
                compilado ou vai para o servidor. Sempre que possível, leia o arquivo com 'read' primeiro para \
                não apagar conteúdo relevante sem querer.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Nome do arquivo .md, ex: plano.md (criado se não existir)" },
                    "content": { "type": "string", "description": "Conteúdo completo do arquivo após a alteração" },
                },
                "required": ["name", "content"],
            },
        },
    ])
}

/// Bounds every read/search/list call to the bridge — long enough for the bridge's own 40s route
/// timeout (see agent_bridge.rs) to fire first and give a more specific error, short enough that a
/// genuinely unreachable bridge doesn't hang the tool call much longer than that.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(50);

fn call_iris_tool(bridge: &Bridge, name: &str, args: &Value) -> Value {
    match name {
        "list_documents" => {
            let filter = args.get("filter").and_then(|v| v.as_str()).unwrap_or("");
            let path = if filter.is_empty() {
                "/documents".to_string()
            } else {
                format!("/documents?filter={}", urlencoding::encode(filter))
            };
            match bridge.fetch("GET", &path, None, Some(READ_TIMEOUT)) {
                Ok(docs) => text_content(docs.to_string()),
                Err(e) => error_content(e),
            }
        }
        "read_document" => {
            let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("");
            match bridge.fetch(
                "GET",
                &format!("/documents/{}", urlencoding::encode(name)),
                None,
                Some(READ_TIMEOUT),
            ) {
                Ok(doc) => text_content(doc.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string()),
                Err(e) => error_content(e),
            }
        }
        "search" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            match bridge.fetch(
                "GET",
                &format!("/search?q={}", urlencoding::encode(query)),
                None,
                Some(READ_TIMEOUT),
            ) {
                Ok(results) => text_content(results.to_string()),
                Err(e) => error_content(e),
            }
        }
        "propose_write" => {
            let doc_name = args.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
            // No timeout: this waits on a human clicking approve/reject in the UI, which can
            // legitimately take much longer than any of the read routes above.
            match bridge.fetch(
                "POST",
                &format!("/documents/{}", urlencoding::encode(&doc_name)),
                Some(json!({ "content": content })),
                None,
            ) {
                Ok(result) => {
                    let approved = result.get("approved").and_then(|v| v.as_bool()).unwrap_or(false);
                    let saved = result.get("saved").and_then(|v| v.as_bool()).unwrap_or(false);
                    if !approved {
                        return error_content(format!("approved: false — o usuário rejeitou a escrita em {doc_name}."));
                    }
                    if !saved {
                        let error = result.get("error").and_then(|v| v.as_str()).unwrap_or("erro desconhecido");
                        return error_content(format!(
                            "approved: true, saved: false — o usuário aprovou, mas gravar {doc_name} no servidor falhou: {error}"
                        ));
                    }
                    let compile_output = result.get("compileOutput").and_then(|v| v.as_array());
                    let extra = if let Some(lines) = compile_output.filter(|l| !l.is_empty()) {
                        format!(
                            "\nSaída da compilação:\n{}",
                            lines.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join("\n")
                        )
                    } else if let Some(message) = result.get("message").and_then(|v| v.as_str()) {
                        format!("\n{message}")
                    } else {
                        String::new()
                    };
                    text_content(format!("approved: true, saved: true — {doc_name} salvo e compilado.{extra}"))
                }
                Err(e) => error_content(e),
            }
        }
        _ => error_content(format!("Ferramenta desconhecida: {name}")),
    }
}

fn call_specs_tool(bridge: &Bridge, name: &str, args: &Value) -> Value {
    match name {
        "list" => match bridge.fetch("GET", "/specs", None, Some(READ_TIMEOUT)) {
            Ok(names) => text_content(names.to_string()),
            Err(e) => error_content(e),
        },
        "read" => {
            let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("");
            match bridge.fetch(
                "GET",
                &format!("/specs/{}", urlencoding::encode(name)),
                None,
                Some(READ_TIMEOUT),
            ) {
                Ok(doc) => text_content(doc.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string()),
                Err(e) => error_content(e),
            }
        }
        "write" => {
            let spec_name = args.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
            match bridge.fetch(
                "POST",
                &format!("/specs/{}", urlencoding::encode(&spec_name)),
                Some(json!({ "content": content })),
                Some(READ_TIMEOUT),
            ) {
                Ok(result) => {
                    let saved_name = result.get("name").and_then(|v| v.as_str()).unwrap_or(&spec_name);
                    text_content(format!("{saved_name} salvo."))
                }
                Err(e) => error_content(e),
            }
        }
        _ => error_content(format!("Ferramenta desconhecida: {name}")),
    }
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let (server_name, tools, dispatch): (&str, Value, fn(&Bridge, &str, &Value) -> Value) = match mode.as_str() {
        "specs" => ("specs", specs_tools(), call_specs_tool),
        _ => ("iris", iris_tools(), call_iris_tool),
    };

    let port = std::env::var("IRIS_BRIDGE_PORT").unwrap_or_default();
    let token = std::env::var("IRIS_BRIDGE_TOKEN").unwrap_or_default();
    if port.is_empty() || token.is_empty() {
        eprintln!("IRIS_BRIDGE_PORT / IRIS_BRIDGE_TOKEN não configurados no ambiente.");
        std::process::exit(1);
    }
    let bridge = Bridge { base_url: format!("http://127.0.0.1:{port}"), token };

    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = request.get("id").cloned();
        let method = request.get("method").and_then(|v| v.as_str()).unwrap_or("");

        // Notifications (no "id") never get a response, per JSON-RPC.
        let Some(id) = id else { continue };

        let response = match method {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": server_name, "version": "1.0.0" },
                },
            }),
            "tools/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools } }),
            "tools/call" => {
                let params = request.get("params").cloned().unwrap_or(Value::Null);
                let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let empty_args = json!({});
                let args = params.get("arguments").unwrap_or(&empty_args);
                let result = dispatch(&bridge, name, args);
                json!({ "jsonrpc": "2.0", "id": id, "result": result })
            }
            "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
            _ => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Método desconhecido: {method}") },
            }),
        };

        if writeln!(stdout, "{response}").is_err() {
            break;
        }
        let _ = stdout.flush();
    }
}
