// Clean uninstall — remove Tarotalking and every trace of its data from this
// PC, without touching any unrelated user files. Triggered from
// Settings → Storage.
//
// Order matters: we delete our OWN data first (API keys, roaming appdata, local
// data), then spawn ONE detached, windowless process that — after this app has
// exited and released its WebView2 lock — removes the WebView2 user-data dir
// and runs the NSIS uninstaller silently. The uninstaller removes the binaries,
// Start-menu shortcut, registry uninstall entry, and the .epub/.pdf file
// associations it created.
//
// Everything AFTER the "is there an uninstaller?" check is best-effort: a single
// locked file must never strand the user half-uninstalled, so we press on and
// still spawn the finisher + exit.

use crate::error::{AppError, Result};
use crate::{keys, paths};
use std::path::{Path, PathBuf};

/// BYO-key providers whose credentials live in Windows Credential Manager.
/// Mirrors the frontend's KEY_PROVIDERS (settings.ts) / ProviderId (types.ts).
const KEY_PROVIDERS: [&str; 5] = ["eleven", "openai", "speechify", "deepgram", "cartesia"];

/// The installed binaries/uninstaller that share localdata_dir() with our data
/// on a currentUser NSIS install — never swept (the NSIS uninstaller owns them,
/// and we still need uninstall.exe to run).
fn is_installed_binary_name(path: &Path) -> bool {
    match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => {
            let lower = name.to_ascii_lowercase();
            lower == "tarotalking.exe" || lower == "uninstall.exe" || lower.ends_with(".dll")
        }
        None => false,
    }
}

/// Direct children of `localdata` that are safe to delete — our data (cache\,
/// voices\, …) but NEVER the running binary, the uninstaller, or the installed
/// DLLs that live alongside it when the app is installed into localdata itself.
///
/// Pure and side-effect-free apart from reading the directory listing, so it
/// can be unit-tested with tempdirs. Every returned path is guaranteed to be a
/// direct child of `localdata` — never a path outside it.
fn data_entries_to_delete(localdata: &Path, exe_path: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    // The installed binaries share the dir with our data only when the exe sits
    // directly inside localdata (the currentUser NSIS layout).
    let exe_in_localdata = exe_path.parent() == Some(localdata);
    let entries = match std::fs::read_dir(localdata) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Defensive: only ever return direct children of localdata.
        if path.parent() != Some(localdata) {
            continue;
        }
        // Skip any child that IS, or CONTAINS, the running exe — deleting it
        // would remove the binary we're running or the dir holding the
        // uninstaller we're about to launch.
        if exe_path.starts_with(&path) {
            continue;
        }
        // When installed into localdata, never touch the installed binaries.
        if exe_in_localdata && is_installed_binary_name(&path) {
            continue;
        }
        out.push(path);
    }
    out
}

/// Best-effort recursive delete of one path (dir or file); failures are ignored.
fn best_effort_delete(path: &Path) {
    if path.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else {
        let _ = std::fs::remove_file(path);
    }
}

/// Spawn one detached, windowless finisher: wait ~2s for this process to exit
/// and release the WebView2 lock, then remove the WebView2 user-data dir and run
/// the NSIS uninstaller silently. `ping -n 3` (≈2s) is used for the delay
/// because `timeout` needs a console the detached process doesn't have.
#[cfg(windows)]
fn spawn_finisher(webview_dir: &Path, uninstaller: &Path) {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    // One raw command line so cmd parses the `&` chaining and `>NUL` itself,
    // instead of Rust quoting each token as a separate argument.
    let raw = format!(
        "/C ping -n 3 127.0.0.1 >NUL & rmdir /S /Q \"{}\" & \"{}\" /S",
        webview_dir.display(),
        uninstaller.display()
    );
    let mut cmd = Command::new("cmd");
    cmd.raw_arg(&raw)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0008); // CREATE_NO_WINDOW | DETACHED_PROCESS
    let _ = cmd.spawn();
}

#[cfg(not(windows))]
fn spawn_finisher(_webview_dir: &Path, _uninstaller: &Path) {}

/// Remove Tarotalking and all of its data, then exit. On success the app exits
/// (so the frontend does nothing); the only error path is "no uninstaller"
/// (a dev/portable build), which deletes NOTHING.
#[tauri::command]
pub fn uninstall_app(app: tauri::AppHandle) -> Result<()> {
    // 1. Locate the uninstaller. No uninstaller → dev/portable build: delete
    //    NOTHING and point the user at Windows Settings.
    let exe_path =
        std::env::current_exe().map_err(|e| AppError::wrap("Could not locate the app", e))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| AppError::msg("Could not locate the app folder"))?;
    let uninstaller = exe_dir.join("uninstall.exe");
    if !uninstaller.exists() {
        return Err(AppError::msg(
            "Tarotalking isn't installed on this PC (no uninstaller found), so there is nothing to remove here. If you installed it, uninstall it from Windows Settings › Apps instead.",
        ));
    }

    // --- Past this point everything is best-effort: never abort the flow. ---

    // 2. Delete saved API keys (absent keys are fine).
    for provider in KEY_PROVIDERS {
        let _ = keys::key_delete(provider.to_string());
    }

    // 3. Roaming data: library + settings.json.
    let _ = std::fs::remove_dir_all(paths::appdata_dir());

    // 4. Local data (cache\, voices\, …) WITHOUT touching the installed
    //    binaries. Canonicalize both paths so the ancestor/parent comparison is
    //    robust to casing / verbatim-prefix differences between the env-derived
    //    localdata dir and current_exe().
    let localdata = paths::localdata_dir();
    let localdata_c = std::fs::canonicalize(&localdata).unwrap_or(localdata);
    let exe_c = std::fs::canonicalize(&exe_path).unwrap_or_else(|_| exe_path.clone());
    for path in data_entries_to_delete(&localdata_c, &exe_c) {
        best_effort_delete(&path);
    }

    // 5. Finisher: after we exit, wipe the WebView2 dir and run the uninstaller.
    //    WebView2 data lives at %LOCALAPPDATA%\<identifier> (com.tarotalking.app,
    //    the identifier from tauri.conf.json) and is LOCKED until this process
    //    exits — hence the delayed, detached finisher.
    let webview_dir = paths::localdata_dir()
        .parent()
        .map(|p| p.join("com.tarotalking.app"))
        .unwrap_or_else(|| paths::localdata_dir().join("com.tarotalking.app"));
    spawn_finisher(&webview_dir, &uninstaller);

    // 6. Exit shortly so the frontend promise resolves first; exiting releases
    //    the WebView2 lock well before the finisher's ~2s delay elapses.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        handle.exit(0);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("tarot-uninstall-test-{}", uuid::Uuid::new_v4()))
    }

    fn mkdir(p: &Path) {
        std::fs::create_dir_all(p).unwrap();
    }

    fn touch(p: &Path) {
        std::fs::write(p, b"x").unwrap();
    }

    #[test]
    fn keeps_the_exe_dir_but_sweeps_sibling_data() {
        // (a) exe nested inside localdata: localdata\bin\tarotalking.exe.
        let root = unique_temp_dir();
        let localdata = root.join("Tarotalking");
        let bin = localdata.join("bin");
        let cache = localdata.join("cache");
        let voices = localdata.join("voices");
        mkdir(&bin);
        mkdir(&cache);
        mkdir(&voices);
        let exe = bin.join("tarotalking.exe");
        touch(&exe);

        let del = data_entries_to_delete(&localdata, &exe);
        assert!(!del.contains(&bin), "the dir holding the exe must be kept");
        assert!(del.contains(&cache), "sibling cache must be swept");
        assert!(del.contains(&voices), "sibling voices must be swept");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sweeps_everything_when_exe_lives_elsewhere() {
        // (b) exe entirely outside localdata → all children are data.
        let root = unique_temp_dir();
        let localdata = root.join("Tarotalking");
        let cache = localdata.join("cache");
        let voices = localdata.join("voices");
        mkdir(&cache);
        mkdir(&voices);
        let exe = root.join("Program Files").join("Tarotalking").join("tarotalking.exe");
        mkdir(exe.parent().unwrap());
        touch(&exe);

        let del = data_entries_to_delete(&localdata, &exe);
        assert!(del.contains(&cache));
        assert!(del.contains(&voices));
        assert_eq!(del.len(), 2, "both data dirs, nothing excluded");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn install_layout_keeps_binaries_sweeps_data() {
        // currentUser NSIS layout: exe + uninstaller + dll sit directly in
        // localdata alongside cache\ and voices\.
        let root = unique_temp_dir();
        let localdata = root.join("Tarotalking");
        mkdir(&localdata);
        let exe = localdata.join("tarotalking.exe");
        let uninstaller = localdata.join("uninstall.exe");
        let dll = localdata.join("WebView2Loader.dll");
        let cache = localdata.join("cache");
        let voices = localdata.join("voices");
        touch(&exe);
        touch(&uninstaller);
        touch(&dll);
        mkdir(&cache);
        mkdir(&voices);

        let del = data_entries_to_delete(&localdata, &exe);
        assert!(!del.contains(&exe), "running exe kept");
        assert!(!del.contains(&uninstaller), "uninstaller kept (still needed)");
        assert!(!del.contains(&dll), "installed dll kept");
        assert!(del.contains(&cache), "cache swept");
        assert!(del.contains(&voices), "voices swept");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn returned_paths_are_always_inside_localdata() {
        // (c) invariant: every swept path is a direct child of localdata.
        let root = unique_temp_dir();
        let localdata = root.join("Tarotalking");
        let cache = localdata.join("cache");
        let voices = localdata.join("voices");
        mkdir(&cache);
        mkdir(&voices);
        let exe = localdata.join("tarotalking.exe");
        touch(&exe);

        let del = data_entries_to_delete(&localdata, &exe);
        assert!(!del.is_empty(), "there is data to sweep");
        for p in &del {
            assert_eq!(
                p.parent(),
                Some(localdata.as_path()),
                "every path is a direct child of localdata"
            );
            assert!(p.starts_with(&localdata), "never outside localdata");
        }

        std::fs::remove_dir_all(&root).ok();
    }
}
