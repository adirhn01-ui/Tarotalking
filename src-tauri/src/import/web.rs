// Web page fetching for article import. The frontend has no network access;
// this is the only place HTML enters the app. Extraction (readability)
// happens in the frontend on the returned string.

use crate::error::{AppError, Result};
use serde::Serialize;
use std::io::Read;
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_BODY: u64 = 10 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedPage {
    pub final_url: String,
    pub content_type: String,
    pub body: String,
}

#[tauri::command]
pub async fn fetch_url(url: String) -> Result<FetchedPage> {
    tauri::async_runtime::spawn_blocking(move || fetch_blocking(&url))
        .await
        .map_err(|e| AppError::wrap("Fetch task", e))?
}

fn fetch_blocking(url: &str) -> Result<FetchedPage> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(AppError::msg("Enter a valid http(s) address"));
    }
    let host = host_of(url);

    let resp = match ureq::get(url)
        .set("User-Agent", UA)
        .set("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
        .set("Accept-Language", "en-US,en;q=0.9")
        .timeout(Duration::from_secs(20))
        .call()
    {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => {
            return Err(AppError::msg(format!("The page returned HTTP {code}")));
        }
        Err(_) => return Err(AppError::msg(format!("Could not reach {host}"))),
    };

    let final_url = resp.get_url().to_string();
    let content_type = resp
        .header("Content-Type")
        .map(|s| s.to_string())
        .unwrap_or_else(|| "text/html".to_string());

    let mut buf: Vec<u8> = Vec::new();
    resp.into_reader()
        .take(MAX_BODY)
        .read_to_end(&mut buf)
        .map_err(|_| AppError::msg(format!("Could not reach {host}")))?;
    let body = String::from_utf8_lossy(&buf).into_owned();

    Ok(FetchedPage {
        final_url,
        content_type,
        body,
    })
}

/// Best-effort host extraction for a friendly transport-error message.
fn host_of(url: &str) -> String {
    let after = url.splitn(2, "://").nth(1).unwrap_or(url);
    let authority = after.split(['/', '?', '#']).next().unwrap_or(after);
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    authority.split(':').next().unwrap_or(authority).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_http_schemes() {
        for bad in ["ftp://example.com", "file:///etc/passwd", "javascript:1", "example.com"] {
            let err = match fetch_blocking(bad) {
                Err(e) => e,
                Ok(_) => panic!("expected {bad} to be rejected"),
            };
            assert_eq!(err.to_string(), "Enter a valid http(s) address");
        }
    }

    #[test]
    fn host_extraction() {
        assert_eq!(host_of("https://user:pw@example.com:8443/path?q=1#f"), "example.com");
        assert_eq!(host_of("http://sub.example.org/a"), "sub.example.org");
    }
}
