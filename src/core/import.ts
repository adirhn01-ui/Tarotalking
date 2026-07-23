// Import pipeline: normalize every source (EPUB, txt/md, pasted text, URL)
// into a ContentDoc + LibraryItem.
//
// Contract (frozen — main.ts and views call these):
//   importFiles(paths)        → item ids created (toasts errors itself)
//   importPastedText(title?, text) → item id
//   importUrl(url)            → item id
//   loadDoc(itemId)           → ContentDoc (from the per-item doc.json cache)

import type { ContentDoc } from "./types";

export async function importFiles(_paths: string[]): Promise<string[]> {
  const { toast } = await import("../ui/toast");
  toast.error("Import is not wired up yet");
  return [];
}

export async function importPastedText(_title: string | null, _text: string): Promise<string | null> {
  const { toast } = await import("../ui/toast");
  toast.error("Import is not wired up yet");
  return null;
}

export async function importUrl(_url: string): Promise<string | null> {
  const { toast } = await import("../ui/toast");
  toast.error("Import is not wired up yet");
  return null;
}

export async function loadDoc(_itemId: string): Promise<ContentDoc> {
  throw new Error("not implemented");
}
