# Tarotalking

A free, open-source, ultra-lightweight desktop reading app that reads to you.

**Tarotalking is 100% free and open source** — every feature, forever. No account, no sign-up, no tiers, no trial, no strings attached. Released under the [GPL-3.0](LICENSE): download it, use it, study it, and modify it however you like.

Import a book, a document, or an article; read it in a calm, adjustable reader; and have it read aloud — by free neural voices, fully-offline local voice engines, Windows' built-in voices, or bring-your-own-key cloud providers — with the spoken sentence (or word) highlighted live as you listen. Tarotalking launches in a fraction of a second, stays out of your way, and is built as a native [Tauri 2](https://tauri.app) (Rust) shell around vanilla TypeScript. No UI framework, no runtime JS bloat, no telemetry, no background updater — and the interface itself makes zero network calls; every fetch and every synthesis happens in the Rust backend behind a strict CSP.

Tarotalking is the reading-and-listening sibling of [Taroting](https://github.com/adirhn01-ui/Taroting), the video editor built with the same philosophy: ultra-lightweight, framework-free, native shell, performance first.

> **Status: v0.5 — early development.** English-only for now. Windows is the
> supported platform today. Not yet code-signed (1.0 is reserved for the
> signed, published milestone).

## Highlights

**Import anything readable**
- EPUB (chapters, images, cover art), PDF (uses the document outline for chapters when present; scanned/image-only PDFs are detected and refused with a clear message rather than importing blank pages), Markdown, plain text, pasted text, and web articles (Firefox Reader Mode extraction via Readability)
- Every source normalizes into one clean content model, so every book and article gets the same calm typography — raw source HTML never touches the app's DOM
- Drag-and-drop anywhere, "Open with" association for `.epub` and `.pdf`, single-instance (opening a file focuses the running app)
- Library home with covers, Continue Reading, collections, and favorites

**A reader worth living in**
- Adjustable font, size, line spacing, column width, and justification; four page themes (Paper, Sepia, Slate, Black) on top of full app dark/light theming
- Chapter navigation, estimated reading and listening time left, bookmarks, focus mode, fullscreen
- Highlights in four colors, with optional attached notes — select text, mark it, and find everything again in the table of contents' Highlights tab
- Reading position and listening position are tracked separately, autosaved, and resumed exactly

**Nine voice providers behind one picker**

| Provider | Needs | Notes |
|---|---|---|
| **Microsoft Edge voices** | internet | Free neural voices spoken over Edge's read-aloud service — no Edge window involved. Word-level highlighting. |
| **System voices** | nothing | Windows' built-in voices. Fully offline, zero setup. |
| **Piper** (local) | one-time download | Neural ONNX voices that run entirely on your machine. Download, size, and removal are managed in Settings. |
| **Kokoro** (local) | one-time download | Higher-quality local neural speech — 11 voices in a single ~330 MB bundle, fully offline once installed. |
| **ElevenLabs · OpenAI · Speechify · Deepgram · Cartesia** | your API key | Bring your own key; it is stored in Windows Credential Manager, never in files or logs. Synthesized audio is always cached on disk, so re-listening never re-spends credits. |

The free path — Edge, System, and the local engines — is always the default experience; paid providers are strictly opt-in.

> The Edge provider speaks over Edge's read-aloud service using the same public protocol every open-source Edge-TTS client uses. It is an unofficial endpoint: Microsoft may change or rate-limit it at any time.

**Listening**
- Play/pause, previous/next sentence, paragraph, and chapter, seek slider, pitch-preserving speed (0.5×–3×), volume, sleep timer (minutes or end-of-chapter)
- The spoken sentence is highlighted and kept in view (auto-scroll is optional); Edge voices highlight word by word; click any sentence to start playback from it
- Synthesis is prefetched ahead of playback and cached on disk — size-capped from Settings, or set the cache to Unlimited
- Pre-synthesize a chapter (from the table of contents) or a whole book (from the library card) for instant, offline listening, with a size estimate up front
- Each book remembers its own voice and speed
- A home-screen mini-player keeps playback going while you browse the library
- Standard/High audio quality setting for the network providers

**Desktop integration**
- Media keys and system media controls (play, pause, next, previous)
- Background playback: closing the window while listening hides to the tray and keeps playing (configurable); the tray menu has transport controls
- Native notifications, launch-at-startup option
- No telemetry, ever

## Screenshots

<!-- TODO: drop screenshots into docs/screenshots/ and uncomment.
<img src="docs/screenshots/reader.png" alt="Tarotalking reader" width="800">
-->

## Download

Grab the installer (`Tarotalking_X.Y.Z_x64-setup.exe`) from the [**Releases**](../../releases) page. It installs per-user (no admin rights), adds a Start-menu entry, and registers the `.epub`/`.pdf` "Open with" associations.

The app is not code-signed yet, so Windows SmartScreen may warn on first launch — choose **More info → Run anyway**.

## Performance

Performance is the project's #1 veto criterion: no feature ships if it makes the app slower, and every feature must add zero resource cost when unused. The budget every release is held to, on the reference machine (Windows 11, NVMe, WebView2 Evergreen): cold start to window well under a second, and idle RAM in the ~350–400 MB class (app + WebView2 combined).

That budget shapes the architecture: chapters render as the natural window (only the active block gets sentence-level markup), sentence segmentation is lazy, synthesis never runs more than ~2 sentences ahead, paused playback ticks nothing, and there are no polling loops — an idle Tarotalking does no work at all.

## Privacy & security

- The web view makes **zero network calls** — a strict Content-Security-Policy means the interface can't reach the network even in the worst case. All fetching (articles, voice lists, downloads, synthesis) happens in the Rust backend against fixed endpoints.
- API keys for the bring-your-own-key providers live in **Windows Credential Manager** — never in settings files, never in logs, never readable from the interface.
- Imported EPUB/article HTML is parsed inertly and converted to a typed block model; source-document markup is never injected into the live DOM.
- No telemetry, no analytics, no crash reporting, no phoning home.

## Building from source

**Prerequisites**

- [Node.js](https://nodejs.org) 24+ and npm
- [Rust](https://rustup.rs) stable (MSVC toolchain)

**Build**

```sh
npm install
npm run tauri dev      # run in development
npm run tauri build    # produce the NSIS installer
```

**Tests**

```sh
npm test               # TypeScript unit tests (Vitest)
cargo test             # Rust tests (run from src-tauri/)
```

For the in-app end-to-end harness, generate fixtures once with `node scripts/make-fixtures.mjs`, then launch dev with `TAROTALKING_AUTOTEST=1`. It imports the fixtures and exercises real rendered behavior — playback, highlighting geometry, TOC, annotations — and writes results to `%TEMP%\tarotalking-autotest-report.json`.

## Where your data lives

| What | Location |
|---|---|
| Library + imported content | `%APPDATA%\Tarotalking\library` |
| Settings | `%APPDATA%\Tarotalking\settings.json` |
| Audio cache | `%LOCALAPPDATA%\Tarotalking\cache` (size-capped, safe to clear) |
| Local voices (Piper, Kokoro) | `%LOCALAPPDATA%\Tarotalking\voices` |
| API keys | Windows Credential Manager (never on disk) |

Everything the app stores lives in those locations — no registry footprint beyond the file associations and the optional launch-at-startup entry, no background services.

## License

[GPL-3.0-or-later](LICENSE). Nothing third-party is bundled in this repository.

Local voice engines and models are downloaded on demand, at your request, from their official releases, and carry their own licenses: [Piper](https://github.com/rhasspy/piper) is MIT (individual Piper voices from `rhasspy/piper-voices` may carry their own dataset licenses); [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and the Kokoro voice bundle are Apache-2.0. The Edge and bring-your-own-key providers are online services governed by their providers' own terms.
