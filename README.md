# Tarotalking

A fast, lightweight desktop reading app that also reads to you.

Import an EPUB, a text file, pasted text, or a web article — Tarotalking
normalizes everything into one calm, adjustable reading experience, and can
speak it aloud with the sentence (or word) being spoken highlighted live.
Reading and listening positions are saved automatically and stay in sync with
your library.

Tarotalking is the reading-and-listening sibling of
[Taroting](https://github.com/adirhn01-ui/Taroting): the same
ultra-lightweight, framework-free, native-shell philosophy, purpose-built for
books and articles instead of video.

> **Status: early development.** English-only for now. Windows is the
> supported platform today.

## Voices

Four voice providers behind one picker:

| Provider | Needs | Notes |
|---|---|---|
| **Microsoft Edge voices** | internet | Free neural voices spoken over Edge's read-aloud service — no Edge window involved. Word-level highlighting. |
| **System voices** | nothing | Windows' built-in voices. Fully offline, zero setup. |
| **Local voices (Piper)** | one-time download | Neural ONNX voices that run entirely on your machine. Download, size, and removal are managed in Settings. |
| **ElevenLabs** | your API key | Bring your own key; stored in Windows Credential Manager, never in files or logs. Synthesized audio is always cached so re-listening never re-spends credits. |

## Reading

- One consistent reader for every source: adjustable font, size, line
  spacing, column width, justification, and five page themes (plus full app
  dark/light theming)
- Chapter navigation, estimated reading and listening time left, bookmarks,
  focus mode, fullscreen
- Positions resume exactly where you left off — reading and listening tracked
  separately

## Listening

- Play/pause, previous/next sentence, paragraph, and chapter, seek slider,
  speed (0.5×–3×), volume, sleep timer (minutes or end-of-chapter)
- The spoken sentence is highlighted and kept in view (auto-scroll is
  optional); Edge voices highlight word by word
- Synthesis is prefetched ahead of playback and cached on disk (size-capped,
  clearable in Settings)

## Desktop integration

- Media keys / system media controls (play, pause, next, previous)
- Background playback: closing the window while listening hides to the tray
  and keeps playing (configurable); tray menu has transport controls
- Drag-and-drop import, `.epub` "Open with" association, single-instance
- Native notifications, launch-at-startup option
- No telemetry. The interface itself makes no network requests — all
  fetching/synthesis happens in the Rust backend with fixed endpoints.

## Where your data lives

| What | Location |
|---|---|
| Library + imported content | `%APPDATA%\Tarotalking\library` |
| Settings | `%APPDATA%\Tarotalking\settings.json` |
| Audio cache | `%LOCALAPPDATA%\Tarotalking\cache` (size-capped, safe to clear) |
| Local voice models | `%LOCALAPPDATA%\Tarotalking\voices` |
| API keys | Windows Credential Manager (never on disk) |

## Building from source

Prerequisites: [Node.js](https://nodejs.org) 24+, [Rust](https://rustup.rs)
stable (MSVC).

```sh
npm install
npm run tauri dev      # run in development
npm run tauri build    # produce the NSIS installer + portable exe
```

Tests:

```sh
npm test               # TypeScript unit tests (Vitest)
cargo test             # Rust tests (from src-tauri/)
```

For the in-app end-to-end harness, launch dev with `TAROTALKING_AUTOTEST=1`
(after `node scripts/make-fixtures.mjs`); results land in
`%TEMP%\tarotalking-autotest-report.json`.

## License

[GPL-3.0-or-later](LICENSE).
