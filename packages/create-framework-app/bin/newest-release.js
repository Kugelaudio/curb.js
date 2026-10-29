// Which create-curb-app release creates the project. npx keeps a tarball URL it ran once and
// never downloads it again, so on a machine that ran the quickstart before, the copy that
// starts can be an old release. The CDN's latest.json names the newest one; the run is
// handed to it when it is newer than this copy.

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Whether release `candidate` is newer than release `current`, field by field ("1.10.0" is
 * newer than "1.9.9"). Anything that is not a plain X.Y.Z release is never newer.
 */
export function isNewerRelease(candidate, current) {
  const a = RELEASE.exec(candidate);
  const b = RELEASE.exec(current);
  if (!a || !b) return false;
  for (let field = 1; field <= 3; field += 1) {
    const difference = Number(a[field]) - Number(b[field]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/**
 * The release to hand this run to: `{ version, url }` when `<cdn>/latest.json` names a
 * create-curb-app newer than `ownVersion`, null when this copy is the newest. Throws when the
 * pointer cannot be read or names no create-curb-app release, so the caller can say why.
 */
export async function newerRelease(cdn, ownVersion, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const pointer = `${cdn}/latest.json`;
  const response = await fetchImpl(pointer, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${pointer} answered HTTP ${response.status}`);
  const latest = await response.json();
  const { version, tarball } = latest?.createApp ?? {};
  if (typeof version !== "string" || typeof tarball !== "string") {
    throw new Error(`${pointer} names no create-curb-app release`);
  }
  return isNewerRelease(version, ownVersion) ? { version, url: `${cdn}/${tarball}` } : null;
}
