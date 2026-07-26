use std::collections::HashMap;
use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

mod file_io;
mod notes;

pub(crate) static NOTES_DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();

use notes::commands::{
    notes_ack_image_atom_operation, notes_apply_batch, notes_apply_image_atom_edit,
    notes_apply_image_atom_paste, notes_archive_node, notes_clear_history,
    notes_close_history_session, notes_collapse_all, notes_create_node, notes_create_node_before,
    notes_delete_database, notes_delete_nodes, notes_download_attachment, notes_duplicate_node,
    notes_empty_trash, notes_expand_all, notes_export_markdown, notes_export_pdf,
    notes_history_status, notes_import_attachment, notes_import_attachment_bytes,
    notes_import_attachment_paths_batch, notes_import_image_node_bytes,
    notes_import_image_node_paths_batch, notes_import_markdown, notes_import_subtree,
    notes_initialize, notes_list_tags, notes_list_tags_with_counts, notes_load_workspace,
    notes_lookup_image_atom_operation, notes_mark_materialized_github_notification_read,
    notes_materialize_github_notification_and_create_sibling,
    notes_materialize_github_notification_and_reparent, notes_move_node,
    notes_open_attachment_original, notes_prepare_navigation, notes_prune_history_entries,
    notes_read_attachment_bytes, notes_redo, notes_refresh_materialized_github_notifications,
    notes_remove_attachment, notes_remove_empty_node, notes_repair_data, notes_reset_database,
    notes_resize_attachment, notes_restore_attachment, notes_restore_node, notes_search,
    notes_search_structured, notes_set_github_group_collapsed, notes_set_readonly,
    notes_soft_delete_node, notes_sort_subtree_ascending, notes_sort_subtree_descending,
    notes_split_node, notes_toggle_collapsed, notes_toggle_complete, notes_toggle_star,
    notes_unarchive_node, notes_undo, notes_update_node,
};
use notes::sync::asset_gc::{notes_purge_unused_assets, AssetPurgePreviewState};
use notes::sync::runtime::{
    notes_sync_flush, notes_sync_retry_quarantined, notes_sync_start, notes_sync_status,
    notes_sync_stop, stop_sync, SyncState,
};

fn expand_vault_path(vault_path: &str) -> PathBuf {
    if vault_path == "~" {
        if let Some(home) = env::var_os("HOME") {
            return PathBuf::from(home);
        }
    }
    if let Some(rest) = vault_path.strip_prefix("~/") {
        if let Some(home) = env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(vault_path)
}

pub(crate) fn metadata_dir(vault_path: &str) -> PathBuf {
    expand_vault_path(vault_path).join(".yonalist")
}

#[tauri::command]
fn record_perf_event(name: String, elapsed_ms: f64, detail: Option<String>) -> Result<(), String> {
    if env::var("YONALIST_PERF").ok().as_deref() == Some("1") {
        eprintln!(
            "YONALIST_PERF {}",
            serde_json::json!({
                "name": name,
                "elapsed_ms": elapsed_ms,
                "detail": detail.unwrap_or_else(|| "{}".to_string())
            })
        );
    }
    Ok(())
}

/// Loopback listener waiting for the OAuth authorization-code redirect,
/// mirroring the Flutter client's ephemeral localhost HttpServer.
#[derive(Default)]
pub struct OAuthServerState(Mutex<Option<TcpListener>>);

const AUTH_COMPLETE_PAGE_HTML: &str = r#"<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>로그인 완료</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f6f8fa;
      color: #1f2328;
    }
    .card {
      background: #fff;
      padding: 32px 40px;
      border-radius: 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.08);
      text-align: center;
      max-width: 360px;
    }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p  { font-size: 14px; margin: 4px 0; color: #57606a; }
  </style>
</head>
<body>
  <div class="card">
    <h1>로그인이 완료되었습니다</h1>
    <p>앱 창이 다시 활성화될 거예요.</p>
    <p>이 탭은 닫으셔도 됩니다.</p>
  </div>
  <script>
    setTimeout(function(){ try { window.close(); } catch (e) {} }, 200);
  </script>
</body>
</html>"#;

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    None => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let value = parts.next().unwrap_or("");
            Some((percent_decode(key), percent_decode(value)))
        })
        .collect()
}

/// How long the loopback server waits for the browser redirect before giving
/// up (the user may have closed the authorization page).
const OAUTH_CALLBACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
/// Upper bound for the redirect's request line, far above any real OAuth
/// callback, so a misbehaving client cannot grow memory unboundedly.
const MAX_REQUEST_LINE_BYTES: u64 = 8 * 1024;

fn accept_oauth_callback(
    listener: TcpListener,
    timeout: std::time::Duration,
) -> Result<HashMap<String, String>, String> {
    // TcpListener has no accept timeout; poll in non-blocking mode instead.
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let deadline = std::time::Instant::now() + timeout;
    let (mut stream, _) = loop {
        match listener.accept() {
            Ok(pair) => break pair,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return Err("Timed out waiting for the OAuth redirect.".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    stream
        .set_nonblocking(false)
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;

    let clone = stream.try_clone().map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(clone).take(MAX_REQUEST_LINE_BYTES);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|error| error.to_string())?;
    if !request_line.ends_with('\n') && request_line.len() as u64 >= MAX_REQUEST_LINE_BYTES {
        return Err("OAuth callback request line is too long.".to_string());
    }

    let path = request_line.split_whitespace().nth(1).unwrap_or("");
    let query = path.splitn(2, '?').nth(1).unwrap_or("");
    let params = parse_query(query);

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        AUTH_COMPLETE_PAGE_HTML.len(),
        AUTH_COMPLETE_PAGE_HTML
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|error| error.to_string())?;
    let _ = stream.flush();

    Ok(params)
}

/// Binds the loopback redirect server on an ephemeral port and returns it.
#[tauri::command]
fn oauth_start(state: tauri::State<OAuthServerState>) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    *state.0.lock().unwrap() = Some(listener);
    Ok(port)
}

/// Waits for the OAuth redirect, replies with the completion page, brings the
/// app window back to the front, and returns the callback query parameters.
#[tauri::command]
async fn oauth_wait(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, OAuthServerState>,
) -> Result<HashMap<String, String>, String> {
    let listener = state
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "OAuth server is not running.".to_string())?;

    let params = tauri::async_runtime::spawn_blocking(move || {
        accept_oauth_callback(listener, OAUTH_CALLBACK_TIMEOUT)
    })
    .await
    .map_err(|error| error.to_string())??;

    // macOS/Windows can refuse to foreground a background app; the
    // always-on-top toggle forces the window above the browser.
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.set_always_on_top(true);
    std::thread::sleep(std::time::Duration::from_millis(80));
    let _ = window.set_always_on_top(false);
    if let Some(oauth_window) = app.get_webview_window("oauth-login") {
        let _ = oauth_window.close();
    }

    Ok(params)
}

/// Exchanges the authorization code for an access token. Runs natively so the
/// webview's CORS policy cannot block the token endpoint. Async so the
/// blocking HTTP round-trip never stalls the IPC thread.
#[tauri::command]
async fn oauth_exchange(
    token_url: String,
    client_id: String,
    client_secret: String,
    code: String,
    redirect_uri: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        oauth_exchange_inner(token_url, client_id, client_secret, code, redirect_uri)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn oauth_exchange_inner(
    token_url: String,
    client_id: String,
    client_secret: String,
    code: String,
    redirect_uri: String,
) -> Result<String, String> {
    if !token_url.starts_with("https://") && !token_url.starts_with("http://") {
        return Err("Token URL must be an http(s) URL.".to_string());
    }
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(30)))
        .build()
        .new_agent();
    let mut response = agent
        .post(&token_url)
        .header("Accept", "application/json")
        .send_form([
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .map_err(|error| error.to_string())?;
    response
        .body_mut()
        .read_to_string()
        .map_err(|error| error.to_string())
}

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS: usize = 8;

#[derive(Clone, Debug)]
struct StoredCookie {
    name: String,
    value: String,
    domain: Option<String>,
    path: Option<String>,
    secure: Option<bool>,
}

fn stored_cookies(cookies: Vec<tauri::webview::Cookie<'static>>) -> Vec<StoredCookie> {
    cookies
        .into_iter()
        .filter(|cookie| !cookie.name().is_empty())
        .map(|cookie| StoredCookie {
            name: cookie.name().to_string(),
            value: cookie.value().to_string(),
            domain: cookie.domain().map(str::to_string),
            path: cookie.path().map(str::to_string),
            secure: cookie.secure(),
        })
        .collect()
}

fn response_to_image_data_url(
    response: ureq::http::Response<ureq::Body>,
) -> Result<Option<String>, String> {
    let content_type = response
        .headers()
        .get("Content-Type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if !content_type.starts_with("image/") {
        return Ok(None);
    }

    let mut bytes: Vec<u8> = Vec::new();
    std::io::Read::take(response.into_body().into_reader(), MAX_IMAGE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;

    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some(format!("data:{content_type};base64,{encoded}")))
}

fn cookie_matches_url(cookie: &StoredCookie, url: &tauri::Url) -> bool {
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    if cookie.secure == Some(true) && url.scheme() != "https" {
        return false;
    }
    if let Some(domain) = cookie.domain.as_deref() {
        let domain = domain.trim_start_matches('.').to_ascii_lowercase();
        if host != domain && !host.ends_with(&format!(".{domain}")) {
            return false;
        }
    }
    if let Some(path) = cookie.path.as_deref() {
        if !url.path().starts_with(path) {
            return false;
        }
    }
    true
}

fn cookie_header(cookies: &[StoredCookie], url: &tauri::Url) -> Option<String> {
    let header = cookies
        .iter()
        .filter(|cookie| cookie_matches_url(cookie, url))
        .map(|cookie| format!("{}={}", cookie.name, cookie.value))
        .collect::<Vec<_>>()
        .join("; ");
    if header.is_empty() {
        None
    } else {
        Some(header)
    }
}

fn redirect_target(
    current: &tauri::Url,
    response: &ureq::http::Response<ureq::Body>,
) -> Option<tauri::Url> {
    if !response.status().is_redirection() {
        return None;
    }
    response
        .headers()
        .get("Location")
        .and_then(|location| location.to_str().ok())
        .and_then(|location| current.join(location).ok())
}

fn fetch_image_attempt(
    cookies: &[StoredCookie],
    url: &str,
    auth_header: Option<&str>,
) -> Result<Option<String>, String> {
    let agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(std::time::Duration::from_secs(15)))
        .build()
        .new_agent();
    let mut current_url = tauri::Url::parse(url).map_err(|error| error.to_string())?;

    for _ in 0..=MAX_IMAGE_REDIRECTS {
        let cookie_header = cookie_header(cookies, &current_url);
        let mut request = agent.get(current_url.as_str()).header("Accept", "*/*");
        if let Some(auth_header) = auth_header {
            request = request.header("Authorization", auth_header);
        }
        if let Some(cookie_header) = cookie_header.as_deref() {
            request = request.header("Cookie", cookie_header);
        }

        let response = request.call().map_err(|error| error.to_string())?;

        if let Some(next_url) = redirect_target(&current_url, &response) {
            current_url = next_url;
            continue;
        }

        return response_to_image_data_url(response);
    }

    Err("Too many redirects while fetching image.".to_string())
}

/// Downloads an image natively — the webview cannot attach the GitHub token to
/// <img> requests, so GHE images would 401 — and returns it as a data URL. We
/// send `Accept: */*` because some GHE hosts reply 406 to a narrow `image/*`,
/// and then validate that the final response is actually an image (SSO-gated
/// hosts such as the avatars service redirect to an HTML login page instead).
#[tauri::command]
async fn fetch_image(
    window: tauri::WebviewWindow,
    url: String,
    token: Option<String>,
) -> Result<String, String> {
    let cookies = stored_cookies(window.cookies().unwrap_or_default());
    tauri::async_runtime::spawn_blocking(move || fetch_image_inner(&cookies, url, token))
        .await
        .map_err(|error| error.to_string())?
}

fn fetch_image_inner(
    cookies: &[StoredCookie],
    url: String,
    token: Option<String>,
) -> Result<String, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only http(s) images can be fetched.".to_string());
    }

    let trimmed_token = token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty());
    let mut auth_headers: Vec<Option<String>> = match trimmed_token {
        Some(token) => vec![
            Some(format!("Bearer {token}")),
            Some(format!("token {token}")),
        ],
        None => vec![None],
    };
    if trimmed_token.is_some() {
        auth_headers.push(None);
    }

    let mut last_error: Option<String> = None;
    for auth_header in auth_headers {
        match fetch_image_attempt(cookies, &url, auth_header.as_deref()) {
            Ok(Some(data_url)) => return Ok(data_url),
            Ok(None) => {}
            Err(error) => last_error = Some(error),
        }
    }

    Err(last_error.unwrap_or_else(|| "URL did not return an image.".to_string()))
}

fn parse_http_url(url: &str) -> Result<tauri::Url, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only http(s) URLs can be opened.".to_string());
    }

    tauri::Url::parse(url).map_err(|error| error.to_string())
}

/// Opens the OAuth authorization page in an app-owned webview so Enterprise
/// session cookies are stored where comment avatars are rendered.
#[tauri::command]
async fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = parse_http_url(&url)?;
    if let Some(window) = app.get_webview_window("oauth-login") {
        window.navigate(parsed).map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(&app, "oauth-login", tauri::WebviewUrl::External(parsed))
        .title("GitHub Login")
        .inner_size(960.0, 760.0)
        .build()
        .map_err(|error| error.to_string())?;

    Ok(())
}

/// Opens item/notification links in the operating system's default browser.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = parse_http_url(&url)?;
    open::that(parsed.as_str()).map_err(|error| error.to_string())
}

#[tauri::command]
fn session_token_storage_backend() -> &'static str {
    if cfg!(debug_assertions) {
        "web"
    } else {
        "keychain"
    }
}

#[tauri::command]
fn store_token(service: String, account: String, token: String) -> Result<(), String> {
    let entry = keyring::Entry::new(&service, &account).map_err(|error| error.to_string())?;
    entry
        .set_password(&token)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_token(service: String, account: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(&service, &account).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn delete_token(service: String, account: String) -> Result<(), String> {
    let entry = keyring::Entry::new(&service, &account).map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Logical inset `(x, y)` for the macOS window controls ("traffic lights"),
/// chosen from the detected macOS major version.
///
/// macOS Tahoe (major 26) reworked window chrome: the top-left corner uses a
/// much larger radius (~26pt) drawn concentric with the red close button, and
/// the controls themselves sit slightly higher in the bar. Reusing the older
/// `(20, 15)` inset there leaves them visibly crammed into the rounded corner
/// and a couple of points too high — the exact complaint driving this change.
/// On Tahoe we nudge them right and down; Sequoia/Sonoma and earlier keep the
/// original inset. Kept free of `cfg(target_os)` so it stays unit-testable on
/// every platform (only the caller is macOS-gated).
fn traffic_light_inset(macos_major: Option<u32>) -> (f64, f64) {
    match macos_major {
        Some(major) if major >= 26 => (22.0, 20.0),
        _ => (20.0, 15.0),
    }
}

/// Detected macOS major version via `NSProcessInfo`, e.g. `26` on Tahoe, `15`
/// on Sequoia. `None` if the value does not fit a `u32` (never expected).
#[cfg(target_os = "macos")]
fn macos_major_version() -> Option<u32> {
    use objc2_foundation::NSProcessInfo;
    let version = NSProcessInfo::processInfo().operatingSystemVersion();
    u32::try_from(version.majorVersion).ok()
}

/// Creates the app's main window in Rust rather than `tauri.conf.json` so the
/// macOS traffic-light inset can be picked at launch from the OS version. The
/// builder's `traffic_light_position` is the only officially supported hook in
/// Tauri 2.8 (there is no runtime setter on `WebviewWindow`), and wry re-applies
/// it across resize/fullscreen, unlike a manual `NSWindow` button nudge.
fn build_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    #[allow(unused_mut)]
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("Yonalist")
            .inner_size(1280.0, 820.0)
            .min_inner_size(900.0, 650.0)
            .decorations(true);

    // Overlay title bar, hidden title and traffic-light placement are macOS-only
    // concepts, so keep them off other platforms (the task's "no-op elsewhere").
    #[cfg(target_os = "macos")]
    {
        let (x, y) = traffic_light_inset(macos_major_version());
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(x, y));
    }

    builder.build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(OAuthServerState::default())
        .manage(SyncState::default())
        .manage(AssetPurgePreviewState::default())
        .setup(|app| {
            let app_data_root = app.path().app_data_dir()?;
            let notes_data_root = app_data_root.join("notes");
            NOTES_DATA_ROOT.set(notes_data_root).map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "Notes data root was already initialized",
                )
            })?;
            build_main_window(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            session_token_storage_backend,
            store_token,
            load_token,
            delete_token,
            oauth_start,
            oauth_wait,
            oauth_exchange,
            open_url,
            open_external_url,
            fetch_image,
            record_perf_event,
            notes_initialize,
            notes_sync_start,
            notes_sync_stop,
            notes_sync_flush,
            notes_sync_status,
            notes_sync_retry_quarantined,
            notes_purge_unused_assets,
            notes_load_workspace,
            notes_create_node,
            notes_create_node_before,
            notes_update_node,
            notes_set_readonly,
            notes_delete_nodes,
            notes_materialize_github_notification_and_create_sibling,
            notes_materialize_github_notification_and_reparent,
            notes_refresh_materialized_github_notifications,
            notes_set_github_group_collapsed,
            notes_mark_materialized_github_notification_read,
            notes_split_node,
            notes_apply_image_atom_edit,
            notes_apply_image_atom_paste,
            notes_move_node,
            notes_apply_batch,
            notes_import_subtree,
            notes_import_markdown,
            notes_toggle_complete,
            notes_toggle_collapsed,
            notes_expand_all,
            notes_collapse_all,
            notes_sort_subtree_ascending,
            notes_sort_subtree_descending,
            notes_toggle_star,
            notes_duplicate_node,
            notes_remove_empty_node,
            notes_soft_delete_node,
            notes_restore_node,
            notes_archive_node,
            notes_unarchive_node,
            notes_undo,
            notes_redo,
            notes_history_status,
            notes_lookup_image_atom_operation,
            notes_ack_image_atom_operation,
            notes_prepare_navigation,
            notes_prune_history_entries,
            notes_close_history_session,
            notes_clear_history,
            notes_empty_trash,
            notes_search,
            notes_search_structured,
            notes_list_tags,
            notes_list_tags_with_counts,
            notes_import_attachment,
            notes_import_attachment_paths_batch,
            notes_import_attachment_bytes,
            notes_import_image_node_paths_batch,
            notes_import_image_node_bytes,
            notes_read_attachment_bytes,
            notes_open_attachment_original,
            notes_download_attachment,
            notes_resize_attachment,
            notes_remove_attachment,
            notes_restore_attachment,
            notes_delete_database,
            notes_repair_data,
            notes_reset_database,
            notes_export_markdown,
            notes_export_pdf
        ])
        .build(tauri::generate_context!())
        .expect("error while building Yonalist")
        .run(|app_handle, event| {
            // B1: force one final file-SSOT export before the process exits, so
            // quitting never strands debounced dirty topics. ExitRequested runs
            // while the event loop is still alive (including the tao
            // process::exit path), so the synchronous stop can complete.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<SyncState>();
                if let Err(error) = stop_sync(state.inner()) {
                    eprintln!("Notes sync final flush on exit failed: {error}");
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::{Path, PathBuf};

    const APP_COMMAND_PERMISSION_SET: &str = "main-window-app-commands";
    const EXTERNAL_NOTES_COMMANDS: &[&str] = &[
        "notes_set_readonly",
        "notes_delete_nodes",
        "notes_materialize_github_notification_and_create_sibling",
        "notes_materialize_github_notification_and_reparent",
        "notes_refresh_materialized_github_notifications",
        "notes_set_github_group_collapsed",
        "notes_mark_materialized_github_notification_read",
    ];

    #[cfg(debug_assertions)]
    #[test]
    fn debug_build_uses_web_session_token_storage() {
        assert_eq!(session_token_storage_backend(), "web");
    }

    fn tauri_project_path(relative: impl AsRef<Path>) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
    }

    fn registered_app_commands() -> Vec<String> {
        let source = include_str!("lib.rs");
        source
            .split_once(".invoke_handler(tauri::generate_handler![")
            .expect("desktop invoke handler")
            .1
            .split_once("])")
            .expect("desktop invoke handler terminator")
            .0
            .lines()
            .map(str::trim)
            .map(|line| line.strip_suffix(',').unwrap_or(line))
            .filter(|line| {
                !line.is_empty()
                    && line
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '_')
            })
            .map(str::to_string)
            .collect()
    }

    fn manifest_app_commands() -> Vec<String> {
        let source = fs::read_to_string(tauri_project_path("build.rs")).expect("read build.rs");
        source
            .split_once("const APP_COMMANDS: &[&str] = &[")
            .expect("application command manifest declaration")
            .1
            .split_once("];")
            .expect("application command manifest terminator")
            .0
            .lines()
            .filter_map(|line| {
                line.trim()
                    .strip_prefix('"')
                    .and_then(|line| line.strip_suffix("\","))
            })
            .map(str::to_string)
            .collect()
    }

    fn unique_names(values: &[String], label: &str) -> BTreeSet<String> {
        let names = values.iter().cloned().collect::<BTreeSet<_>>();
        assert_eq!(
            names.len(),
            values.len(),
            "{label} must not contain duplicates"
        );
        names
    }

    fn permission_identifier(value: &serde_json::Value) -> Option<&str> {
        value
            .as_str()
            .or_else(|| value.get("identifier").and_then(|v| v.as_str()))
    }

    #[test]
    fn github_inbox_commands_are_absent_from_native_contracts() {
        let removed = [
            "ensure_vault",
            "read_text_file",
            "write_text_file",
            "delete_text_file",
            "move_text_file",
            "list_outbox_markdown_files",
            "list_vault_item_index",
            "upsert_vault_item_index",
            "get_vault_document_hash",
            "upsert_vault_document_hash",
            "persist_vault_documents",
            "delete_vault_document_hash",
            "move_vault_document_hash",
            "clear_vault_cache",
            "scan_vault_item_index_changes",
            "commit_vault_item_index_changes",
            "load_cached_avatar_image",
            "store_cached_avatar_image",
            "touch_cached_avatar_image",
        ];
        let registered = registered_app_commands();
        let manifest = manifest_app_commands();
        for command in removed {
            assert!(!registered.iter().any(|value| value == command));
            assert!(!manifest.iter().any(|value| value == command));
        }
    }

    #[test]
    fn external_notes_commands_are_registered_once_and_granted_only_to_local_main_window() {
        let expected = EXTERNAL_NOTES_COMMANDS
            .iter()
            .map(|command| (*command).to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            unique_names(&expected, "external notes command contract").len(),
            7,
            "the external notes IPC contract must contain exactly seven commands"
        );

        let registered = registered_app_commands();
        let manifest = manifest_app_commands();
        for command in EXTERNAL_NOTES_COMMANDS {
            assert_eq!(
                registered
                    .iter()
                    .filter(|registered| registered.as_str() == *command)
                    .count(),
                1,
                "{command} must be registered exactly once in the desktop invoke handler"
            );
            assert_eq!(
                manifest
                    .iter()
                    .filter(|manifest_command| manifest_command.as_str() == *command)
                    .count(),
                1,
                "{command} must be registered exactly once in the application command manifest"
            );
        }

        let manifests: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(tauri_project_path("gen/schemas/acl-manifests.json"))
                .expect("read generated ACL manifests"),
        )
        .expect("parse generated ACL manifests");
        let app_manifest = manifests
            .get("__app-acl__")
            .expect("generated application ACL manifest");
        let permissions = app_manifest
            .get("permissions")
            .and_then(|value| value.as_object())
            .expect("application command permissions");
        let main_window_permissions = app_manifest["permission_sets"][APP_COMMAND_PERMISSION_SET]
            ["permissions"]
            .as_array()
            .expect("main-window app command permission list");

        for command in EXTERNAL_NOTES_COMMANDS {
            let identifier = format!("allow-{}", command.replace('_', "-"));
            assert_eq!(
                permissions[&identifier]["commands"]["allow"],
                serde_json::json!([command]),
                "{identifier} must grant only {command}"
            );
            assert_eq!(
                main_window_permissions
                    .iter()
                    .filter(|permission| permission_identifier(permission) == Some(&identifier))
                    .count(),
                1,
                "{identifier} must be granted exactly once by the local main-window set"
            );
        }

        let capabilities: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(tauri_project_path("gen/schemas/capabilities.json"))
                .expect("read generated capabilities"),
        )
        .expect("parse generated capabilities");
        let command_set_grantors = capabilities
            .as_object()
            .expect("generated capability map")
            .iter()
            .filter(|(_, capability)| {
                capability["permissions"]
                    .as_array()
                    .expect("capability permissions")
                    .iter()
                    .any(|permission| {
                        permission_identifier(permission) == Some(APP_COMMAND_PERMISSION_SET)
                    })
            })
            .map(|(identifier, _)| identifier.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            command_set_grantors,
            vec!["default"],
            "only the local main-window capability may grant external notes commands"
        );
        let default_capability = &capabilities["default"];
        assert_eq!(default_capability["windows"], serde_json::json!(["main"]));
        assert_eq!(default_capability["local"], serde_json::json!(true));
        assert!(
            default_capability.get("remote").is_none(),
            "external notes commands must not grant remote origins"
        );
    }

    #[test]
    fn application_manifest_covers_every_registered_command_exactly_once() {
        let registered = registered_app_commands();
        let manifest = manifest_app_commands();

        assert_eq!(
            registered
                .iter()
                .filter(|command| command.as_str() == "notes_import_markdown")
                .count(),
            1,
            "notes_import_markdown must be registered exactly once in the desktop invoke handler"
        );
        assert_eq!(
            manifest
                .iter()
                .filter(|command| command.as_str() == "notes_import_markdown")
                .count(),
            1,
            "notes_import_markdown must be registered exactly once in the application command manifest"
        );
        assert_eq!(
            registered
                .iter()
                .filter(|command| command.as_str() == "notes_reset_database")
                .count(),
            1,
            "notes_reset_database must be registered exactly once in the desktop invoke handler"
        );
        assert_eq!(
            manifest
                .iter()
                .filter(|command| command.as_str() == "notes_reset_database")
                .count(),
            1,
            "notes_reset_database must be registered exactly once in the application command manifest"
        );

        assert_eq!(
            unique_names(&manifest, "application command manifest"),
            unique_names(&registered, "desktop invoke handler"),
            "application command manifest must exactly match the desktop invoke handler"
        );

        let build_source =
            fs::read_to_string(tauri_project_path("build.rs")).expect("read build.rs");
        assert!(
            build_source.contains("commands(APP_COMMANDS)"),
            "Tauri AppManifest must use APP_COMMANDS"
        );
    }

    #[test]
    fn application_commands_are_granted_only_to_local_main_window() {
        let registered = registered_app_commands();
        let registered = unique_names(&registered, "desktop invoke handler");
        let expected_allow_permissions = registered
            .iter()
            .map(|command| format!("allow-{}", command.replace('_', "-")))
            .collect::<BTreeSet<_>>();

        let manifests: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(tauri_project_path("gen/schemas/acl-manifests.json"))
                .expect("read generated ACL manifests"),
        )
        .expect("parse generated ACL manifests");
        let app_manifest = manifests
            .get("__app-acl__")
            .expect("generated application ACL manifest");
        let permissions = app_manifest
            .get("permissions")
            .and_then(|v| v.as_object())
            .expect("application command permissions");

        let actual_allow_permissions = permissions
            .keys()
            .filter(|identifier| identifier.starts_with("allow-"))
            .cloned()
            .collect::<BTreeSet<_>>();
        assert_eq!(
            actual_allow_permissions, expected_allow_permissions,
            "generated allow permissions must exactly cover registered commands"
        );

        for command in &registered {
            let identifier = format!("allow-{}", command.replace('_', "-"));
            assert_eq!(
                permissions[&identifier]["commands"]["allow"],
                serde_json::json!([command]),
                "{identifier} must grant only {command}"
            );
        }

        let command_set = &app_manifest["permission_sets"][APP_COMMAND_PERMISSION_SET];
        let command_set_permissions = command_set["permissions"]
            .as_array()
            .expect("main-window app command permission list")
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .expect("app command permission identifier")
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            unique_names(
                &command_set_permissions,
                "main-window app command permission set"
            ),
            expected_allow_permissions,
            "main-window permission set must include every generated allow permission"
        );

        let app_permission_identifiers = permissions
            .keys()
            .chain(
                app_manifest["permission_sets"]
                    .as_object()
                    .expect("application permission sets")
                    .keys(),
            )
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut app_command_capabilities = Vec::new();
        let capabilities: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(tauri_project_path("gen/schemas/capabilities.json"))
                .expect("read generated capabilities"),
        )
        .expect("parse generated capabilities");
        for capability in capabilities
            .as_object()
            .expect("generated capability map")
            .values()
        {
            let app_permissions = capability["permissions"]
                .as_array()
                .expect("capability permissions")
                .iter()
                .filter_map(permission_identifier)
                .filter(|identifier| app_permission_identifiers.contains(*identifier))
                .collect::<Vec<_>>();
            if app_permissions.is_empty() {
                continue;
            }

            assert_eq!(
                app_permissions,
                vec![APP_COMMAND_PERMISSION_SET],
                "capabilities must grant app commands only through the main-window set"
            );
            assert_eq!(capability["windows"], serde_json::json!(["main"]));
            assert!(
                capability
                    .get("webviews")
                    .and_then(|value| value.as_array())
                    .map_or(true, Vec::is_empty),
                "app command capability must not target additional webviews"
            );
            assert!(
                capability.get("remote").is_none(),
                "app command capability must not grant remote origins"
            );
            assert_eq!(
                capability.get("local").and_then(|value| value.as_bool()),
                Some(true),
                "app command capability must allow the local main window"
            );
            assert_ne!(capability["windows"], serde_json::json!(["oauth-login"]));

            app_command_capabilities.push(
                capability["identifier"]
                    .as_str()
                    .expect("capability identifier")
                    .to_string(),
            );
        }

        assert_eq!(
            app_command_capabilities,
            vec!["default"],
            "only the default local-main capability may grant app commands"
        );
    }

    #[test]
    fn workflowy_subtree_commands_are_registered_for_desktop_invoke() {
        let source = include_str!("lib.rs");
        let handler = source
            .split_once(".invoke_handler(tauri::generate_handler![")
            .expect("desktop invoke handler")
            .1
            .split_once("])")
            .expect("desktop invoke handler terminator")
            .0;

        for command in [
            "notes_expand_all",
            "notes_collapse_all",
            "notes_sort_subtree_ascending",
            "notes_sort_subtree_descending",
            "notes_import_attachment_paths_batch",
            "notes_import_attachment_bytes",
            "notes_import_image_node_paths_batch",
            "notes_import_image_node_bytes",
            "notes_open_attachment_original",
            "notes_download_attachment",
            "notes_apply_batch",
            "notes_import_subtree",
        ] {
            assert!(
                handler
                    .lines()
                    .any(|line| line.trim() == format!("{command},")),
                "desktop invoke handler is missing {command}"
            );
        }
    }

    #[test]
    fn fetch_image_rejects_non_http_urls() {
        assert!(fetch_image_inner(&[], "file:///etc/passwd".to_string(), None).is_err());
        assert!(fetch_image_inner(&[], "data:image/png;base64,AAAA".to_string(), None).is_err());
    }

    #[test]
    fn parse_http_url_accepts_only_http_links_for_opening() {
        assert!(parse_http_url("https://github.com/acme/app/issues/1").is_ok());
        assert!(parse_http_url("http://localhost:1420/auth").is_ok());
        assert!(parse_http_url("file:///etc/passwd").is_err());
        assert!(parse_http_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn cookie_header_serializes_webview_cookies() {
        let cookies = vec![
            StoredCookie {
                name: "user_session".to_string(),
                value: "abc".to_string(),
                domain: Some("oss.navercorp.com".to_string()),
                path: Some("/".to_string()),
                secure: Some(true),
            },
            StoredCookie {
                name: "_gh_sess".to_string(),
                value: "def".to_string(),
                domain: Some(".navercorp.com".to_string()),
                path: Some("/sessions".to_string()),
                secure: Some(true),
            },
        ];
        let url = tauri::Url::parse("https://oss.navercorp.com/sessions/login").unwrap();

        assert_eq!(
            cookie_header(&cookies, &url),
            Some("user_session=abc; _gh_sess=def".to_string())
        );
    }

    #[test]
    fn cookie_header_filters_by_domain_path_and_secure_flag() {
        let cookies = vec![
            StoredCookie {
                name: "keep".to_string(),
                value: "yes".to_string(),
                domain: Some(".navercorp.com".to_string()),
                path: Some("/sessions".to_string()),
                secure: Some(true),
            },
            StoredCookie {
                name: "wrong_domain".to_string(),
                value: "no".to_string(),
                domain: Some("example.com".to_string()),
                path: Some("/".to_string()),
                secure: Some(true),
            },
            StoredCookie {
                name: "wrong_path".to_string(),
                value: "no".to_string(),
                domain: Some("oss.navercorp.com".to_string()),
                path: Some("/admin".to_string()),
                secure: Some(true),
            },
            StoredCookie {
                name: "secure_only".to_string(),
                value: "no".to_string(),
                domain: Some("oss.navercorp.com".to_string()),
                path: Some("/".to_string()),
                secure: Some(true),
            },
        ];

        let https_url = tauri::Url::parse("https://oss.navercorp.com/sessions/login").unwrap();
        let http_url = tauri::Url::parse("http://oss.navercorp.com/sessions/login").unwrap();

        assert_eq!(
            cookie_header(&cookies, &https_url),
            Some("keep=yes; secure_only=no".to_string())
        );
        assert_eq!(cookie_header(&cookies, &http_url), None);
    }

    #[test]
    fn fetch_image_retries_github_token_auth_when_bearer_returns_html() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}/avatar.png", listener.local_addr().expect("addr"));

        let handle = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut request = Vec::new();
                let mut buffer = [0; 512];
                use std::io::Read;
                loop {
                    let read = stream.read(&mut buffer).expect("read request");
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8_lossy(&request);

                if request
                    .to_ascii_lowercase()
                    .contains("authorization: token ghp_token")
                {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\x89PNG",
                        )
                        .expect("write image");
                } else {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 18\r\nConnection: close\r\n\r\n<html>login</html>",
                        )
                        .expect("write html");
                }
            }
        });

        let image = fetch_image_inner(&[], url, Some("ghp_token".to_string())).expect("image");

        handle.join().expect("join");
        assert!(image.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn parse_query_decodes_oauth_callback_parameters() {
        let params = parse_query("code=abc123&state=xyz%2F1+2");

        assert_eq!(params.get("code").map(String::as_str), Some("abc123"));
        assert_eq!(params.get("state").map(String::as_str), Some("xyz/1 2"));
    }

    #[test]
    fn oauth_callback_server_replies_and_returns_params() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();

        let handle =
            std::thread::spawn(move || accept_oauth_callback(listener, OAUTH_CALLBACK_TIMEOUT));

        let mut client = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
        client
            .write_all(b"GET /auth?code=abc&state=s1 HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .expect("send request");
        let mut response = String::new();
        use std::io::Read;
        client.read_to_string(&mut response).expect("read response");

        let params = handle.join().expect("join").expect("params");
        assert_eq!(params.get("code").map(String::as_str), Some("abc"));
        assert_eq!(params.get("state").map(String::as_str), Some("s1"));
        assert!(response.contains("200 OK"));
        assert!(response.contains("로그인이 완료되었습니다"));
    }

    #[test]
    fn oauth_callback_times_out_when_no_redirect_arrives() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");

        let started = std::time::Instant::now();
        let result = accept_oauth_callback(listener, std::time::Duration::from_millis(150));

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Timed out"));
        // Must return promptly after the deadline, not hang.
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn oauth_callback_rejects_oversized_request_line() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();

        let handle =
            std::thread::spawn(move || accept_oauth_callback(listener, OAUTH_CALLBACK_TIMEOUT));

        let mut client = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
        let huge_query = "x".repeat((MAX_REQUEST_LINE_BYTES as usize) + 1024);
        client
            .write_all(format!("GET /auth?code={huge_query} HTTP/1.1\r\n").as_bytes())
            .expect("send request");

        let result = handle.join().expect("join");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("too long"));
    }

    #[test]
    fn oauth_exchange_posts_form_and_returns_body() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let token_url = format!(
            "http://{}/login/oauth/access_token",
            listener.local_addr().expect("addr")
        );

        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            use std::io::Read;
            loop {
                let read = stream.read(&mut buffer).expect("read request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&request);
                if text.contains("client_id=my-client") && text.contains("code=abc") {
                    break;
                }
            }
            let body = r#"{"access_token":"tok_1"}"#;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                )
                .expect("write response");
            String::from_utf8_lossy(&request).into_owned()
        });

        let body = oauth_exchange_inner(
            token_url,
            "my-client".to_string(),
            "secret".to_string(),
            "abc".to_string(),
            "http://localhost:1/auth".to_string(),
        )
        .expect("exchange");

        let request = handle.join().expect("join");
        assert!(request.contains("client_secret=secret"));
        assert!(body.contains("tok_1"));
    }

    #[test]
    fn oauth_exchange_rejects_non_http_urls() {
        let result = oauth_exchange_inner(
            "file:///etc/passwd".to_string(),
            "id".to_string(),
            "secret".to_string(),
            "code".to_string(),
            "http://localhost/auth".to_string(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn traffic_light_inset_uses_larger_offset_on_tahoe() {
        // macOS Tahoe (26) and anything newer get the roomier, lower inset.
        assert_eq!(traffic_light_inset(Some(26)), (22.0, 20.0));
        assert_eq!(traffic_light_inset(Some(27)), (22.0, 20.0));
    }

    #[test]
    fn traffic_light_inset_keeps_legacy_offset_before_tahoe_and_when_unknown() {
        assert_eq!(traffic_light_inset(Some(15)), (20.0, 15.0)); // Sequoia
        assert_eq!(traffic_light_inset(Some(14)), (20.0, 15.0)); // Sonoma
        assert_eq!(traffic_light_inset(None), (20.0, 15.0)); // undetectable
    }

    #[test]
    fn traffic_light_inset_moves_controls_right_and_down_on_tahoe() {
        // Encodes the user-facing requirement: on Tahoe the controls must sit
        // further right and further down than on earlier macOS.
        let (legacy_x, legacy_y) = traffic_light_inset(Some(15));
        let (tahoe_x, tahoe_y) = traffic_light_inset(Some(26));
        assert!(
            tahoe_x > legacy_x,
            "Tahoe controls should sit further right"
        );
        assert!(tahoe_y > legacy_y, "Tahoe controls should sit further down");
    }
}
