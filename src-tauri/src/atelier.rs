//! Rust port of `electron/atelier.ts` — a minimal client for InterSystems' Atelier REST API (the
//! same API vscode-objectscript uses) to browse/edit/compile classes and routines on a remote
//! IRIS/Caché server over HTTP(S) + Basic auth. Behavior is kept as close as practical to the
//! original TypeScript: per-connection session cookie reuse, a concurrency cap per connection to
//! avoid exhausting license-constrained IRIS session pools, and the same set of endpoints.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

#[derive(Debug, Clone, Deserialize)]
pub struct AtelierConnectionConfig {
    pub host: String,
    pub port: u16,
    pub https: bool,
    #[serde(rename = "pathPrefix")]
    pub path_prefix: Option<String>,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AtelierServerInfo {
    pub version: String,
    pub id: String,
    pub api: u32,
    pub namespaces: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AtelierDocNameEntry {
    pub name: String,
    pub cat: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AtelierDocument {
    pub name: String,
    pub ts: String,
    pub cat: String,
    pub enc: bool,
    pub content: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DocumentReadOnlyStatus {
    #[serde(rename = "readOnly")]
    pub read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestCallResult {
    pub status: u16,
    #[serde(rename = "statusText")]
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
pub struct AtelierQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<HashMap<String, Value>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AtelierSearchMatch {
    pub line: i64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AtelierSearchFileResult {
    pub doc: String,
    pub matches: Vec<AtelierSearchMatch>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StudioMenuItem {
    pub id: String,
    pub name: String,
    pub enabled: i64,
    #[serde(default)]
    pub save: Option<i64>,
    #[serde(default)]
    pub separator: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StudioMenu {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub items: Vec<StudioMenuItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StudioUserAction {
    pub action: i64,
    pub target: String,
    pub message: String,
    pub reload: bool,
    #[serde(default)]
    pub doc: Value,
    #[serde(rename = "errorText")]
    pub error_text: String,
}

fn err(message: impl Into<String>) -> String {
    message.into()
}

/// IRIS's Atelier API is loosely typed at the JSON level — the same logical field (e.g. a
/// document's `Type`) can come back as either a JSON string or a bare number depending on the
/// document kind. JS/TS silently coerces this at the call site; Rust's strict deserialization
/// needs this escape hatch instead.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum StringOrNumber {
    String(String),
    Number(serde_json::Number),
}

impl StringOrNumber {
    fn into_string(self) -> String {
        match self {
            StringOrNumber::String(s) => s,
            StringOrNumber::Number(n) => n.to_string(),
        }
    }
}

/// Session cookies per connection, so repeated calls reuse one CSP/IRIS session instead of each
/// Basic-Auth request spinning up a new one — see the original TS file's doc comment for why.
static COOKIE_JAR: LazyLock<Mutex<HashMap<String, Vec<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Caps how many requests can be in flight at once per connection, mirroring the original's
/// per-key request queue — the actual fix for repeated 503s on license-constrained servers.
const MAX_CONCURRENT_REQUESTS_PER_CONNECTION: usize = 2;

static REQUEST_SEMAPHORES: LazyLock<Mutex<HashMap<String, Arc<Semaphore>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

fn cookie_key(config: &AtelierConnectionConfig) -> String {
    format!(
        "{}@{}:{}{}",
        config.username,
        config.host,
        config.port,
        config.path_prefix.clone().unwrap_or_default()
    )
}

fn semaphore_for(key: &str) -> Arc<Semaphore> {
    let mut map = REQUEST_SEMAPHORES.lock().unwrap();
    map.entry(key.to_string())
        .or_insert_with(|| Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS_PER_CONNECTION)))
        .clone()
}

pub fn clear_session(config: &AtelierConnectionConfig) {
    COOKIE_JAR.lock().unwrap().remove(&cookie_key(config));
}

fn build_url(config: &AtelierConnectionConfig, path: &str, params: &[(&str, String)]) -> String {
    let scheme = if config.https { "https" } else { "http" };
    let prefix = match &config.path_prefix {
        Some(p) if !p.is_empty() => {
            if p.starts_with('/') {
                p.clone()
            } else {
                format!("/{p}")
            }
        }
        _ => String::new(),
    };
    let query = params
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| format!("{k}={}", urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let query_string = if query.is_empty() { String::new() } else { format!("?{query}") };
    format!(
        "{scheme}://{}:{}{prefix}/api/atelier/{path}{query_string}",
        config.host, config.port
    )
}

fn bool_param(value: bool) -> String {
    if value { "1".to_string() } else { "0".to_string() }
}

static HTTP_CLIENT: LazyLock<reqwest::Client> =
    LazyLock::new(|| reqwest::Client::builder().build().expect("failed to build reqwest client"));

#[derive(Debug, Deserialize)]
struct AtelierStatus {
    #[serde(default)]
    summary: String,
}

#[derive(Debug, Deserialize)]
struct AtelierResponse<T> {
    #[serde(default)]
    status: Option<AtelierStatus>,
    #[serde(default)]
    console: Vec<String>,
    result: T,
}

struct RequestOptions<'a> {
    params: &'a [(&'a str, String)],
    body: Option<Value>,
    timeout: Duration,
}

impl<'a> Default for RequestOptions<'a> {
    fn default() -> Self {
        RequestOptions { params: &[], body: None, timeout: REQUEST_TIMEOUT }
    }
}

async fn request<T: DeserializeOwned>(
    config: &AtelierConnectionConfig,
    method: reqwest::Method,
    path: &str,
    options: RequestOptions<'_>,
) -> Result<AtelierResponse<T>, String> {
    let key = cookie_key(config);
    let semaphore = semaphore_for(&key);
    let _permit = semaphore.acquire().await.map_err(|e| e.to_string())?;
    perform_request(config, method, path, options, &key).await
}

async fn perform_request<T: DeserializeOwned>(
    config: &AtelierConnectionConfig,
    method: reqwest::Method,
    path: &str,
    options: RequestOptions<'_>,
    key: &str,
) -> Result<AtelierResponse<T>, String> {
    let url = build_url(config, path, options.params);
    let auth = format!(
        "Basic {}",
        base64_encode(&format!("{}:{}", config.username, config.password))
    );
    let cookies = COOKIE_JAR.lock().unwrap().get(key).cloned().unwrap_or_default();

    let mut request = HTTP_CLIENT
        .request(method, &url)
        .timeout(options.timeout)
        .header("Accept", "application/json")
        .header("Authorization", auth);
    if !cookies.is_empty() {
        request = request.header("Cookie", cookies.join("; "));
    }
    if let Some(body) = &options.body {
        request = request.header("Content-Type", "application/json").json(body);
    }

    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            if error.is_timeout() {
                return Err(err(format!(
                    "Tempo limite excedido ({}s) ao falar com {}:{}.",
                    options.timeout.as_secs(),
                    config.host,
                    config.port
                )));
            }
            return Err(err(format!(
                "Não foi possível conectar a {}:{} — falha de rede ({error}).",
                config.host, config.port
            )));
        }
    };

    let set_cookies: Vec<String> = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(|s| s.to_string())
        .collect();
    if !set_cookies.is_empty() {
        update_cookies(key, &set_cookies);
    }

    let status = response.status();
    if status.as_u16() == 401 {
        COOKIE_JAR.lock().unwrap().remove(key);
        return Err(err("Autenticação falhou: usuário ou senha incorretos."));
    }
    if status.as_u16() == 404 {
        return Err(err("Servidor não encontrado (404): verifique host, porta e prefixo de caminho."));
    }
    if !status.is_success() && status.as_u16() != 400 && status.as_u16() != 500 {
        return Err(err(format!(
            "Erro HTTP {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        )));
    }

    let text = response.text().await.map_err(|e| err(e.to_string()))?;
    let data: AtelierResponse<T> = serde_json::from_str(&text).map_err(|parse_error| {
        let snippet: String = text.chars().take(300).collect();
        err(format!(
            "Resposta do servidor não é um JSON válido — confirme se é um servidor IRIS/Caché com a \
             API Atelier habilitada. Detalhe: {parse_error}. Início da resposta: {snippet:?}"
        ))
    })?;
    if let Some(status) = &data.status {
        if !status.summary.is_empty() {
            return Err(err(status.summary.clone()));
        }
    }
    Ok(data)
}

fn update_cookies(key: &str, set_cookie_headers: &[String]) {
    if set_cookie_headers.is_empty() {
        return;
    }
    let mut jar = COOKIE_JAR.lock().unwrap();
    let mut merged = jar.get(key).cloned().unwrap_or_default();
    for raw in set_cookie_headers {
        let pair = raw.split(';').next().unwrap_or("").to_string();
        let name = pair.split('=').next().unwrap_or("").to_string();
        if let Some(index) = merged.iter().position(|c| c.starts_with(&format!("{name}="))) {
            merged[index] = pair;
        } else {
            merged.push(pair);
        }
    }
    jar.insert(key.to_string(), merged);
}

fn base64_encode(input: &str) -> String {
    use std::fmt::Write;
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = input.as_bytes();
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        let _ = write!(out, "{}", TABLE[((n >> 18) & 0x3f) as usize] as char);
        let _ = write!(out, "{}", TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 0x3f) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 0x3f) as usize] as char } else { '=' });
    }
    out
}

#[derive(Debug, Deserialize)]
struct ContentWrapper<T> {
    content: Option<T>,
}

pub async fn get_server_info(config: &AtelierConnectionConfig) -> Result<AtelierServerInfo, String> {
    #[derive(Deserialize)]
    struct Info {
        version: String,
        id: String,
        api: u32,
        namespaces: Vec<String>,
    }
    let response = request::<ContentWrapper<Info>>(
        config,
        reqwest::Method::GET,
        "",
        RequestOptions::default(),
    )
    .await?;
    let info = response.result.content.ok_or_else(|| err("Resposta vazia do servidor."))?;
    Ok(AtelierServerInfo {
        version: info.version,
        id: info.id,
        api: info.api,
        namespaces: info.namespaces,
    })
}

/// Mirrors the original's use of `%Library.RoutineMgr_StudioOpenDialog` (via action/query) instead
/// of the plain `docnames` REST endpoint — see atelier.ts's doc comment for why.
pub async fn list_documents(
    config: &AtelierConnectionConfig,
    namespace: &str,
    include_system: bool,
) -> Result<Vec<AtelierDocNameEntry>, String> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(rename = "Name")]
        name: String,
        // IRIS returns this as a JSON string for most document kinds but as a bare number for a
        // few (e.g. a LUT's `Type` came back as `100`, not `"100"`) — accept either.
        #[serde(rename = "Type")]
        cat: StringOrNumber,
    }
    let system_files = if include_system || namespace == "%SYS" { "1" } else { "0" };
    let body = serde_json::json!({
        "query": "SELECT Name, Type FROM %Library.RoutineMgr_StudioOpenDialog(?,?,?,?,?,?,?)",
        "parameters": ["*.*", "1", "1", system_files, "1", "0", "0"],
    });
    let response = request::<ContentWrapper<Vec<Row>>>(
        config,
        reqwest::Method::POST,
        &format!("v1/{namespace}/action/query"),
        RequestOptions { body: Some(body), ..Default::default() },
    )
    .await?;
    Ok(response
        .result
        .content
        .unwrap_or_default()
        .into_iter()
        .map(|row| AtelierDocNameEntry { name: row.name, cat: row.cat.into_string() })
        .collect())
}

pub async fn get_document(
    config: &AtelierConnectionConfig,
    namespace: &str,
    name: &str,
) -> Result<AtelierDocument, String> {
    let response = request::<AtelierDocument>(
        config,
        reqwest::Method::GET,
        &format!("v1/{namespace}/doc/{}", urlencoding::encode(name)),
        RequestOptions::default(),
    )
    .await?;
    Ok(response.result)
}

/// Same two server-side checks as the original (deployed classes, server-side source control) —
/// both fail silently ("not read-only for this reason") when they don't apply.
pub async fn get_document_read_only_status(
    config: &AtelierConnectionConfig,
    namespace: &str,
    doc_name: &str,
) -> Result<DocumentReadOnlyStatus, String> {
    if doc_name.to_lowercase().ends_with(".cls") {
        let class_name = &doc_name[..doc_name.len() - 4];
        if let Ok(result) = run_query(
            config,
            namespace,
            "SELECT Deployed FROM %Dictionary.ClassDefinition WHERE Name = ?",
            vec![Value::String(class_name.to_string())],
        )
        .await
        {
            let deployed = result
                .rows
                .first()
                .and_then(|row| row.get("Deployed"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            if deployed > 0 {
                return Ok(DocumentReadOnlyStatus {
                    read_only: true,
                    reason: Some(
                        "Classe implantada (deployed) — código-fonte não disponível para edição."
                            .to_string(),
                    ),
                });
            }
        }
    }

    if let Ok(result) = run_query(
        config,
        namespace,
        "select * from %Atelier_v1_Utils.Extension_GetStatus(?)",
        vec![Value::String(doc_name.to_string())],
    )
    .await
    {
        if let Some(status) = result.rows.last() {
            let editable = status.iter().find(|(key, _)| key.to_lowercase() == "editable");
            if let Some((_, value)) = editable {
                if value.as_bool() == Some(false) {
                    return Ok(DocumentReadOnlyStatus {
                        read_only: true,
                        reason: Some(
                            "Controle de código-fonte do servidor marca este documento como não editável (sem check-out)."
                                .to_string(),
                        ),
                    });
                }
            }
        }
    }

    Ok(DocumentReadOnlyStatus { read_only: false, reason: None })
}

/// `ignoreConflict` because this is a single-user dev tool with no cached last-seen server
/// timestamp for the Atelier API's optimistic-concurrency check to compare against.
pub async fn save_document(
    config: &AtelierConnectionConfig,
    namespace: &str,
    name: &str,
    content_lines: Vec<String>,
) -> Result<(), String> {
    let body = serde_json::json!({ "enc": false, "content": content_lines, "mtime": 0 });
    request::<Value>(
        config,
        reqwest::Method::PUT,
        &format!("v1/{namespace}/doc/{}", urlencoding::encode(name)),
        RequestOptions {
            params: &[("ignoreConflict", bool_param(true))],
            body: Some(body),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

pub async fn delete_document(
    config: &AtelierConnectionConfig,
    namespace: &str,
    name: &str,
) -> Result<(), String> {
    request::<Value>(
        config,
        reqwest::Method::DELETE,
        &format!("v1/{namespace}/doc/{}", urlencoding::encode(name)),
        RequestOptions::default(),
    )
    .await?;
    Ok(())
}

/// Calls an arbitrary path on the connection's own host/port (not `/api/atelier/`) — used by the
/// API tester to hit a class's real `%CSP.REST` endpoints. Runs here (not the webview) so the
/// request carries Basic Auth cleanly and isn't subject to the webview's CORS restrictions.
pub async fn call_rest_route(
    config: &AtelierConnectionConfig,
    path: &str,
    method: &str,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<RestCallResult, String> {
    let scheme = if config.https { "https" } else { "http" };
    let url = format!("{scheme}://{}:{}{path}", config.host, config.port);
    let auth = format!("Basic {}", base64_encode(&format!("{}:{}", config.username, config.password)));
    let upper_method = method.to_uppercase();
    let has_body = !matches!(upper_method.as_str(), "GET" | "HEAD")
        && body.as_deref().map(|b| !b.is_empty()).unwrap_or(false);

    let method = reqwest::Method::from_bytes(upper_method.as_bytes()).map_err(|e| err(e.to_string()))?;
    let mut request = HTTP_CLIENT.request(method, &url).header("Authorization", auth);
    for (key, value) in &headers {
        request = request.header(key, value);
    }
    if has_body {
        request = request.body(body.clone().unwrap_or_default());
    }

    let started = Instant::now();
    let response = request.send().await.map_err(|error| {
        err(format!("Não foi possível chamar {url} — falha de rede ({error})."))
    })?;
    let duration_ms = started.elapsed().as_millis();

    let status = response.status();
    let mut response_headers = HashMap::new();
    for (key, value) in response.headers().iter() {
        if let Ok(value) = value.to_str() {
            response_headers.insert(key.to_string(), value.to_string());
        }
    }
    let body = response.text().await.map_err(|e| err(e.to_string()))?;

    Ok(RestCallResult {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers: response_headers,
        body,
        duration_ms,
    })
}

/// Compiling (especially a first-time %Persistent class) is genuinely slower than a plain
/// read/write, hence the longer timeout than other calls.
pub async fn compile_documents(
    config: &AtelierConnectionConfig,
    namespace: &str,
    docs: Vec<String>,
) -> Result<Vec<String>, String> {
    let response = request::<Value>(
        config,
        reqwest::Method::POST,
        &format!("v1/{namespace}/action/compile"),
        RequestOptions {
            params: &[("flags", "cuk".to_string()), ("source", bool_param(false))],
            body: Some(serde_json::json!(docs)),
            timeout: Duration::from_secs(120),
        },
    )
    .await?;
    Ok(response.console)
}

pub async fn run_query(
    config: &AtelierConnectionConfig,
    namespace: &str,
    sql: &str,
    parameters: Vec<Value>,
) -> Result<AtelierQueryResult, String> {
    let body = serde_json::json!({ "query": sql, "parameters": parameters });
    let response = request::<ContentWrapper<Vec<HashMap<String, Value>>>>(
        config,
        reqwest::Method::POST,
        &format!("v1/{namespace}/action/query"),
        RequestOptions { body: Some(body), ..Default::default() },
    )
    .await?;
    let rows = response.result.content.unwrap_or_default();
    let columns = rows.first().map(|row| row.keys().cloned().collect()).unwrap_or_default();
    Ok(AtelierQueryResult { columns, rows })
}

/// Server-side full-text search (Atelier API v2, IRIS 2023.1+). Older servers 404 on this route —
/// callers are expected to fall back to a client-side download-and-grep when this errors.
pub async fn search_in_files(
    config: &AtelierConnectionConfig,
    namespace: &str,
    query: &str,
    documents: &str,
    include_system: bool,
) -> Result<Vec<AtelierSearchFileResult>, String> {
    let sys = include_system || namespace == "%SYS";
    let response = request::<Value>(
        config,
        reqwest::Method::GET,
        &format!("v2/{namespace}/action/search"),
        RequestOptions {
            params: &[
                ("query", query.to_string()),
                ("documents", documents.to_string()),
                ("regex", bool_param(false)),
                ("sys", bool_param(sys)),
                ("max", "5000".to_string()),
            ],
            ..Default::default()
        },
    )
    .await?;
    let list = match &response.result {
        Value::Array(items) => items.clone(),
        Value::Object(map) => match map.get("content") {
            Some(Value::Array(items)) => items.clone(),
            _ => {
                return Err(err("Formato de resposta inesperado do endpoint de busca (v2/action/search)."))
            }
        },
        _ => return Err(err("Formato de resposta inesperado do endpoint de busca (v2/action/search).")),
    };
    let results: Result<Vec<AtelierSearchFileResult>, _> =
        list.into_iter().map(serde_json::from_value).collect();
    results.map_err(|_| err("Formato de resultado inesperado do endpoint de busca (v2/action/search)."))
}

pub async fn is_studio_extension_enabled(
    config: &AtelierConnectionConfig,
    namespace: &str,
) -> bool {
    match run_query(
        config,
        namespace,
        "SELECT %Atelier_v1_Utils.Extension_ExtensionEnabled() AS Enabled",
        vec![],
    )
    .await
    {
        Ok(result) => {
            result.rows.first().and_then(|row| row.get("Enabled")).map(value_truthy).unwrap_or(false)
        }
        Err(_) => false,
    }
}

/// Mirrors JS's `Boolean(x)` truthiness coercion — used because Atelier query results come back as
/// loosely-typed JSON (a numeric 0/1, a real boolean, or occasionally a string), and the original
/// TS just does `Boolean(result.rows[0]?.Enabled)`.
fn value_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(_) => true,
    }
}

pub async fn get_studio_menus(
    config: &AtelierConnectionConfig,
    namespace: &str,
    menu_type: &str,
    doc_name: &str,
    selected_text: &str,
) -> Result<Vec<StudioMenu>, String> {
    let result = run_query(
        config,
        namespace,
        "select * from %Atelier_v1_Utils.Extension_GetMenus(?,?,?)",
        vec![
            Value::String(menu_type.to_string()),
            Value::String(doc_name.to_string()),
            Value::String(selected_text.to_string()),
        ],
    )
    .await?;
    rows_to_structs(result.rows)
}

pub async fn invoke_studio_user_action(
    config: &AtelierConnectionConfig,
    namespace: &str,
    action_type: i64,
    action_id: &str,
    doc_name: &str,
    selected_text: &str,
) -> Result<Option<StudioUserAction>, String> {
    let result = run_query(
        config,
        namespace,
        "select * from %Atelier_v1_Utils.Extension_UserAction(?, ?, ?, ?)",
        vec![
            Value::String(action_type.to_string()),
            Value::String(action_id.to_string()),
            Value::String(doc_name.to_string()),
            Value::String(selected_text.to_string()),
        ],
    )
    .await?;
    last_row_as_struct(result.rows)
}

pub async fn invoke_studio_after_user_action(
    config: &AtelierConnectionConfig,
    namespace: &str,
    action_type: i64,
    action_id: &str,
    doc_name: &str,
    answer: &str,
    msg: &str,
) -> Result<Option<StudioUserAction>, String> {
    let result = run_query(
        config,
        namespace,
        "select * from %Atelier_v1_Utils.Extension_AfterUserAction(?, ?, ?, ?, ?)",
        vec![
            Value::String(action_type.to_string()),
            Value::String(action_id.to_string()),
            Value::String(doc_name.to_string()),
            Value::String(answer.to_string()),
            Value::String(msg.to_string()),
        ],
    )
    .await?;
    last_row_as_struct(result.rows)
}

fn rows_to_structs<T: DeserializeOwned>(rows: Vec<HashMap<String, Value>>) -> Result<Vec<T>, String> {
    rows.into_iter()
        .map(|row| serde_json::from_value(Value::Object(row.into_iter().collect())))
        .collect::<Result<Vec<T>, _>>()
        .map_err(|e| err(e.to_string()))
}

fn last_row_as_struct<T: DeserializeOwned>(rows: Vec<HashMap<String, Value>>) -> Result<Option<T>, String> {
    match rows.into_iter().last() {
        Some(row) => serde_json::from_value(Value::Object(row.into_iter().collect()))
            .map(Some)
            .map_err(|e| err(e.to_string())),
        None => Ok(None),
    }
}
