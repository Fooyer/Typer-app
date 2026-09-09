//! Rust port of `electron/studioCspWindow.ts`. Opens a Studio custom-menu "run a CSP page" action
//! (e.g. a login flow) as its own top-level webview window (same-origin as the server, so its
//! session cookie sticks). Once the flow completes, the server navigates the window a second time
//! to a bare Atelier "template" stub — detecting that second navigation (the first one is just the
//! initial page load) is the real completion signal.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

#[tauri::command]
pub async fn studio_open_csp_action(app: AppHandle, url: String) -> Result<String, String> {
    let parsed_url = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    let (sender, receiver) = oneshot::channel::<()>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let label = format!("studio-csp-{}", uuid::Uuid::new_v4());
    let label_for_main = label.clone();

    let app_for_main = app.clone();
    let sender_for_nav = sender.clone();
    let sender_for_close = sender.clone();

    app.run_on_main_thread(move || {
        let navigation_count = Arc::new(AtomicU32::new(0));
        let settled = Arc::new(AtomicBool::new(false));
        let settled_nav = settled.clone();

        let window = WebviewWindowBuilder::new(&app_for_main, &label_for_main, WebviewUrl::External(parsed_url))
            .title("Ação do servidor")
            .inner_size(900.0, 700.0)
            .on_navigation(move |_url| {
                let count = navigation_count.fetch_add(1, Ordering::SeqCst) + 1;
                if count > 1 && !settled_nav.swap(true, Ordering::SeqCst) {
                    if let Some(sender) = sender_for_nav.lock().unwrap().take() {
                        let _ = sender.send(());
                    }
                }
                true
            })
            .build();

        match window {
            Ok(window) => {
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { .. } = event {
                        if !settled.swap(true, Ordering::SeqCst) {
                            if let Some(sender) = sender_for_close.lock().unwrap().take() {
                                let _ = sender.send(());
                            }
                        }
                    }
                });
            }
            Err(_) => {
                if let Some(sender) = sender_for_close.lock().unwrap().take() {
                    let _ = sender.send(());
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;

    let _ = receiver.await;
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.close();
    }
    // The original TS type allows "1" | "2", but every completion path (done button, close, or the
    // second navigation) resolves the same "1" in practice — there's no real "2" case.
    Ok("1".to_string())
}
