//! Native file/folder dialogs, replacing `electron/ipc.ts`'s `dialog:saveTextFile` and
//! `specs:chooseDirectory` handlers (both used Electron's `dialog` module + `node:fs`).

use std::fs;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn dialog_save_text_file(
    app: AppHandle,
    suggested_name: String,
    content: String,
) -> Result<Option<String>, String> {
    let app_for_dialog = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog
            .dialog()
            .file()
            .set_file_name(&suggested_name)
            .add_filter("XML", &["xml"])
            .add_filter("Todos os arquivos", &["*"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(path) = path else { return Ok(None) };
    let path_buf = path.into_path().map_err(|e| e.to_string())?;
    fs::write(&path_buf, content).map_err(|e| e.to_string())?;
    Ok(Some(path_buf.to_string_lossy().into_owned()))
}

pub async fn choose_directory(app: AppHandle, current_dir: Option<String>) -> Result<Option<String>, String> {
    let path = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file();
        if let Some(dir) = &current_dir {
            builder = builder.set_directory(dir);
        }
        builder.blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    match path {
        Some(path) => Ok(Some(path.into_path().map_err(|e| e.to_string())?.to_string_lossy().into_owned())),
        None => Ok(None),
    }
}
