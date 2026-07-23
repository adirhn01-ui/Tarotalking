// Library view — placeholder (replaced by the Library builder).

import "./library.css";

export interface LibraryView {
  dispose(): void | Promise<void>;
}

export function mountLibrary(el: HTMLElement): LibraryView {
  const root = document.createElement("div");
  root.className = "empty-state grow";
  root.textContent = "Tarotalking";
  el.appendChild(root);
  return { dispose: () => root.remove() };
}
