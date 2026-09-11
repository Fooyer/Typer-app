mod agent_bridge;
mod agent_run;
mod ai_settings;
mod atelier;
mod atelier_commands;
mod connections;
mod dialogs;
mod specs;
mod studio_csp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            connections::connections_list,
            connections::connections_save,
            connections::connections_delete,
            atelier_commands::atelier_test,
            atelier_commands::atelier_list_namespaces,
            atelier_commands::atelier_list_documents,
            atelier_commands::atelier_get_document,
            atelier_commands::atelier_get_document_read_only_status,
            atelier_commands::atelier_search_in_files,
            atelier_commands::atelier_save_document,
            atelier_commands::atelier_delete_document,
            atelier_commands::atelier_compile,
            atelier_commands::atelier_query,
            atelier_commands::atelier_call_route,
            atelier_commands::atelier_is_studio_extension_enabled,
            atelier_commands::atelier_get_studio_menus,
            atelier_commands::atelier_invoke_studio_user_action,
            atelier_commands::atelier_invoke_studio_after_user_action,
            studio_csp::studio_open_csp_action,
            dialogs::dialog_save_text_file,
            agent_run::agent_run,
            agent_run::agent_abort,
            agent_run::agent_force_reset,
            agent_run::model_list,
            agent_bridge::agent_resolve_pending_write,
            ai_settings::ai_get_config,
            ai_settings::ai_save_config,
            specs::specs_resolve_dir,
            specs::specs_list,
            specs::specs_read,
            specs::specs_write,
            specs::specs_create,
            specs::specs_delete,
            specs::specs_seed_sdd_template,
            specs::specs_rename,
            specs::specs_choose_directory,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // Mirrors main.ts's "before-quit" handler: without this, quitting mid-run skips the
            // child opencode process's own cleanup path entirely.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                agent_run::abort_all_agent_runs();
            }
        });
}
