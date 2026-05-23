use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;
use tauri_plugin_global_shortcut::{
    GlobalShortcutExt, Shortcut, ShortcutState as GsShortcutState,
};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

#[cfg(windows)]
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, SetWindowLongPtrW, GWLP_WNDPROC, WM_SYSCOMMAND, SC_KEYMENU,
};

#[cfg(windows)]
static OLD_WNDPROC: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(windows)]
unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // Block Alt+Space system menu
    if msg == WM_SYSCOMMAND && wparam.0 == SC_KEYMENU as usize {
        return LRESULT(0);
    }

    // Call the original window procedure for all other messages
    let old_proc = OLD_WNDPROC.load(std::sync::atomic::Ordering::SeqCst);
    CallWindowProcW(
        std::mem::transmute(old_proc),
        hwnd,
        msg,
        wparam,
        lparam,
    )
}

const CLIENT_ID: &str = "bgm61886a103fe0672c1";
const CLIENT_SECRET: &str = "32468c5f6ba84e3528d11bd4905f1726";
const BANGUMI_AUTH: &str = "https://bgm.tv/oauth/authorize";
const BANGUMI_TOKEN: &str = "https://bgm.tv/oauth/access_token";
const DEFAULT_SHORTCUT: &str = "CmdOrCtrl+Shift+B";

struct ShortcutHolder {
    current: StdMutex<Option<(Shortcut, String)>>,
}

static IS_DRAGGING: AtomicBool = AtomicBool::new(false);

fn show_window(w: &tauri::WebviewWindow, guard: &Arc<AtomicBool>) {
    guard.store(true, Ordering::SeqCst);
    let _ = w.show();
    let _ = w.set_focus();
    let g = guard.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        g.store(false, Ordering::SeqCst);
    });
}

fn install_shortcut(app: &tauri::AppHandle, accelerator: &str) -> Result<(), String> {
    let new_shortcut = Shortcut::from_str(accelerator)
        .map_err(|e| format!("无效的快捷键: {}", e))?;

    let holder = app.state::<ShortcutHolder>();
    let guard_state = app.state::<Arc<AtomicBool>>();
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;

    let mut current = holder.current.lock().map_err(|e| e.to_string())?;
    if let Some((old, _)) = current.take() {
        let _ = app.global_shortcut().unregister(old);
    }

    let w = window.clone();
    let g = (*guard_state).clone();
    app.global_shortcut()
        .on_shortcut(new_shortcut.clone(), move |_app, _s, event| {
            if event.state() != GsShortcutState::Pressed {
                return;
            }
            if let Ok(true) = w.is_visible() {
                let _ = w.hide();
            } else {
                show_window(&w, &g);
            }
        })
        .map_err(|e| e.to_string())?;

    *current = Some((new_shortcut, accelerator.to_string()));
    Ok(())
}

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

#[derive(serde::Serialize)]
struct AuthUrlResult {
    state: String,
}

struct OAuthState {
    listener: Option<TcpListener>,
}

#[tauri::command]
async fn start_oauth(app: tauri::AppHandle) -> Result<AuthUrlResult, String> {
    let state: String = format!("{:x}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());

    println!("[OAuth] Starting OAuth flow");

    // Start server FIRST to avoid race condition
    let listener = TcpListener::bind("127.0.0.1:19840").await.map_err(|e| {
        println!("[OAuth] Failed to bind listener: {}", e);
        e.to_string()
    })?;
    println!("[OAuth] Server listening on port 19840");

    // Store listener in app state
    let oauth_state = app.state::<Arc<Mutex<OAuthState>>>();
    oauth_state.lock().await.listener = Some(listener);

    let auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&state={}",
        BANGUMI_AUTH, CLIENT_ID, "http%3A%2F%2Flocalhost%3A19840%2Fcallback", state,
    );

    println!("[OAuth] Opening browser using opener plugin");
    // Use opener plugin instead of shell
    let result = app.opener().open_url(&auth_url, None::<&str>);
    if let Err(e) = &result {
        println!("[OAuth] Failed to open browser: {}", e);
    } else {
        println!("[OAuth] Browser opened");
    }
    result.map_err(|e| e.to_string())?;

    Ok(AuthUrlResult { state })
}

#[tauri::command]
async fn wait_oauth_callback(app: tauri::AppHandle, expected_state: String) -> Result<OAuthResult, String> {
    // Retrieve the listener from app state
    let oauth_state = app.state::<Arc<Mutex<OAuthState>>>();
    let listener = oauth_state.lock().await.listener.take()
        .ok_or_else(|| "No OAuth session started".to_string())?;

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

    drop(listener);

    if code.is_empty() || returned_state != expected_state {
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
        .plugin(prevent_default_plugin())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .invoke_handler(tauri::generate_handler![
            fetch_proxy,
            start_oauth,
            wait_oauth_callback,
            get_shortcut,
            register_shortcut,
            set_autostart,
            set_dragging
        ])
        .setup(|app| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
            use tauri::menu::{MenuBuilder, MenuItemBuilder};

            // Initialize OAuth state
            app.manage(Arc::new(Mutex::new(OAuthState { listener: None })));

            // Show guard: prevents Focused(false) from immediately hiding a just-shown window
            let show_guard: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
            app.manage(show_guard.clone());

            // Holder for the currently registered global shortcut
            app.manage(ShortcutHolder {
                current: StdMutex::new(None),
            });

            let window = app.get_webview_window("main").unwrap();

            // --- Disable Alt+Space system menu on Windows ---
            #[cfg(windows)]
            {
                if let Ok(handle) = window.window_handle() {
                    if let RawWindowHandle::Win32(win32_handle) = handle.as_ref() {
                        unsafe {
                            let hwnd = HWND(win32_handle.hwnd.get() as *mut std::ffi::c_void);

                            // Subclass the window to intercept WM_SYSCOMMAND messages
                            let old_proc = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, window_proc as *const () as usize as isize);

                            // Store the old window proc in a static for later use
                            OLD_WNDPROC.store(old_proc as usize, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                }
            }

            // --- Tray menu ---
            let show_hide = MenuItemBuilder::with_id("toggle", "Show/Hide").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show_hide)
                .item(&quit)
                .build()?;

            // --- Tray Icon ---
            let w_tray = window.clone();
            let g_menu = show_guard.clone();
            let g_click = show_guard.clone();
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Bangumini")
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "toggle" => {
                            if w_tray.is_visible().unwrap_or(false) {
                                let _ = w_tray.hide();
                            } else {
                                show_window(&w_tray, &g_menu);
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let w = tray.app_handle().get_webview_window("main").unwrap();
                        if w.is_visible().unwrap_or(false) {
                            let _ = w.hide();
                        } else {
                            show_window(&w, &g_click);
                        }
                    }
                })
                .build(app)?;

            // --- Global Shortcut: register default; the frontend will re-register on startup if user has a custom one ---
            let _ = install_shortcut(app.handle(), DEFAULT_SHORTCUT);

            // --- Window events: auto-hide on focus loss, prevent close ---
            let w_events = window.clone();
            let g_events = show_guard.clone();

            window.on_window_event(move |event| {
                match event {
                    tauri::WindowEvent::Focused(false) => {
                        // Don't hide if guard is set or currently dragging
                        if !g_events.load(Ordering::SeqCst) && !IS_DRAGGING.load(Ordering::SeqCst) {
                            let _ = w_events.hide();
                        }
                    }
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = w_events.hide();
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(debug_assertions)]
fn prevent_default_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_prevent_default::Flags;

    // In debug mode, keep DEV_TOOLS (Ctrl+Shift+I) and RELOAD enabled
    // Don't use browser_accelerator_keys(false) in debug mode to keep F12
    tauri_plugin_prevent_default::Builder::new()
        .with_flags(Flags::CONTEXT_MENU | Flags::PRINT | Flags::DOWNLOADS)
        .build()
}

#[cfg(not(debug_assertions))]
fn prevent_default_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_prevent_default::{Flags, PlatformOptions};

    // In release mode, disable everything including DEV_TOOLS
    tauri_plugin_prevent_default::Builder::new()
        .with_flags(Flags::CONTEXT_MENU | Flags::PRINT | Flags::DOWNLOADS | Flags::DEV_TOOLS)
        .platform(PlatformOptions::new()
            .browser_accelerator_keys(false))
        .build()
}

#[tauri::command]
fn get_shortcut(app: tauri::AppHandle) -> String {
    let holder = app.state::<ShortcutHolder>();
    holder
        .current
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|(_, s)| s.clone()))
        .unwrap_or_else(|| DEFAULT_SHORTCUT.to_string())
}

#[tauri::command]
fn register_shortcut(app: tauri::AppHandle, accelerator: String) -> Result<(), String> {
    let trimmed = accelerator.trim();
    if trimmed.is_empty() {
        return Err("快捷键不能为空".into());
    }
    install_shortcut(&app, trimmed)
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    if enabled { println!("Autostart enabled"); } else { println!("Autostart disabled"); }
    Ok(())
}

#[tauri::command]
fn set_dragging(dragging: bool) -> Result<(), String> {
    IS_DRAGGING.store(dragging, Ordering::SeqCst);
    Ok(())
}

