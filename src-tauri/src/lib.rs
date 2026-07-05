use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VaultPaths {
    pub metadata_dir: String,
    pub outbox_dir: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VaultMarkdownFile {
    pub relative_path: String,
    pub contents: String,
}

fn display_path(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

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

pub fn vault_paths(vault_path: impl AsRef<Path>) -> VaultPaths {
    let vault_path = expand_vault_path(&vault_path.as_ref().to_string_lossy());
    let metadata_dir = vault_path.join(".yonalist");
    let outbox_dir = metadata_dir.join("outbox");

    VaultPaths {
        metadata_dir: display_path(metadata_dir),
        outbox_dir: display_path(outbox_dir),
    }
}

/// Resolves a vault-relative file path, rejecting absolute paths and any
/// component that could escape the vault root (`..`, drive prefixes, ...).
pub fn resolve_vault_file(vault_path: &str, relative_path: &str) -> Result<PathBuf, String> {
    if vault_path.trim().is_empty() {
        return Err("Vault path must not be empty.".to_string());
    }

    let relative = Path::new(relative_path);
    if relative.as_os_str().is_empty() {
        return Err("File path must not be empty.".to_string());
    }
    if relative.is_absolute() {
        return Err("File path must be relative to the vault.".to_string());
    }
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("File path may not contain '..', '.' or root components.".to_string());
    }

    Ok(expand_vault_path(vault_path).join(relative))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Writes through a sibling temp file and renames it into place so a crash
/// mid-write never leaves a truncated vault document behind.
fn write_text_file_inner(path: &Path, contents: &str) -> Result<(), String> {
    ensure_parent(path)?;

    let mut temp_name = path
        .file_name()
        .ok_or_else(|| "File path must name a file.".to_string())?
        .to_os_string();
    temp_name.push(".tmp");
    let temp_path = path.with_file_name(temp_name);

    fs::write(&temp_path, contents).map_err(|error| error.to_string())?;
    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        error.to_string()
    })
}

fn collect_markdown_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<VaultMarkdownFile>,
) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_dir() {
            collect_markdown_files(root, &path, files)?;
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }

        let relative_path = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        files.push(VaultMarkdownFile {
            relative_path,
            contents,
        });
    }

    Ok(())
}

#[tauri::command]
fn ensure_vault(vault_path: String) -> Result<VaultPaths, String> {
    let paths = vault_paths(&vault_path);
    fs::create_dir_all(&paths.outbox_dir).map_err(|error| error.to_string())?;
    Ok(paths)
}

#[tauri::command]
fn read_text_file(vault_path: String, relative_path: String) -> Result<String, String> {
    let path = resolve_vault_file(&vault_path, &relative_path)?;
    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_text_file(
    vault_path: String,
    relative_path: String,
    contents: String,
) -> Result<(), String> {
    let path = resolve_vault_file(&vault_path, &relative_path)?;
    write_text_file_inner(&path, &contents)
}

#[tauri::command]
fn delete_text_file(vault_path: String, relative_path: String) -> Result<(), String> {
    let path = resolve_vault_file(&vault_path, &relative_path)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn move_text_file(
    vault_path: String,
    from_relative_path: String,
    to_relative_path: String,
    contents: Option<String>,
) -> Result<(), String> {
    let from_path = resolve_vault_file(&vault_path, &from_relative_path)?;
    let to_path = resolve_vault_file(&vault_path, &to_relative_path)?;
    ensure_parent(&to_path)?;

    if let Some(contents) = contents {
        write_text_file_inner(&to_path, &contents)?;
        let _ = fs::remove_file(from_path);
        return Ok(());
    }

    fs::rename(&from_path, &to_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_markdown_files(vault_path: String) -> Result<Vec<VaultMarkdownFile>, String> {
    if vault_path.trim().is_empty() {
        return Err("Vault path must not be empty.".to_string());
    }

    let expanded = expand_vault_path(&vault_path);
    let root = expanded.as_path();
    let mut files = Vec::new();
    collect_markdown_files(root, root, &mut files)?;
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(files)
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

fn accept_oauth_callback(listener: TcpListener) -> Result<HashMap<String, String>, String> {
    let (mut stream, _) = listener.accept().map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|error| error.to_string())?;

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

    let params = tauri::async_runtime::spawn_blocking(move || accept_oauth_callback(listener))
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
/// webview's CORS policy cannot block the token endpoint.
#[tauri::command]
fn oauth_exchange(
    token_url: String,
    client_id: String,
    client_secret: String,
    code: String,
    redirect_uri: String,
) -> Result<String, String> {
    if !token_url.starts_with("https://") && !token_url.starts_with("http://") {
        return Err("Token URL must be an http(s) URL.".to_string());
    }
    let response = ureq::post(&token_url)
        .set("Accept", "application/json")
        .send_form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .map_err(|error| error.to_string())?;
    response.into_string().map_err(|error| error.to_string())
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

fn response_to_image_data_url(response: ureq::Response) -> Result<Option<String>, String> {
    let content_type = response.content_type().to_string();
    if !content_type.starts_with("image/") {
        return Ok(None);
    }

    let mut bytes: Vec<u8> = Vec::new();
    std::io::Read::take(response.into_reader(), MAX_IMAGE_BYTES)
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

fn redirect_target(current: &tauri::Url, response: &ureq::Response) -> Option<tauri::Url> {
    if !(300..400).contains(&response.status()) {
        return None;
    }
    response
        .header("Location")
        .and_then(|location| current.join(location).ok())
}

fn fetch_image_attempt(
    cookies: &[StoredCookie],
    url: &str,
    auth_header: Option<&str>,
) -> Result<Option<String>, String> {
    let agent = ureq::builder().redirects(0).build();
    let mut current_url = tauri::Url::parse(url).map_err(|error| error.to_string())?;

    for _ in 0..=MAX_IMAGE_REDIRECTS {
        let cookie_header = cookie_header(cookies, &current_url);
        let mut request = agent.get(current_url.as_str()).set("Accept", "*/*");
        if let Some(auth_header) = auth_header {
            request = request.set("Authorization", auth_header);
        }
        if let Some(cookie_header) = cookie_header.as_deref() {
            request = request.set("Cookie", cookie_header);
        }

        let response = match request.call() {
            Ok(response) => response,
            Err(ureq::Error::Status(_, response)) => response,
            Err(error) => return Err(error.to_string()),
        };

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

/// Opens the OAuth authorization page in an app-owned webview so Enterprise
/// session cookies are stored where comment avatars are rendered.
#[tauri::command]
async fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only http(s) URLs can be opened.".to_string());
    }

    let parsed = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(OAuthServerState::default())
        .invoke_handler(tauri::generate_handler![
            ensure_vault,
            read_text_file,
            write_text_file,
            delete_text_file,
            move_text_file,
            list_markdown_files,
            store_token,
            load_token,
            oauth_start,
            oauth_wait,
            oauth_exchange,
            open_url,
            fetch_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running Yonalist");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_paths_match_markdown_vault_plan() {
        let paths = vault_paths("/tmp/yonalist-vault");

        assert_eq!(paths.metadata_dir, "/tmp/yonalist-vault/.yonalist");
        assert_eq!(paths.outbox_dir, "/tmp/yonalist-vault/.yonalist/outbox");
    }

    #[test]
    fn vault_paths_expand_home_shorthand() {
        let home = std::env::var("HOME").expect("home");
        let paths = vault_paths("~/Yonalist");

        assert_eq!(paths.metadata_dir, format!("{home}/Yonalist/.yonalist"));
        assert_eq!(
            paths.outbox_dir,
            format!("{home}/Yonalist/.yonalist/outbox")
        );
    }

    #[test]
    fn write_text_file_creates_parent_directories() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let path = temp_dir
            .path()
            .join("github.com")
            .join("openai")
            .join("codex")
            .join("issues")
            .join("42")
            .join("issue.md");

        write_text_file_inner(&path, "---\nkind: issue\n---\nbody").expect("write file");

        let contents = fs::read_to_string(path).expect("read file");
        assert!(contents.contains("kind: issue"));
    }

    #[test]
    fn list_markdown_files_returns_vault_relative_documents() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let issue_path = temp_dir
            .path()
            .join("github.com/acme/app/issues/1/issue.md");
        let attachment_path = temp_dir
            .path()
            .join("github.com/acme/app/issues/1/image.png");
        write_text_file_inner(&issue_path, "---\nkind: issue\n---\nbody").expect("write md");
        ensure_parent(&attachment_path).expect("attachment parent");
        fs::write(&attachment_path, b"png").expect("write attachment");

        let files =
            list_markdown_files(display_path(temp_dir.path().to_path_buf())).expect("list files");

        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].relative_path,
            "github.com/acme/app/issues/1/issue.md"
        );
        assert!(files[0].contents.contains("kind: issue"));
    }

    #[test]
    fn move_text_file_can_replace_contents_and_remove_source() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        write_text_file(
            display_path(temp_dir.path().to_path_buf()),
            "drafts/issue.md".to_string(),
            "draft".to_string(),
        )
        .expect("write draft");

        move_text_file(
            display_path(temp_dir.path().to_path_buf()),
            "drafts/issue.md".to_string(),
            "issues/10/issue.md".to_string(),
            Some("synced".to_string()),
        )
        .expect("move file");

        assert!(!temp_dir.path().join("drafts/issue.md").exists());
        assert_eq!(
            fs::read_to_string(temp_dir.path().join("issues/10/issue.md")).expect("read moved"),
            "synced"
        );
    }

    #[test]
    fn write_text_file_leaves_no_temp_file_behind() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let path = temp_dir.path().join("issue.md");

        write_text_file_inner(&path, "body").expect("write file");

        let entries: Vec<_> = fs::read_dir(temp_dir.path())
            .expect("read dir")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("issue.md")]);
    }

    #[test]
    fn resolve_vault_file_joins_relative_paths() {
        let path = resolve_vault_file("/tmp/vault", "github.com/openai/codex/issues/42/issue.md")
            .expect("resolve");

        assert_eq!(
            path,
            PathBuf::from("/tmp/vault/github.com/openai/codex/issues/42/issue.md")
        );
    }

    #[test]
    fn fetch_image_rejects_non_http_urls() {
        assert!(fetch_image_inner(&[], "file:///etc/passwd".to_string(), None).is_err());
        assert!(fetch_image_inner(&[], "data:image/png;base64,AAAA".to_string(), None).is_err());
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

                if request.contains("Authorization: token ghp_token") {
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

        let handle = std::thread::spawn(move || accept_oauth_callback(listener));

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
    fn resolve_vault_file_rejects_escaping_paths() {
        assert!(resolve_vault_file("/tmp/vault", "../outside.md").is_err());
        assert!(resolve_vault_file("/tmp/vault", "nested/../../outside.md").is_err());
        assert!(resolve_vault_file("/tmp/vault", "/etc/passwd").is_err());
        assert!(resolve_vault_file("/tmp/vault", "").is_err());
        assert!(resolve_vault_file("", "issue.md").is_err());
    }
}
