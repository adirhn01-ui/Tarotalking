// System tray: play/pause + navigation from the tray while the window is
// hidden. Fleshed out in the integration phase.

use tauri::AppHandle;

/// Create the tray icon + menu. Called once from setup.
pub fn init(_app: &AppHandle) {
    // Wired in the integration phase (icon + menu + events).
}

/// Update tray tooltip/menu after a playback-state change.
pub fn refresh(_app: &AppHandle) {}

/// One-time "still playing in the background" notification on close-to-tray.
pub fn notify_backgrounded(_app: &AppHandle) {}
