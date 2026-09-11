//! Tauri command wrappers around `atelier.rs` — resolve a connection `id` (as the frontend knows
//! it) into an `AtelierConnectionConfig` (via `connections::resolve_config`) and delegate. Mirrors
//! the per-handler shape of `electron/ipc.ts`.

use crate::atelier::{
    self, AtelierDocNameEntry, AtelierDocument, AtelierQueryResult, AtelierSearchFileResult,
    AtelierServerInfo, DocumentReadOnlyStatus, RestCallResult, StudioMenu, StudioUserAction,
};
use crate::connections;
use serde_json::Value;
use std::collections::HashMap;
use tauri::AppHandle;

#[tauri::command]
pub async fn atelier_test(app: AppHandle, id: String) -> Result<AtelierServerInfo, String> {
    let config = connections::resolve_config(&app, &id)?;
    atelier::get_server_info(&config).await
}

#[tauri::command]
pub async fn atelier_list_namespaces(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    let config = connections::resolve_config(&app, &id)?;
    Ok(atelier::get_server_info(&config).await?.namespaces)
}

#[tauri::command]
pub async fn atelier_list_documents(
    app: AppHandle,
    id: String,
    namespace: String,
    include_system: Option<bool>,
) -> Result<Vec<AtelierDocNameEntry>, String> {
    let config = connections::resolve_config(&app, &id)?;
    let include_system = include_system.unwrap_or(false);
    let docs = atelier::list_documents(&config, &namespace, include_system).await?;
    // Only the default (non-system) listing goes into the cache — that's the one the explorer shows
    // and the one the agent bridge serves, so an includeSystem=true listing must not pollute it.
    if !include_system {
        atelier::cache_documents(&config, &namespace, docs.clone());
    }
    Ok(docs)
}

#[tauri::command]
pub async fn atelier_get_document(
    app: AppHandle,
    id: String,
    namespace: String,
    name: String,
) -> Result<AtelierDocument, String> {
    let config = connections::resolve_config(&app, &id)?;
    atelier::get_document(&config, &namespace, &name).await
}

#[tauri::command]
pub async fn atelier_get_document_read_only_status(
    app: AppHandle,
    id: String,
    namespace: String,
    name: String,
) -> Result<DocumentReadOnlyStatus, String> {
    let config = connections::resolve_config(&app, &id)?;
    atelier::get_document_read_only_status(&config, &namespace, &name).await
}

#[tauri::command]
pub async fn atelier_search_in_files(
    app: AppHandle,
    id: String,
    namespace: String,
    query: String,
    documents: String,
    include_system: Option<bool>,
) -> Result<Vec<AtelierSearchFileResult>, String> {
    let config = connections::resolve_config(&app, &id)?;
    atelier::search_in_files(&config, &namespace, &query, &documents, include_system.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn atelier_save_document(
    app: AppHandle,
    id: String,
    namespace: String,
    name: String,
    content_lines: Vec<String>,
) -> Result<(), String> {
    let config = connections::resolve_config(&app, &id)?;
    atelier::save_document(&config, &namespace, &name, content_lines).await
}

#[tauri::command]
pub async fn atelier_delete_document(
    app: AppHandle,
    id: String,
    namespace: String,
    name: String,
) -> Result<(), String> {
    let config = connections::resolve_config(&app, &id)?;
    atelier::delete_document(&config, &namespace, &name).await
}

#[tauri::command]
pub async fn atelier_compile(
    app: AppHandle,
    id: String,
    namespace: String,
    docs: Vec<String>,
) -> Result<Vec<String>, String> {
    let config = connections::resolve_config(&app, &id)?;
    atelier::compile_documents(&config, &namespace, docs).await
}

#[tauri::command]
pub async fn atelier_query(
    app: AppHandle,
    id: String,
    namespace: String,
    sql: String,
    parameters: Vec<Value>,
) -> Result<AtelierQueryResult, String> {
    let config = connections::resolve_config(&app, &id)?;
    atelier::run_query(&config, &namespace, &sql, parameters).await
}

#[tauri::command]
pub async fn atelier_call_route(
    app: AppHandle,
    id: String,
    path: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<RestCallResult, String> {
    let config = connections::resolve_config(&app, &id)?;
    atelier::call_rest_route(&config, &path, &method, headers, body).await
}

#[tauri::command]
pub async fn atelier_is_studio_extension_enabled(
    app: AppHandle,
    id: String,
    namespace: String,
) -> Result<bool, String> {
    let config = connections::resolve_config(&app, &id)?;
    Ok(atelier::is_studio_extension_enabled(&config, &namespace).await)
}

#[tauri::command]
pub async fn atelier_get_studio_menus(
    app: AppHandle,
    id: String,
    namespace: String,
    menu_type: String,
    doc_name: String,
    selected_text: Option<String>,
) -> Result<Vec<StudioMenu>, String> {
    let config = connections::resolve_config(&app, &id)?;
    atelier::get_studio_menus(
        &config,
        &namespace,
        &menu_type,
        &doc_name,
        &selected_text.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
pub async fn atelier_invoke_studio_user_action(
    app: AppHandle,
    id: String,
    namespace: String,
    r#type: i64,
    action_id: String,
    doc_name: String,
    selected_text: Option<String>,
) -> Result<Option<StudioUserAction>, String> {
    let config = connections::resolve_config(&app, &id)?;
    atelier::invoke_studio_user_action(
        &config,
        &namespace,
        r#type,
        &action_id,
        &doc_name,
        &selected_text.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
pub async fn atelier_invoke_studio_after_user_action(
    app: AppHandle,
    id: String,
    namespace: String,
    r#type: i64,
    action_id: String,
    doc_name: String,
    answer: String,
    msg: String,
) -> Result<Option<StudioUserAction>, String> {
    let config = connections::resolve_config(&app, &id)?;
    atelier::invoke_studio_after_user_action(
        &config,
        &namespace,
        r#type,
        &action_id,
        &doc_name,
        &answer,
        &msg,
    )
    .await
}
