# Security

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub's **Security → Report a
vulnerability** on this repository rather than opening a public issue.

## Architecture invariants

These are the properties the codebase is built around and audited against:

- **The webview makes zero network calls.** A strict CSP (`script-src 'self'`,
  `connect-src` limited to Tauri's `ipc:`/`asset:` protocols) means the
  interface cannot reach the network even if compromised. All HTTP/WebSocket
  traffic happens in the Rust backend.
- **Fixed endpoints.** Every outbound Rust request targets a hardcoded
  provider host or a pinned release URL (Piper/Kokoro engine and model
  downloads). User-supplied article URLs are validated `http(s)://` only.
  Voice/model identifiers are validated against fixed catalogs or strict
  character allowlists before any URL is built.
- **API keys never leave Rust.** Keys for the bring-your-own-key providers
  live in Windows Credential Manager, are read only inside the Rust backend,
  are sent only as HTTP headers (never query params), and are never logged,
  never written to disk, and never returned over IPC (only a "key present"
  boolean is exposed).
- **Source documents never touch the live DOM as HTML.** EPUB/article/Markdown
  markup is parsed with an inert `DOMParser` and converted to a typed block
  model; the reader renders exclusively via `createElement`/`textContent`.
  All other UI templating HTML-escapes untrusted strings.
- **Asset protocol scope** is limited to the app's own data directories,
  never broad filesystem patterns.
- **No `unsafe` Rust**, no `eval`/`new Function` in TypeScript, and all
  child processes (Piper, sherpa-onnx, `tar`) are spawned with argv arrays,
  never shell strings. Archive extraction rejects path traversal.

## Known, deliberate trade-offs

Documented here so they aren't rediscovered as findings:

- **`style-src 'unsafe-inline'`** is allowed in the CSP: app-authored
  templates use inline `style` attributes (progress widths, font previews).
  Script execution remains locked to `'self'` with no eval, and untrusted
  strings are escaped before entering any template.
- **Import commands accept caller-supplied paths.** `read_text_file`,
  `read_file_bytes`, and `import_epub` read whatever path the frontend passes
  (with size caps); paths originate from the OS file dialog or drag-and-drop.
  A hostile webview could abuse these, but the CSP makes webview compromise
  the hard prerequisite. Dialog-scoped path provenance is the planned
  hardening.
- **Engine downloads are TLS + pinned-URL, not yet checksum-pinned.** The
  Piper and sherpa-onnx executables come from their official GitHub release
  URLs; SHA-256 pinning is planned before 1.0.
- **The Edge voice provider uses Microsoft's read-aloud endpoint via its
  publicly known protocol** (the same shared client token every open-source
  Edge-TTS client uses). It is unofficial and may change or be rate-limited
  at any time.
