use std::collections::HashMap;

use tauri::Manager;

#[derive(serde::Deserialize)]
struct FetchRequest {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
}

#[derive(serde::Serialize)]
struct FetchResponse {
    status: u16,
    body: String,
}

#[tauri::command]
async fn fetch_proxy(req: FetchRequest) -> Result<FetchResponse, String> {
    let client = reqwest::Client::new();
    let mut builder = match req.method.as_str() {
        "GET" => client.get(&req.url),
        "POST" => client.post(&req.url),
        "PATCH" => client.patch(&req.url),
        "DELETE" => client.delete(&req.url),
        _ => client.get(&req.url),
    };
    for (k, v) in &req.headers {
        builder = builder.header(k.as_str(), v.as_str());
    }
    if let Some(body) = &req.body {
        builder = builder.body(body.clone());
    }
    let res = builder.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(FetchResponse { status, body })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![fetch_proxy, get_shortcut, set_autostart])
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

#[tauri::command]
fn get_shortcut() -> String {
    std::env::var("BANGUMINI_SHORTCUT").unwrap_or_else(|_| "Ctrl+Shift+B".into())
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    if enabled {
        println!("Autostart enabled");
    } else {
        println!("Autostart disabled");
    }
    Ok(())
}
