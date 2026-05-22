use tauri::Manager;

#[tauri::command]
fn get_shortcut() -> String {
    // Return current global shortcut from stored config
    std::env::var("BANGUMINI_SHORTCUT").unwrap_or_else(|_| "Ctrl+Shift+B".into())
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    // Placeholder: actual autostart implementation
    if enabled {
        println!("Autostart enabled");
    } else {
        println!("Autostart disabled");
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_shortcut, set_autostart])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            // Register default global shortcut
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let app_handle = app.handle().clone();
                app_handle
                    .plugin(
                        tauri_plugin_global_shortcut::Builder::new()
                            .with_handler(move |_shortcut, _event| {
                                if let Ok(true) = window.is_visible() {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            })
                            .build(),
                    )
                    .ok();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
