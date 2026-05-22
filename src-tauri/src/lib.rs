
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
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_shortcut, set_autostart])
        .setup(|app| {
            use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
            let window = app.get_webview_window("main").unwrap();
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyB);
            app.global_shortcut().on_shortcut(shortcut, move |_app, _s, _e| {
                if let Ok(true) = window.is_visible() {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            })?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
