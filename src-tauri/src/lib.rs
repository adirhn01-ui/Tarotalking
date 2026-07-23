// Tarotalking shell: plugin setup, single-instance open-path queue, shared
// state, and the full command registry.

mod downloads;
mod error;
mod import;
mod keys;
mod library;
mod paths;
mod settings;
mod tray;
mod tts;

use error::Result;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Paths queued by file-association opens and second-instance launches,
/// drained atomically by the frontend.
pub struct OpenQueue(pub Mutex<Vec<String>>);

/// What the frontend reports about playback (drives tray + close-to-tray).
#[derive(Default)]
pub struct PlaybackFlag {
    pub playing: bool,
    pub title: Option<String>,
}
pub struct PlaybackState(pub Mutex<PlaybackFlag>);

fn queue_paths_from_args(app: &tauri::AppHandle, args: &[String]) {
    let paths: Vec<String> = args
        .iter()
        .skip(1)
        .filter(|a| !a.starts_with('-') && std::path::Path::new(a).exists())
        .cloned()
        .collect();
    if paths.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<OpenQueue>() {
        state.0.lock().unwrap().extend(paths);
        let _ = app.emit("open-path", ());
    }
}

#[tauri::command]
fn take_pending_open_paths(state: tauri::State<OpenQueue>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

#[tauri::command]
fn set_playback_state(
    app: tauri::AppHandle,
    state: tauri::State<PlaybackState>,
    playing: bool,
    title: Option<String>,
) {
    {
        let mut flag = state.0.lock().unwrap();
        flag.playing = playing;
        flag.title = title;
    }
    tray::refresh(&app);
}

#[tauri::command]
fn show_in_folder(path: String) -> Result<()> {
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .map_err(|e| error::AppError::wrap("Could not open folder", e))
}

#[derive(serde::Serialize)]
struct DebugInfo {
    autotest: bool,
}

#[tauri::command]
fn debug_info() -> DebugInfo {
    DebugInfo {
        autotest: std::env::var("TAROTALKING_AUTOTEST").is_ok_and(|v| v == "1"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            queue_paths_from_args(app, &args);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .manage(OpenQueue(Mutex::new(Vec::new())))
        .manage(PlaybackState(Mutex::new(PlaybackFlag::default())))
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            queue_paths_from_args(app.handle(), &args);
            tray::init(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray: while playback is active (and the setting is on),
            // closing the window hides it and audio keeps going.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let playing = window
                    .app_handle()
                    .try_state::<PlaybackState>()
                    .map(|s| s.0.lock().unwrap().playing)
                    .unwrap_or(false);
                if playing && settings::read_field_bool("closeToTray", true) {
                    api.prevent_close();
                    let _ = window.hide();
                    tray::notify_backgrounded(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // shell
            take_pending_open_paths,
            set_playback_state,
            show_in_folder,
            debug_info,
            // settings
            settings::settings_load,
            settings::settings_save,
            // library
            library::library_load,
            library::library_save,
            library::item_write_doc,
            library::item_read_doc,
            library::item_delete,
            // import
            import::epub::import_epub,
            import::text::read_text_file,
            import::web::fetch_url,
            // keys
            keys::key_set,
            keys::key_present,
            keys::key_delete,
            // tts
            tts::tts_synth,
            tts::edge::edge_voices,
            tts::eleven::eleven_voices,
            tts::piper::piper_status,
            tts::piper::piper_install_binary,
            tts::piper::piper_install_model,
            tts::piper::piper_remove_model,
            tts::piper::piper_remove_all,
            tts::piper::piper_dir,
            tts::cache::cache_stats,
            tts::cache::cache_clear,
            tts::cache::cache_prune,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
