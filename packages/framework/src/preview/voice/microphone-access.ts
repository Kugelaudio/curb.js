/**
 * Whether a call can have a microphone here, known before Start call is pressed. A browser built
 * into an app (the Claude app's Browser pane, other Electron apps) blocks the microphone, and a
 * page the person has blocked reports it through the Permissions API. Either way the preview says
 * so up front instead of failing the call.
 */

/** The app whose built-in browser this page runs in, from its user agent, or null for a browser. */
export function embeddedBrowserName(userAgent: string): string | null {
  if (/\bClaude\b/i.test(userAgent)) return "the Claude app";
  if (/\bElectron\//.test(userAgent)) return "this app";
  return null;
}

/** True when the browser already reports the microphone as blocked for this page. */
export async function microphoneDenied(permissions: Permissions | undefined = globalThis.navigator?.permissions): Promise<boolean> {
  if (!permissions?.query) return false;
  try {
    return (await permissions.query({ name: "microphone" as PermissionName })).state === "denied";
  } catch {
    // KEEP-JUSTIFIED: a browser that cannot answer for the microphone (Firefox before 128) has
    // not blocked it; the call then asks as usual.
    return false;
  }
}

/** The warning the composer shows before a call, or null when a call can ask for the microphone. */
export function microphoneWarning({ embedded, denied, pageUrl }: { embedded: string | null; denied: boolean; pageUrl: string }): string | null {
  if (embedded) {
    return `The browser in ${embedded} cannot use your microphone. To call your agent, open ${pageUrl} in Chrome or Safari; typing works here.`;
  }
  if (denied) {
    return `This browser blocked the microphone for this page. Allow it (the icon left of the address bar) to call your agent; typing works without it.`;
  }
  return null;
}
