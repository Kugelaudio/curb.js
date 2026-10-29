/**
 * A session page: the page served at `<sessions prefix><id>` (`/agents/session/<agent>`), one
 * per project a host keeps, which a person can bookmark and open on any computer. The page
 * has no login of its own: without a kept link, or once the platform refuses it, it goes to
 * the host's sign-in page (`<meta name="curb-sign-in">`, `{session}` standing for the session
 * path), which sends the person back here with a fresh link in the fragment (`relay.ts`).
 * Both settings come from the static build (`static-build.ts --sessions --sign-in`); a page
 * served without them, or at another path, is the plain browser dev page.
 */

/** How long after sending the person to sign in a refusal means the sign-in did not help. */
const SIGN_IN_LOOP_MS = 60_000;
const SIGNING_IN_KEY = (session: string) => `curb-browser:signing-in:${session}`;

export type SessionSettings = { prefix: string; signIn: string | null };

/** The build's session settings from the page's meta tags, null when it serves no sessions. */
export function sessionSettings(document: Pick<Document, "querySelector">): SessionSettings | null {
  const prefix = document.querySelector<HTMLMetaElement>('meta[name="curb-sessions"]')?.content;
  if (!prefix) return null;
  return { prefix, signIn: document.querySelector<HTMLMetaElement>('meta[name="curb-sign-in"]')?.content || null };
}

/** The session path `pathname` is in (`/agents/session/<id>`, without what follows), or null. */
export function sessionOf(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const id = pathname.slice(prefix.length).split("/")[0];
  return id ? `${prefix}${id}` : null;
}

/**
 * The sign-in URL for `session`, or null when this page should not go there again: it sent
 * the person less than a minute ago, so the platform refused the link the sign-in gave.
 * Going there is recorded in `storage` (the tab's sessionStorage) until `signedIn`.
 */
export function signInFor(settings: SessionSettings, session: string, storage: Storage, now = Date.now()): string | null {
  if (!settings.signIn) return null;
  const last = Number(storage.getItem(SIGNING_IN_KEY(session)));
  if (last && now - last < SIGN_IN_LOOP_MS) return null;
  storage.setItem(SIGNING_IN_KEY(session), String(now));
  return settings.signIn.replaceAll("{session}", session);
}

/** The platform took this session's link: a later refusal may sign in again at once. */
export function signedIn(session: string, storage: Storage): void {
  storage.removeItem(SIGNING_IN_KEY(session));
}
