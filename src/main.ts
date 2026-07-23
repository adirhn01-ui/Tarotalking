import "./style/tokens.css";
import "./style/base.css";
import "./style/components.css";
import { navigate, setNavigator, type Route } from "./core/nav";
import { initSettings, settingsStore } from "./core/session";
import { initLibrary } from "./core/library";
import { fileExt } from "./core/format";
import { IMPORT_EXTENSIONS } from "./core/types";
import { mountLibrary } from "./library/library";

// Suppress WebView2's native context menu everywhere except editable text
// fields (which keep native copy/paste). Our own contextmenu handlers still
// fire — preventDefault only kills the browser's default menu. Zero-cost.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  const editable =
    t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable;
  if (!editable) e.preventDefault();
});

// In production only, block browser-chrome shortcuts that make no sense in a
// packaged desktop app (print, reload, find, downloads, view-source, …).
if (!import.meta.env.DEV) {
  window.addEventListener(
    "keydown",
    (e) => {
      const k = e.key;
      const ctrl = e.ctrlKey && !e.altKey;
      if (
        (ctrl && (k === "p" || k === "r" || k === "j" || k === "u")) ||
        k === "F5" ||
        k === "F3" ||
        k === "F7"
      ) {
        e.preventDefault();
      }
    },
    true,
  );
}

// Boot: paint the library immediately. The reader is a separate chunk,
// prefetched on idle so opening an item is instant without slowing startup.

const app = document.getElementById("app")!;

type Disposer = () => void | Promise<void>;
let dispose: Disposer | null = null;
let navToken = 0;

async function go(route: Route): Promise<void> {
  const token = ++navToken;
  const prev = dispose;
  dispose = null;
  if (prev) await prev();
  if (token !== navToken) return; // superseded while disposing
  app.innerHTML = "";

  if (route.view === "library") {
    const view = mountLibrary(app);
    dispose = () => view.dispose();
  } else if (route.view === "settings") {
    const { mountSettings } = await import("./settings/settings");
    if (token !== navToken) return;
    const view = mountSettings(app, route.section);
    dispose = () => view.dispose();
  } else {
    const { mountReader } = await import("./reader/reader");
    if (token !== navToken) return;
    const view = await mountReader(app, route.itemId);
    if (token !== navToken) {
      await view.dispose();
      return;
    }
    dispose = () => view.dispose();
  }
}

setNavigator((route) => void go(route));

void (async () => {
  await Promise.all([initSettings(), initLibrary()]);
  await go({ view: "library" });

  // Resume the last-opened item on launch when enabled.
  if (settingsStore.get().resumeLastItem) {
    const { libraryStore } = await import("./core/library");
    const items = libraryStore.get().items;
    let last = null;
    for (const it of items) {
      if (it.lastOpenedAt && (!last || it.lastOpenedAt > (last.lastOpenedAt ?? 0))) last = it;
    }
    if (last) navigate({ view: "reader", itemId: last.id });
  }

  // OS open-with routing + second-instance opens: drain the queued paths.
  const { ipc, onOpenPath } = await import("./core/ipc");
  let openChain: Promise<void> = Promise.resolve();
  const routeOpenPath = async (path: string): Promise<void> => {
    if (!IMPORT_EXTENSIONS.has(fileExt(path))) return;
    const { importFiles } = await import("./core/import");
    const ids = await importFiles([path]);
    if (ids.length === 1) navigate({ view: "reader", itemId: ids[0]! });
  };
  const drainOpenPaths = async (): Promise<void> => {
    try {
      for (const path of await ipc.takePendingOpenPaths()) {
        openChain = openChain.then(() => routeOpenPath(path)).catch(() => {});
      }
    } catch {
      /* not in desktop backend */
    }
  };
  void onOpenPath(() => void drainOpenPaths());
  await drainOpenPaths();

  // Desktop drag-drop: any supported files dropped anywhere import into the
  // library. A lightweight overlay signals the drop target while hovering.
  void (async () => {
    const { inTauri } = await import("./core/ipc");
    if (!inTauri) return;
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    let overlay: HTMLElement | null = null;
    const showOverlay = (): void => {
      if (overlay) return;
      overlay = document.createElement("div");
      overlay.className = "drop-overlay";
      overlay.innerHTML = `<div class="drop-overlay__card">Drop to import</div>`;
      document.body.appendChild(overlay);
    };
    const hideOverlay = (): void => {
      overlay?.remove();
      overlay = null;
    };
    await getCurrentWebview().onDragDropEvent((event) => {
      const t = event.payload.type;
      if (t === "over") return;
      if (t === "enter") {
        const paths = event.payload.paths;
        if (paths.some((p) => IMPORT_EXTENSIONS.has(fileExt(p)))) showOverlay();
      } else if (t === "leave") {
        hideOverlay();
      } else if (t === "drop") {
        hideOverlay();
        const paths = event.payload.paths.filter((p) => IMPORT_EXTENSIONS.has(fileExt(p)));
        if (paths.length > 0) {
          void import("./core/import").then(({ importFiles }) => importFiles(paths));
        }
      }
    });
  })();

  // Dev-only in-app E2E harness (activated via TAROTALKING_AUTOTEST=1).
  if (import.meta.env.DEV) {
    try {
      const { ipc: devIpc, inTauri } = await import("./core/ipc");
      if (inTauri) {
        const info = await devIpc.debugInfo();
        if (info.autotest) {
          const { runAutotest } = await import("./dev/autotest");
          void runAutotest();
        }
      }
    } catch {
      /* not in dev backend */
    }
  }
})();

// Warm the reader + player chunks once the library has painted.
requestIdleCallback?.(() => {
  void import("./reader/reader");
  void import("./player/engine");
});
