//! 个人偏置同步专用 HTTP / Windows Credential Manager 边界，不记录请求或凭证。
use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};
use reqwest::{header::{HeaderMap, HeaderName, HeaderValue}, Method, Url};
use tokio::sync::watch;

const MAX_BYTES: usize = 2 * 1024 * 1024;
const FAILURE: &str = "同步网络请求失败，请检查配置或网络";
const CANCELLED: &str = "同步请求已取消或超时";
const SECURE_FAILURE: &str = "Windows 安全凭证存储不可用，操作未完成";

struct RequestEntry {
    created: Instant,
    cancel: watch::Sender<bool>,
    started: bool,
}
#[derive(Default)]
pub(crate) struct OffsetSyncRequests(Mutex<HashMap<String, RequestEntry>>);

fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
}

impl OffsetSyncRequests {
    fn register(&self, id: String) -> Result<(), String> {
        if !valid_id(&id) { return Err(FAILURE.into()); }
        let mut entries = self.0.lock().map_err(|_| FAILURE)?;
        // HTTP 总超时为 30 秒；遗留预注册项最多存活 60 秒且总量有界。
        entries.retain(|_, entry| entry.created.elapsed() < Duration::from_secs(60));
        if entries.len() >= 128 || entries.contains_key(&id) { return Err(FAILURE.into()); }
        entries.insert(id, RequestEntry { created: Instant::now(), cancel: watch::channel(false).0, started: false });
        Ok(())
    }
    fn start(&self, id: &str) -> Result<watch::Receiver<bool>, String> {
        let mut entries = self.0.lock().map_err(|_| FAILURE)?;
        let entry = entries.get_mut(id).ok_or(CANCELLED)?;
        if entry.started || *entry.cancel.borrow() || entry.created.elapsed() >= Duration::from_secs(30) { return Err(CANCELLED.into()); }
        entry.started = true;
        Ok(entry.cancel.subscribe())
    }
    fn cancel(&self, id: &str) -> Result<(), String> {
        let mut entries = self.0.lock().map_err(|_| FAILURE)?;
        if let Some(entry) = entries.get(id) {
            if entry.started { entry.cancel.send_replace(true); }
            else { entries.remove(id); } // 尚未启动则直接撤销注册；随后到达的 fetch 会被拒绝。
        }
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn offset_sync_register_request(request_id: String, state: tauri::State<'_, OffsetSyncRequests>) -> Result<(), String> {
    state.register(request_id)
}
#[tauri::command]
pub(crate) fn offset_sync_cancel_request(request_id: String, state: tauri::State<'_, OffsetSyncRequests>) -> Result<(), String> {
    state.cancel(&request_id)
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct OffsetSyncResponse {
    status: u16,
    headers: Vec<(String, String)>,
    bytes: Vec<u8>,
}

fn validate_request(url: &str, method: &str, headers: Vec<(String, String)>, bytes: &[u8]) -> Result<(Url, Method, HeaderMap), String> {
    let url = Url::parse(url).map_err(|_| FAILURE)?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() { return Err(FAILURE.into()); }
    let method = match method { "GET" => Method::GET, "PUT" => Method::PUT, "MKCOL" => Method::from_bytes(b"MKCOL").map_err(|_| FAILURE)?, _ => return Err(FAILURE.into()) };
    if bytes.len() > MAX_BYTES || (method != Method::PUT && !bytes.is_empty()) { return Err(FAILURE.into()); }
    if method == Method::PUT {
        let text = std::str::from_utf8(bytes).map_err(|_| FAILURE)?;
        serde_json::from_str::<serde_json::Value>(text).map_err(|_| FAILURE)?;
    }
    let mut result = HeaderMap::new();
    if headers.len() > 128 { return Err(FAILURE.into()); }
    for (name, value) in headers {
        // 禁止请求走私、签名目标替换和响应解压；SDK 的授权 / CAS / checksum headers 保留。
        if ["host", "content-length", "transfer-encoding", "connection", "accept-encoding"].contains(&name.to_ascii_lowercase().as_str()) { continue; }
        result.append(HeaderName::from_bytes(name.as_bytes()).map_err(|_| FAILURE)?, HeaderValue::from_str(&value).map_err(|_| FAILURE)?);
    }
    Ok((url, method, result))
}

async fn execute(client: reqwest::Client, url: Url, method: Method, headers: HeaderMap, bytes: Vec<u8>) -> Result<OffsetSyncResponse, String> {
    let mut response = client.request(method, url).headers(headers).body(bytes).send().await.map_err(|_| FAILURE)?;
    if response.content_length().is_some_and(|len| len > MAX_BYTES as u64) { return Err("同步文件超过 2 MiB，已停止读写".into()); }
    let status = response.status().as_u16();
    let headers = response.headers().iter().map(|(name, value)| Ok((name.as_str().to_owned(), value.to_str().map_err(|_| FAILURE)?.to_owned()))).collect::<Result<Vec<_>, String>>()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| FAILURE)? {
        if chunk.len() > MAX_BYTES - bytes.len() { return Err("同步文件超过 2 MiB，已停止读写".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(OffsetSyncResponse { status, headers, bytes })
}

#[tauri::command]
pub(crate) async fn offset_sync_fetch(
    request_id: String, url: String, method: String, headers: Vec<(String, String)>, bytes: Vec<u8>,
    state: tauri::State<'_, OffsetSyncRequests>, proxy: tauri::State<'_, crate::ProxyHolder>,
) -> Result<OffsetSyncResponse, String> {
    let mut cancel = state.start(&request_id)?;
    let operation = async {
        let (url, method, headers) = validate_request(&url, &method, headers, &bytes)?;
        let client = crate::proxy_client_builder(&proxy).redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30)).build().map_err(|_| FAILURE)?;
        execute(client, url, method, headers, bytes).await
    };
    let result = cancellable(operation, &mut cancel, Duration::from_secs(30)).await;
    if let Ok(mut entries) = state.0.lock() { entries.remove(&request_id); }
    result
}

async fn cancellable<T>(operation: impl std::future::Future<Output = Result<T, String>>, cancel: &mut watch::Receiver<bool>, timeout: Duration) -> Result<T, String> {
    // biased + 初始检查涵盖注册后、开始前取消；丢弃 future 取消 reqwest 原生 I/O。
    if *cancel.borrow() { return Err(CANCELLED.into()); }
    tokio::select! { biased;
        _ = cancel.changed() => Err(CANCELLED.into()),
        result = tokio::time::timeout(timeout, operation) => result.unwrap_or_else(|_| Err(CANCELLED.into())),
    }
}

fn valid_key(key: &str) -> bool {
    let Some(tail) = key.strip_prefix("bangumini_offset_sync.") else { return false; };
    let parts: Vec<_> = tail.split('.').collect();
    if parts.is_empty() || parts[0].len() != 64 || !parts[0].bytes().all(|c| c.is_ascii_hexdigit()) { return false; }
    match parts.as_slice() {
        [_, "head"] => true,
        [_, generation, index] => valid_id(generation) && index.parse::<u8>().is_ok_and(|n| n < 64 && n.to_string() == *index),
        _ => false,
    }
}
#[cfg(windows)]
static CREDENTIAL_LOCK: Mutex<()> = Mutex::new(());
#[cfg(windows)]
fn credential(key: &str) -> Result<keyring_core::Entry, String> {
    static INITIALIZED: std::sync::OnceLock<Result<(), ()>> = std::sync::OnceLock::new();
    INITIALIZED.get_or_init(|| {
        let store = windows_native_keyring_store::Store::new().map_err(|_| ())?;
        keyring_core::set_default_store(store);
        Ok(())
    }).as_ref().map_err(|_| SECURE_FAILURE)?;
    if !valid_key(key) { return Err(SECURE_FAILURE.into()); }
    keyring_core::Entry::new_with_modifiers("Bangumini.PersonalOffsetSync.v1", key, &HashMap::from([("persistence", "Local")])).map_err(|_| SECURE_FAILURE.into())
}
#[tauri::command]
pub(crate) async fn offset_sync_credential_get(key: String) -> Result<Option<String>, String> {
    if !valid_key(&key) { return Err(SECURE_FAILURE.into()); }
    #[cfg(windows)]
    { return tokio::task::spawn_blocking(move || {
        let _guard = CREDENTIAL_LOCK.lock().map_err(|_| SECURE_FAILURE)?;
        match credential(&key)?.get_secret() {
            Ok(value) => String::from_utf8(value).map(Some).map_err(|_| SECURE_FAILURE.into()),
            Err(keyring_core::Error::NoEntry) => Ok(None), Err(_) => Err(SECURE_FAILURE.into()),
        }
    }).await.map_err(|_| SECURE_FAILURE)?; }
    #[cfg(not(windows))]
    Err(SECURE_FAILURE.into())
}
#[tauri::command]
pub(crate) async fn offset_sync_credential_set(key: String, value: String) -> Result<(), String> {
    // Windows Generic Credential 上限为 2560 bytes；直接保存 UTF-8 secret，留足余量。
    if !valid_key(&key) || value.len() > 2000 { return Err(SECURE_FAILURE.into()); }
    #[cfg(windows)]
    { return tokio::task::spawn_blocking(move || {
        let _guard = CREDENTIAL_LOCK.lock().map_err(|_| SECURE_FAILURE)?;
        credential(&key)?.set_secret(value.as_bytes()).map_err(|_| SECURE_FAILURE.into())
    }).await.map_err(|_| SECURE_FAILURE)?; }
    #[cfg(not(windows))]
    Err(SECURE_FAILURE.into())
}
#[tauri::command]
pub(crate) async fn offset_sync_credential_delete(key: String) -> Result<(), String> {
    if !valid_key(&key) { return Err(SECURE_FAILURE.into()); }
    #[cfg(windows)]
    { return tokio::task::spawn_blocking(move || {
        let _guard = CREDENTIAL_LOCK.lock().map_err(|_| SECURE_FAILURE)?;
        match credential(&key)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()), Err(_) => Err(SECURE_FAILURE.into()),
        }
    }).await.map_err(|_| SECURE_FAILURE)?; }
    #[cfg(not(windows))]
    Err(SECURE_FAILURE.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_and_registration_are_bounded() {
        let state = OffsetSyncRequests::default();
        let id = "00000000-0000-4000-8000-000000000001";
        state.register(id.into()).unwrap(); state.cancel(id).unwrap();
        assert!(state.start(id).is_err());
        for i in 1..129 { state.register(format!("00000000-0000-4000-8000-{i:012}")).unwrap(); }
        assert!(state.register("00000000-0000-4000-8000-000000000129".into()).is_err());
    }
    #[test]
    fn input_security() {
        for url in ["http://example.com", "https://user:pass@example.com", "https://example.com/#fragment"] {
            assert!(validate_request(url, "GET", vec![], &[]).is_err());
        }
        assert!(validate_request("https://example.com", "DELETE", vec![], &[]).is_err());
        assert!(validate_request("https://example.com", "PUT", vec![], b"not-json").is_err());
        assert!(validate_request("https://example.com", "PUT", vec![], b"{}").is_ok());
        assert!(!valid_key("other.secret"));
        assert!(!valid_key("bangumini_offset_sync.arbitrary-secret"));
        assert!(valid_key(&format!("bangumini_offset_sync.{}.head", "a".repeat(64))));
    }

    async fn server(parts: Vec<Vec<u8>>, delay: Duration) -> (Url, tokio::task::JoinHandle<()>) {
        use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096]; let _ = socket.read(&mut request).await;
            for part in parts {
                if socket.write_all(&part).await.is_err() { return; }
                if !delay.is_zero() { tokio::time::sleep(delay).await; }
            }
        });
        (url, task)
    }
    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap()
    }
    #[tokio::test]
    async fn native_response_and_redirect_are_not_rewritten() {
        let (url, task) = server(vec![b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n{\"n\":1}".to_vec()], Duration::ZERO).await;
        let response = execute(client(), url, Method::GET, HeaderMap::new(), vec![]).await.unwrap();
        assert_eq!(response.bytes, b"{\"n\":1}");
        assert!(response.headers.contains(&("etag".into(), "\"v1\"".into()))); task.await.unwrap();
        let (url, task) = server(vec![b"HTTP/1.1 302 Found\r\nLocation: https://must-not-follow.invalid/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()], Duration::ZERO).await;
        assert_eq!(execute(client(), url, Method::GET, HeaderMap::new(), vec![]).await.unwrap().status, 302); task.await.unwrap();
    }
    #[tokio::test]
    async fn native_stream_limit_without_content_length() {
        let mut response = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        response.extend(vec![b'x'; MAX_BYTES + 1]);
        let (url, task) = server(vec![response], Duration::ZERO).await;
        assert!(execute(client(), url, Method::GET, HeaderMap::new(), vec![]).await.unwrap_err().contains("2 MiB")); task.await.unwrap();
    }
    #[tokio::test]
    async fn cancellation_and_timeout_cover_body_and_drop_io() {
        use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};
        for cancel_explicitly in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
            let (tx, mut rx) = watch::channel(false);
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 4096]; let _ = socket.read(&mut bytes).await;
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nx").await.unwrap();
                if cancel_explicitly { tx.send_replace(true); }
                // 停在响应体中间；原生取消 / 完整超时必须关闭连接，不只是 JS 放弃等待。
                let closed = tokio::time::timeout(Duration::from_secs(2), socket.read(&mut bytes)).await.unwrap().unwrap();
                assert_eq!(closed, 0);
            });
            let result = cancellable(execute(client(), url, Method::GET, HeaderMap::new(), vec![]), &mut rx, Duration::from_millis(100)).await;
            assert_eq!(result.unwrap_err(), CANCELLED); server.await.unwrap();
        }
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_native_credential_round_trip() {
        let key = format!("bangumini_offset_sync.{}.00000000-0000-4000-8000-{:012x}.0", "0".repeat(64), std::process::id());
        offset_sync_credential_set(key.clone(), "临时😀secret".into()).await.unwrap();
        assert_eq!(offset_sync_credential_get(key.clone()).await.unwrap(), Some("临时😀secret".into()));
        assert!(offset_sync_credential_set(key.clone(), "x".repeat(2001)).await.is_err());
        assert_eq!(offset_sync_credential_get(key.clone()).await.unwrap(), Some("临时😀secret".into()));
        offset_sync_credential_delete(key.clone()).await.unwrap();
        assert_eq!(offset_sync_credential_get(key).await.unwrap(), None);
    }
}
