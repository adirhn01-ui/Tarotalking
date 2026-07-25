// Tiny navigation indirection so screens can request route changes without
// importing the boot module (avoids circular imports).

import type { SourceType } from "./types";

export type Route =
  | { view: "library" }
  | { view: "reader"; itemId: string }
  | { view: "audiobook"; itemId: string }
  | { view: "activity" }
  | { view: "settings"; section?: string };

type Navigate = (route: Route) => void;

let impl: Navigate = () => {};
let current: Route = { view: "library" };

export function setNavigator(nav: Navigate): void {
  impl = nav;
}

export function navigate(route: Route): void {
  current = route;
  impl(route);
}

export function currentRoute(): Route {
  return current;
}

/** Where opening a library item goes: audiobooks have no text, so they get the
 *  audio player; everything else opens in the reader. Pure. */
export function itemRoute(item: { id: string; sourceType: SourceType }): Route {
  return item.sourceType === "audiobook"
    ? { view: "audiobook", itemId: item.id }
    : { view: "reader", itemId: item.id };
}
