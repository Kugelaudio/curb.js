/**
 * Opening an MCP server's sign-in page. A page that frames the preview (the hosted editor shows
 * it on its own origin) names its origin in the preview's URL fragment, `#curb-embedder=<origin>`.
 * The preview then asks that parent first: a parent that answers shows the sign-in itself, with
 * the provider's host, and opens it on the person's own click, so the frame needs no popups. A
 * parent that does not answer, or no named parent, gets the window from here, while the click
 * that asked for it still counts.
 */

/** The page asks its parent to offer a sign-in: `{ type, url }`. */
export const OPEN_SIGN_IN = "curb:open-sign-in";
/** The parent shows it: `{ type, url }`, the same url. */
export const SIGN_IN_SHOWN = "curb:sign-in-shown";
/** The fragment key a framing page names its origin under. */
export const EMBEDDER_FRAGMENT = "curb-embedder";
/** How long the page waits for the parent; well inside a click's activation. */
export const SIGN_IN_ANSWER_MS = 300;

const POPUP_FEATURES = "noopener,width=560,height=720";

type SignInWindow = Pick<Window, "open" | "parent" | "addEventListener" | "removeEventListener" | "setTimeout"> & {
  location: Pick<Location, "hash">;
};

/**
 * The origin the framing page named, or null when the page is not framed or named none (or a
 * value that is not exactly an http(s) origin).
 */
export function embedderOrigin(win: SignInWindow): string | null {
  if (win.parent === (win as unknown)) return null;
  const named = new URLSearchParams(win.location.hash.replace(/^#/, "")).get(EMBEDDER_FRAGMENT);
  if (!named) return null;
  try {
    const url = new URL(named);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === named ? url.origin : null;
  } catch {
    return null;
  }
}

export function openSignIn(url: string, win: SignInWindow = window): void {
  const parentOrigin = embedderOrigin(win);
  if (!parentOrigin) {
    win.open(url, "_blank", POPUP_FEATURES);
    return;
  }
  let shown = false;
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (event.source === win.parent && event.origin === parentOrigin && data?.type === SIGN_IN_SHOWN && data.url === url) {
      shown = true;
    }
  };
  win.addEventListener("message", onMessage);
  win.parent.postMessage({ type: OPEN_SIGN_IN, url }, parentOrigin);
  win.setTimeout(() => {
    win.removeEventListener("message", onMessage);
    if (!shown) win.open(url, "_blank", POPUP_FEATURES);
  }, SIGN_IN_ANSWER_MS);
}
