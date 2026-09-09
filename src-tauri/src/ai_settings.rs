//! Rust port of `electron/aiSettings.ts`. Provider/model selection is plain JSON; each provider's
//! API key lives in the OS credential store via `keyring` (one entry per provider id) — never
//! written to disk, and only ever handed to the `opencode` child process via its environment at
//! run time (see `agent_run.rs`).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "com.typer.app.ai-keys";

fn provider_env_var(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "google" => Some("GOOGLE_GENERATIVE_AI_API_KEY"),
        "openai" => Some("OPENAI_API_KEY"),
        "openrouter" => Some("OPENROUTER_API_KEY"),
        _ => None,
    }
}

fn known_provider_ids() -> &'static [&'static str] {
    &["anthropic", "google", "openai", "openrouter"]
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StoredSettings {
    #[serde(rename = "providerId", default)]
    provider_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiSettingsView {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    pub model: String,
    #[serde(rename = "savedKeyProviders")]
    pub saved_key_providers: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct AiSaveConfigArgs {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub keys: Option<HashMap<String, String>>,
}

/// Resolved config an agent run actually uses: provider id, model, and the env var to pass the API
/// key through (`None` when the provider doesn't need one stored here).
pub struct AiRunConfig {
    pub provider_id: String,
    pub model: String,
    pub api_key: Option<String>,
    pub env_var: Option<String>,
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("ai-settings.json"))
}

fn read_settings(app: &AppHandle) -> StoredSettings {
    let Ok(file) = settings_file(app) else { return StoredSettings::default() };
    fs::read_to_string(file)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn write_settings(app: &AppHandle, settings: &StoredSettings) -> Result<(), String> {
    let file = settings_file(app)?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(file, json).map_err(|e| e.to_string())
}

fn get_api_key(provider_id: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, provider_id).ok()?.get_password().ok()
}

fn set_api_key(provider_id: &str, key: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, provider_id)
        .map_err(|e| e.to_string())?
        .set_password(key)
        .map_err(|e| e.to_string())
}

fn clear_api_key(provider_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, provider_id).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn load_view(app: &AppHandle) -> AiSettingsView {
    let stored = read_settings(app);
    let provider_id = stored.provider_id.filter(|s| !s.is_empty()).unwrap_or_else(|| "default".to_string());
    let model = stored.model.unwrap_or_default();
    let saved_key_providers =
        known_provider_ids().iter().filter(|id| get_api_key(id).is_some()).map(|s| s.to_string()).collect();
    AiSettingsView { provider_id, model, saved_key_providers }
}

pub fn resolve_run_config(app: &AppHandle) -> AiRunConfig {
    let view = load_view(app);
    if view.provider_id == "default" {
        return AiRunConfig { provider_id: view.provider_id, model: view.model, api_key: None, env_var: None };
    }
    let env_var = provider_env_var(&view.provider_id).map(|s| s.to_string());
    let api_key = get_api_key(&view.provider_id);
    AiRunConfig { provider_id: view.provider_id, model: view.model, api_key, env_var }
}

#[tauri::command]
pub fn ai_get_config(app: AppHandle) -> AiSettingsView {
    load_view(&app)
}

#[tauri::command]
pub fn ai_save_config(app: AppHandle, args: AiSaveConfigArgs) -> Result<AiSettingsView, String> {
    write_settings(&app, &StoredSettings { provider_id: Some(args.provider_id), model: Some(args.model) })?;
    if let Some(keys) = args.keys {
        for (provider_id, key) in keys {
            if provider_id == "default" {
                continue;
            }
            if key.is_empty() {
                clear_api_key(&provider_id)?;
            } else {
                set_api_key(&provider_id, &key)?;
            }
        }
    }
    Ok(load_view(&app))
}
