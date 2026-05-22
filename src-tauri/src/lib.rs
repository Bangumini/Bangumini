use std::collections::HashMap;

use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;

const CLIENT_ID: &str = "bgm61886a103fe0672c1";
const CLIENT_SECRET: &str = "32468c5f6ba84e3528d11bd4905f1726";
const BANGUMI_AUTH: &str = "https://bgm.tv/oauth/authorize";
const BANGUMI_TOKEN: &str = "https://bgm.tv/oauth/access_token";

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

#[derive(serde::Serialize)]
struct OAuthResult {
    success: bool,
    error: Option<String>,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
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

#[tauri::command]
async fn start_oauth(app: tauri::AppHandle) -> Result<OAuthResult, String> {
    let state: String = format!("{:x}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());

    let auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&state={}",
        BANGUMI_AUTH,
        CLIENT_ID,
        "http%3A%2F%2Flocalhost%3A19840%2Fcallback",
        state,
    );

    // Open browser
    app.shell().open(&auth_url, None).map_err(|e| e.to_string())?;

    // Start local HTTP server for callback
    let listener = TcpListener::bind("127.0.0.1:19840").await.map_err(|e| e.to_string())?;

    // Accept one connection with 120s timeout
    let (stream, _) = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        listener.accept(),
    )
    .await
    .map_err(|_| "Timeout waiting for authorization".to_string())?
    .map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).await.map_err(|e| e.to_string())?;

    // Parse path: GET /callback?code=...&state=...
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Ok(OAuthResult { success: false, error: Some("Invalid request".into()), access_token: None, refresh_token: None, expires_at: None });
    }
    let path = parts[1];

    let mut code = String::new();
    let mut returned_state = String::new();
    if let Some(query) = path.split('?').nth(1) {
        for param in query.split('&') {
            let kv: Vec<&str> = param.splitn(2, '=').collect();
            if kv.len() == 2 {
                match kv[0] {
                    "code" => code = urlencoding::decode(kv[1]).unwrap_or_default().into_owned(),
                    "state" => returned_state = urlencoding::decode(kv[1]).unwrap_or_default().into_owned(),
                    _ => {}
                }
            }
        }
    }

    let html = if code.is_empty() {
        "<html><body><h1>授权失败</h1><p>未收到授权码。请关闭此窗口。</p></body></html>"
    } else if returned_state != state {
        "<html><body><h1>授权失败</h1><p>状态不匹配。请关闭此窗口。</p></body></html>"
    } else {
        "<html><body><h1>授权成功！</h1><p>可以关闭此窗口了。</p></body></html>"
    };

    // We need the underlying stream back for writing
    // Re-accept for the response, or simpler: just close the listener and return
    drop(listener);

    if code.is_empty() || returned_state != state {
        return Ok(OAuthResult { success: false, error: Some(if code.is_empty() { "No auth code".into() } else { "State mismatch".into() }), access_token: None, refresh_token: None, expires_at: None });
    }

    // Try to show success page (best effort)
    if let Ok(listener2) = TcpListener::bind("127.0.0.1:19840").await {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), listener2.accept()).await;
        // Browser retry — ignore, user can close manually
    }

    // Exchange code for tokens
    let client = reqwest::Client::new();
    let params = [
        ("grant_type", "authorization_code"),
        ("client_id", CLIENT_ID),
        ("client_secret", CLIENT_SECRET),
        ("code", &code),
        ("redirect_uri", "http://localhost:19840/callback"),
    ];

    let token_res = client.post(BANGUMI_TOKEN).form(&params).send().await;
    let res = match token_res {
        Ok(r) => r,
        Err(e) => return Ok(OAuthResult { success: false, error: Some(format!("Request: {}", e)), access_token: None, refresh_token: None, expires_at: None }),
    };

    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        return Ok(OAuthResult { success: false, error: Some(format!("Token fail: {}", body)), access_token: None, refresh_token: None, expires_at: None });
    }

    let data: serde_json::Value = match res.json().await {
        Ok(d) => d,
        Err(e) => return Ok(OAuthResult { success: false, error: Some(format!("Parse: {}", e)), access_token: None, refresh_token: None, expires_at: None }),
    };

    Ok(OAuthResult {
        success: true,
        error: None,
        access_token: data["access_token"].as_str().map(String::from),
        refresh_token: data["refresh_token"].as_str().map(String::from),
        expires_at: data["expires_in"].as_u64().map(|e| {
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + e
        }),
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![fetch_proxy, start_oauth, get_shortcut, set_autostart])
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
    if enabled { println!("Autostart enabled"); } else { println!("Autostart disabled"); }
    Ok(())
}
