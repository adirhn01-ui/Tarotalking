// System tray: play/pause + paragraph navigation from the tray while the
// window is hidden; tooltip mirrors playback.

use crate::PlaybackState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const TRAY_ID: &str = "main-tray";

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Create the tray icon + menu. Called once from setup.
pub fn init(app: &AppHandle) {
    let build = || -> tauri::Result<()> {
        let open = MenuItem::with_id(app, "open", "Open Tarotalking", true, None::<&str>)?;
        let play = MenuItem::with_id(app, "play-pause", "Play / pause", true, None::<&str>)?;
        let prev = MenuItem::with_id(app, "prev", "Previous paragraph", true, None::<&str>)?;
        let next = MenuItem::with_id(app, "next", "Next paragraph", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        let menu = Menu::with_items(
            app,
            &[
                &open,
                &PredefinedMenuItem::separator(app)?,
                &play,
                &prev,
                &next,
                &PredefinedMenuItem::separator(app)?,
                &quit,
            ],
        )?;
        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .menu(&menu)
            .show_menu_on_left_click(false)
            .tooltip("Tarotalking")
            .on_menu_event(|app, event| match event.id.as_ref() {
                "open" => show_main(app),
                "quit" => {
                    // Give the frontend a beat to flush state, then exit hard.
                    let _ = app.emit("tray-action", "quit");
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(600));
                        handle.exit(0);
                    });
                }
                other => {
                    let _ = app.emit("tray-action", other.to_string());
                }
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                    show_main(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
        Ok(())
    };
    // A missing tray is an inconvenience, never a startup failure.
    let _ = build();
}

/// Update the tray tooltip after a playback-state change.
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let tooltip = app
        .try_state::<PlaybackState>()
        .and_then(|s| {
            let flag = s.0.lock().ok()?;
            if flag.playing {
                Some(match &flag.title {
                    Some(t) => format!("Tarotalking — playing: {t}"),
                    None => "Tarotalking — playing".to_string(),
                })
            } else {
                None
            }
        })
        .unwrap_or_else(|| "Tarotalking".to_string());
    let _ = tray.set_tooltip(Some(tooltip));
}

/// One-time "still playing in the background" notification on close-to-tray.
pub fn notify_backgrounded(app: &AppHandle) {
    if !crate::settings::read_field_bool("notifications", true) {
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    let body = app
        .try_state::<PlaybackState>()
        .and_then(|s| s.0.lock().ok().and_then(|f| f.title.clone()))
        .unwrap_or_else(|| "Playback continues".to_string());
    let _ = app
        .notification()
        .builder()
        .title("Still playing in the background")
        .body(body)
        .show();
}
