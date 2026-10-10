use serde_json::{json, Map, Value};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const MAX_LOG_BYTES: u64 = 512 * 1024;
static LOG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy)]
enum Source {
    Frontend,
    Backend,
}

// 事件、级别和字段由后端确定；IPC 不能伪造后端事件或传入自由文本。
fn event_spec(source: Source, event: &str) -> Option<(&'static str, &'static [&'static str])> {
    match (source, event) {
        (Source::Frontend, "session.started" | "credentials.persisted") => {
            Some(("info", &["hasToken", "hasRefreshToken", "hasExpiresAt"]))
        }
        (Source::Frontend, "credentials.expired") => {
            Some(("info", &["hasRefreshToken", "expiresAtMs"]))
        }
        (Source::Frontend, "api.unauthorized") => Some(("warn", &["hasRejectedToken"])),
        (Source::Frontend, "oauth.callback_received") => Some((
            "info",
            &[
                "success",
                "hasAccessToken",
                "hasRefreshToken",
                "hasExpiresAt",
            ],
        )),
        (
            Source::Frontend,
            "oauth.started"
            | "profile.succeeded"
            | "session.clear_skipped"
            | "refresh.started"
            | "refresh.discarded",
        ) => Some(("info", &[])),
        (Source::Frontend, "oauth.failed" | "profile.unauthorized") => Some(("warn", &[])),
        (Source::Frontend, "session.cleared") => Some(("info", &["hasExpectedToken"])),
        (Source::Frontend, "refresh.succeeded") => {
            Some(("info", &["expiresIn", "hasRefreshToken"]))
        }
        (Source::Frontend, "refresh.failed") => Some(("warn", &["reason", "status"])),
        (
            Source::Backend,
            "callback.listener_ready"
            | "oauth.browser_opened"
            | "callback.accepted"
            | "token.exchange_succeeded",
        ) => Some(("info", &[])),
        (Source::Backend, "callback.listener_failed") => Some(("warn", &["addressFamily"])),
        (Source::Backend, "oauth.browser_failed") => Some(("warn", &[])),
        (Source::Backend, "callback.failed" | "token.exchange_failed") => {
            Some(("warn", &["reason", "status"]))
        }
        _ => None,
    }
}

fn safe_details(source: Source, event: &str, details: &Value) -> Option<Map<String, Value>> {
    let (_, fields) = event_spec(source, event)?;
    let metadata: &[&str] = match source {
        Source::Frontend => &[
            "sessionId",
            "sequence",
            "frontendVersionMajor",
            "frontendVersionMinor",
            "frontendVersionPatch",
            "buildMode",
        ],
        Source::Backend => &[],
    };
    let mut safe = Map::new();
    for &key in fields.iter().chain(metadata.iter()) {
        let Some(value) = details.get(key) else {
            continue;
        };
        let valid = match key {
            "hasToken" | "hasRefreshToken" | "hasExpiresAt" | "hasRejectedToken" | "success"
            | "hasAccessToken" | "hasExpectedToken" => value.is_boolean(),
            "expiresAtMs" => uint_in(value, 0, 8_640_000_000_000_000),
            "status" => uint_in(value, 100, 599),
            "expiresIn" => uint_in(value, 1, 10 * 366 * 24 * 60 * 60),
            "sessionId" => uint_in(value, 0, u32::MAX as u64),
            "sequence" => uint_in(value, 1, 9_007_199_254_740_991),
            "frontendVersionMajor" | "frontendVersionMinor" | "frontendVersionPatch" => {
                uint_in(value, 0, u32::MAX as u64)
            }
            "buildMode" => matches!(value.as_str(), Some("development" | "production")),
            "addressFamily" => matches!(value.as_str(), Some("ipv4" | "ipv6")),
            "reason" => match event {
                "refresh.failed" => matches!(
                    value.as_str(),
                    Some(
                        "missing-refresh-token"
                            | "network"
                            | "rate-limited"
                            | "server"
                            | "invalid-grant"
                            | "invalid-client"
                            | "invalid-response"
                    )
                ),
                "callback.failed" => matches!(
                    value.as_str(),
                    Some(
                        "missing-session"
                            | "timeout"
                            | "accept"
                            | "read"
                            | "missing-code"
                            | "state-mismatch"
                    )
                ),
                "token.exchange_failed" => matches!(
                    value.as_str(),
                    Some("network" | "http" | "invalid-response")
                ),
                _ => false,
            },
            _ => false,
        };
        if valid {
            safe.insert(key.to_owned(), value.clone());
        }
    }
    Some(safe)
}

fn uint_in(value: &Value, min: u64, max: u64) -> bool {
    value.as_u64().is_some_and(|n| (min..=max).contains(&n))
}

// 锁覆盖检查大小、轮转和完整写入；只保留当前文件及一份历史。
fn append_record(dir: &Path, record: &Value) -> io::Result<()> {
    let _guard = LOG_LOCK
        .lock()
        .map_err(|_| io::Error::other("diagnostic lock unavailable"))?;
    let mut line = serde_json::to_vec(record)?;
    line.push(b'\n');
    if line.len() as u64 > MAX_LOG_BYTES {
        return Err(io::Error::other("diagnostic record too large"));
    }
    fs::create_dir_all(dir)?;
    let current = dir.join("auth.jsonl");
    let previous = dir.join("auth.previous.jsonl");
    let size = match fs::metadata(&current) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error),
    };
    if size.saturating_add(line.len() as u64) > MAX_LOG_BYTES {
        // Windows rename 不覆盖已有文件。
        match fs::remove_file(&previous) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        fs::rename(&current, &previous)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(current)?;
    file.write_all(&line)?;
    file.sync_data()
}

fn make_record(source: Source, event: &str, details: &Value, app_version: &str) -> Option<Value> {
    let (level, _) = event_spec(source, event)?;
    Some(json!({
        "schemaVersion": 1,
        "processId": std::process::id(),
        "atMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        "domain": "auth",
        "source": match source { Source::Frontend => "frontend", Source::Backend => "backend" },
        "level": level,
        "event": event,
        "appVersion": app_version,
        "details": safe_details(source, event, details)?,
    }))
}

fn write_event(
    app: &tauri::AppHandle,
    source: Source,
    event: &str,
    details: &Value,
) -> Result<(), String> {
    let Some(record) = make_record(
        source,
        event,
        details,
        &app.package_info().version.to_string(),
    ) else {
        return Ok(());
    };
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|_| "auth diagnostic directory unavailable".to_owned())?;
    append_record(&dir, &record).map_err(|_| "auth diagnostic write failed".to_owned())
}

/// 后端同样经过白名单，记录失败不影响 OAuth 流程。
pub(crate) fn record_auth_event(app: &tauri::AppHandle, event: &str, details: Value) {
    let _ = write_event(app, Source::Backend, event, &details);
}

/// IPC 的磁盘写入移至阻塞线程池，避免阻塞窗口线程。
#[tauri::command]
pub async fn record_auth_diagnostic(
    app: tauri::AppHandle,
    event: String,
    details: Value,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_event(&app, Source::Frontend, &event, &details)
    })
    .await
    .map_err(|_| "auth diagnostic task failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);
    struct TestDir(std::path::PathBuf);

    impl TestDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "bangumini-auth-test-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn filters_credentials_unknown_fields_and_free_text() {
        let input = json!({
            "token": "SECRET", "Authorization": "Bearer SECRET", "refresh_token": "SECRET",
            "username": "SECRET", "url": "https://example.com?token=SECRET", "error": "SECRET",
            "reason": "invalid-grant", "status": 400, "sessionId": 123, "sequence": 1,
            "frontendVersionMajor": 1, "frontendVersionMinor": 2, "frontendVersionPatch": 3,
            "buildMode": "production", "hasToken": true
        });
        assert_eq!(
            Value::Object(safe_details(Source::Frontend, "refresh.failed", &input).unwrap()),
            json!({
                "reason": "invalid-grant", "status": 400, "sessionId": 123, "sequence": 1,
                "frontendVersionMajor": 1, "frontendVersionMinor": 2, "frontendVersionPatch": 3,
                "buildMode": "production"
            })
        );
        assert!(safe_details(Source::Frontend, "SECRET", &input).is_none());
        assert!(safe_details(
            Source::Frontend,
            "refresh.failed",
            &json!({
                "reason": "invalid_grant: SECRET", "status": "400 SECRET", "sessionId": "SECRET",
                "sequence": -1, "buildMode": "SECRET", "frontendVersionMajor": "SECRET"
            })
        )
        .unwrap()
        .is_empty());
        assert!(safe_details(
            Source::Frontend,
            "session.started",
            &json!({
                "hasToken": "SECRET", "hasRefreshToken": {"token": "SECRET"}, "hasExpiresAt": 1
            })
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn numeric_bounds_and_non_objects_are_safe() {
        for value in [json!(null), json!([]), json!("SECRET")] {
            assert!(safe_details(Source::Frontend, "session.started", &value)
                .unwrap()
                .is_empty());
        }
        for value in [json!(-1), json!(0.5), json!(600), json!(u64::MAX)] {
            assert!(safe_details(
                Source::Frontend,
                "refresh.failed",
                &json!({"status": value})
            )
            .unwrap()
            .is_empty());
        }
        assert!(safe_details(
            Source::Frontend,
            "refresh.succeeded",
            &json!({"expiresIn": -1})
        )
        .unwrap()
        .is_empty());
        for value in [json!(-1), json!("SECRET"), json!(u64::MAX)] {
            assert!(safe_details(
                Source::Frontend,
                "credentials.expired",
                &json!({"expiresAtMs": value})
            )
            .unwrap()
            .is_empty());
        }
        assert_eq!(
            Value::Object(
                safe_details(
                    Source::Frontend,
                    "credentials.expired",
                    &json!({
                        "hasRefreshToken": false, "expiresAtMs": 1_800_000_000_000_u64
                    })
                )
                .unwrap()
            ),
            json!({"hasRefreshToken": false, "expiresAtMs": 1_800_000_000_000_u64})
        );
    }

    #[test]
    fn sources_and_event_reasons_are_isolated() {
        assert!(make_record(
            Source::Frontend,
            "callback.listener_failed",
            &json!({}),
            "1.2.3"
        )
        .is_none());
        assert!(make_record(Source::Backend, "session.started", &json!({}), "1.2.3").is_none());
        let record = make_record(Source::Backend, "callback.listener_failed", &json!({
            "addressFamily": "ipv6", "sessionId": 123, "error": "SECRET", "domain": "SECRET", "processId": 0
        }), "1.2.3").unwrap();
        assert_eq!(record["schemaVersion"], 1);
        assert_eq!(record["processId"], std::process::id());
        assert_eq!(record["domain"], "auth");
        assert_eq!(record["source"], "backend");
        assert_eq!(record["level"], "warn");
        assert_eq!(record["appVersion"], "1.2.3");
        assert_eq!(record["details"], json!({"addressFamily": "ipv6"}));
        assert!(safe_details(
            Source::Backend,
            "callback.failed",
            &json!({"reason": "invalid-grant"})
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            Value::Object(
                safe_details(
                    Source::Backend,
                    "token.exchange_failed",
                    &json!({
                        "reason": "http", "status": 503, "body": "SECRET"
                    })
                )
                .unwrap()
            ),
            json!({"reason": "http", "status": 503})
        );
    }

    #[test]
    fn rotates_at_512_kib_and_replaces_previous() {
        let dir = TestDir::new();
        let current = dir.0.join("auth.jsonl");
        let previous = dir.0.join("auth.previous.jsonl");
        let record = json!({"event": "session.started"});
        let line = format!("{}\n", record);
        fs::write(&current, vec![b' '; MAX_LOG_BYTES as usize - line.len()]).unwrap();
        fs::write(&previous, b"old history").unwrap();
        append_record(&dir.0, &record).unwrap();
        assert_eq!(fs::metadata(&current).unwrap().len(), MAX_LOG_BYTES);
        assert_eq!(fs::read(&previous).unwrap(), b"old history");
        append_record(&dir.0, &record).unwrap();
        assert_eq!(fs::metadata(&previous).unwrap().len(), MAX_LOG_BYTES);
        assert_eq!(fs::read_to_string(&current).unwrap(), line);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
    }

    #[test]
    fn concurrent_records_remain_complete_json_lines() {
        let dir = TestDir::new();
        std::thread::scope(|scope| {
            for id in 0..8 {
                let path = &dir.0;
                scope.spawn(move || {
                    for sequence in 0..16 {
                        append_record(path, &json!({"id": id, "sequence": sequence})).unwrap();
                    }
                });
            }
        });
        let text = fs::read_to_string(dir.0.join("auth.jsonl")).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 128);
    }

    #[test]
    fn io_failure_returns_without_panicking() {
        let dir = TestDir::new();
        let file = dir.0.join("not-a-directory");
        fs::write(&file, b"").unwrap();
        assert!(append_record(&file, &json!({"event": "session.started"})).is_err());
    }
}
