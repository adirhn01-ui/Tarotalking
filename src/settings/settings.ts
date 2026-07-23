// Settings view — placeholder (replaced by the Settings builder).

import "./settings.css";

export interface SettingsView {
  dispose(): void | Promise<void>;
}

export function mountSettings(el: HTMLElement, _section?: string): SettingsView {
  const root = document.createElement("div");
  root.className = "empty-state grow";
  root.textContent = "Settings";
  el.appendChild(root);
  return { dispose: () => root.remove() };
}
