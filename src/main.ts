import "./style/tokens.css";
import "./style/base.css";
import "./style/components.css";
import { itemRoute, navigate, setNavigator, type Route } from "./core/nav";
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
  } else if (route.view === "activity") {
    const { mountActivity } = await import("./activity/activity");
    if (token !== navToken) return;
    const view = mountActivity(app);
    dispose = () => view.dispose();
  } else if (route.view === "audiobook") {
    const { mountAudiobookPlayer } = await import("./audiobook/player");
    if (token !== navToken) return;
    const view = mountAudiobookPlayer(app, route.itemId);
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

  // The asset scope isn't persisted, so after a restart the webview can't load
  // any previously imported audio until those paths are allowed again. Fire it
  // right after the first paint, off the critical path, and swallow everything:
  // a library with no audiobooks must cost nothing and boot must never break.
  void (async () => {
    try {
      const { libraryStore } = await import("./core/library");
      const paths: string[] = [];
      for (const it of libraryStore.get().items) {
        for (const t of it.audio?.tracks ?? []) if (t.path) paths.push(t.path);
      }
      if (paths.length === 0) return;
      const { ipc: ipcMod } = await import("./core/ipc");
      await ipcMod.allowAudioPaths(paths);
    } catch {
      /* the player reports unplayable tracks itself */
    }
  })();

  // Resume the last-opened item on launch when enabled.
  if (settingsStore.get().resumeLastItem) {
    const { libraryStore } = await import("./core/library");
    const items = libraryStore.get().items;
    let last = null;
    for (const it of items) {
      if (it.lastOpenedAt && (!last || it.lastOpenedAt > (last.lastOpenedAt ?? 0))) last = it;
    }
    if (last) navigate(itemRoute(last));
  }

  // Tray actions: transport without the window, graceful quit with a flush.
  const { onTrayAction } = await import("./core/ipc");
  void onTrayAction((action) => {
    void (async () => {
      const { engine } = await import("./player/engine");
      if (action === "play-pause") engine.toggle();
      else if (action === "next") engine.nextParagraph();
      else if (action === "prev") engine.prevParagraph();
      else if (action === "quit") {
        const [{ flushLibrary }, { ipc: ipcMod }] = await Promise.all([
          import("./core/library"),
          import("./core/ipc"),
        ]);
        engine.stop();
        await flushLibrary();
        await ipcMod.quitApp().catch(() => {});
      }
    })();
  });

  // OS open-with routing + second-instance opens: drain the queued paths.
  const { ipc, onOpenPath } = await import("./core/ipc");
  let openChain: Promise<void> = Promise.resolve();
  const routeOpenPath = async (path: string): Promise<void> => {
    if (!IMPORT_EXTENSIONS.has(fileExt(path))) return;
    const [{ importFiles }, { getItem }] = await Promise.all([
      import("./core/import"),
      import("./core/library"),
    ]);
    const ids = await importFiles([path]);
    if (ids.length !== 1) return;
    const imported = getItem(ids[0]!);
    if (imported) navigate(itemRoute(imported));
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
