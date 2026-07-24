// Tiny navigation indirection so screens can request route changes without
// importing the boot module (avoids circular imports).

export type Route =
  | { view: "library" }
  | { view: "reader"; itemId: string }
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
