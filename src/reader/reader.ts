// Reader view — placeholder (replaced by the Reader builder).

import "./reader.css";

export interface ReaderView {
  dispose(): void | Promise<void>;
}

export async function mountReader(el: HTMLElement, _itemId: string): Promise<ReaderView> {
  const root = document.createElement("div");
  root.className = "empty-state grow";
  root.textContent = "Reader";
  el.appendChild(root);
  return { dispose: () => root.remove() };
}
