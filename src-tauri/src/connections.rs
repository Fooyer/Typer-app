//! Rust port of `electron/connections.ts`. Connection profiles (no secrets) live in a JSON file
//! under the app's data dir; the IRIS password lives in the OS credential store via the `keyring`
//! crate — the Tauri/Windows equivalent of Electron's `safeStorage` (which also backs onto DPAPI /
//! the Credential Manager under the hood).

use crate::atelier::AtelierConnectionConfig;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub https: bool,
    #[serde(rename = "pathPrefix", skip_serializing_if = "Option::is_none")]
    pub path_prefix: Option<String>,
    pub username: String,
    pub namespace: String,
}

#[derive(Debug, Deserialize)]
pub struct SaveConnectionArgs {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub https: bool,
    #[serde(rename = "pathPrefix")]
    pub path_prefix: Option<String>,
    pub username: String,
    pub namespace: String,
}

const KEYRING_SERVICE: &str = "com.typer.app.connections";

fn connections_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("connections.json"))
}

fn read_connections(app: &AppHandle) -> Vec<ConnectionProfile> {
    let Ok(file) = connections_file(app) else { return Vec::new() };
    fs::read_to_string(file)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn write_connections(app: &AppHandle, connections: &[ConnectionProfile]) -> Result<(), String> {
    let file = connections_file(app)?;
    let json = serde_json::to_string_pretty(connections).map_err(|e| e.to_string())?;
    fs::write(file, json).map_err(|e| e.to_string())
}

fn keyring_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| e.to_string())
}

pub fn get_password(id: &str) -> Option<String> {
    keyring_entry(id).ok()?.get_password().ok()
}

fn save_password(id: &str, password: &str) -> Result<(), String> {
    keyring_entry(id)?.set_password(password).map_err(|e| e.to_string())
}

fn delete_password(id: &str) -> Result<(), String> {
    match keyring_entry(id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Resolves a saved connection profile plus its decrypted password into the config `atelier::*`
/// needs — the equivalent of `ipc.ts`'s `toAtelierConfig`. Shared by the atelier/agent commands.
pub fn resolve_config(app: &AppHandle, id: &str) -> Result<AtelierConnectionConfig, String> {
    let profile = find_profile(app, id)?;
    let password = get_password(id).ok_or_else(|| {
        format!(
            "Sem senha salva para \"{}\". Edite a conexão e informe a senha novamente.",
            profile.name
        )
    })?;
    Ok(AtelierConnectionConfig {
        host: profile.host,
        port: profile.port,
        https: profile.https,
        path_prefix: profile.path_prefix,
        username: profile.username,
        password,
    })
}

pub fn find_profile(app: &AppHandle, id: &str) -> Result<ConnectionProfile, String> {
    read_connections(app)
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "Conexão não encontrada.".to_string())
}

#[tauri::command]
pub fn connections_list(app: AppHandle) -> Vec<ConnectionProfile> {
    read_connections(&app)
}

#[tauri::command]
pub fn connections_save(
    app: AppHandle,
    profile: SaveConnectionArgs,
    password: Option<String>,
) -> Result<ConnectionProfile, String> {
    let mut connections = read_connections(&app);
    let id = profile.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let saved = ConnectionProfile {
        id: id.clone(),
        name: profile.name,
        host: profile.host,
        port: profile.port,
        https: profile.https,
        path_prefix: profile.path_prefix,
        username: profile.username,
        namespace: profile.namespace,
    };
    match connections.iter().position(|c| c.id == id) {
        Some(index) => connections[index] = saved.clone(),
        None => connections.push(saved.clone()),
    }
    write_connections(&app, &connections)?;

    if let Some(password) = password {
        // Mirrors connections.ts: if OS-level encryption/storage isn't available, the password is
        // intentionally not persisted rather than risking plaintext — surfaced as an error here so
        // the UI knows the save didn't fully succeed, since keyring has no silent "unavailable" mode.
        save_password(&id, &password)?;
    }
    Ok(saved)
}

#[tauri::command]
pub fn connections_delete(app: AppHandle, id: String) -> Result<(), String> {
    let profile = find_profile(&app, &id).ok();
    if let Some(profile) = &profile {
        if let Some(password) = get_password(&id) {
            let config = AtelierConnectionConfig {
                host: profile.host.clone(),
                port: profile.port,
                https: profile.https,
                path_prefix: profile.path_prefix.clone(),
                username: profile.username.clone(),
                password,
            };
            crate::atelier::clear_session(&config);
        }
    }
    let remaining: Vec<_> = read_connections(&app).into_iter().filter(|c| c.id != id).collect();
    write_connections(&app, &remaining)?;
    delete_password(&id)?;
    Ok(())
}
