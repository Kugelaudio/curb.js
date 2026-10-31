// `curb upgrade`: repoint the project's "curb" dependency at the latest CDN
// tarball and reinstall. The CDN publishes a `latest.json` pointer next to the
// tarballs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { curbVersion } from "../version.js";

/** Same convention as create-curb-app: env override, no trailing slash. */
export function cdnBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CURB_CDN ?? "https://cdn.kugelaudio.com/curb").replace(/\/$/, "");
}

/** The project's "curb" dependency spec; `null` means there is none. */
export function curbDepSpec(pkgJsonText: string): string | null {
  const pkg = JSON.parse(pkgJsonText) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return pkg.dependencies?.curb ?? pkg.devDependencies?.curb ?? null;
}

/** file: specs are repo-linked checkouts (symlinked package), updated via git. */
export function isFileSpec(spec: string): boolean {
  return spec.startsWith("file:");
}

/**
 * Semver-ish compare: numeric per dot segment, missing segments are 0; a
 * release outranks its own prereleases; two prereleases (or non-numeric
 * segments) fall back to plain string compare. Returns -1 / 0 / 1.
 */
export function compareVersions(a: string, b: string): number {
  const splitOnce = (v: string): [string, string] => {
    const at = v.indexOf("-");
    return at === -1 ? [v, ""] : [v.slice(0, at), v.slice(at + 1)];
  };
  const [coreA, preA] = splitOnce(a.trim());
  const [coreB, preB] = splitOnce(b.trim());
  const partsA = coreA.split(".");
  const partsB = coreB.split(".");
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const rawA = partsA[i] ?? "0";
    const rawB = partsB[i] ?? "0";
    const numA = Number(rawA);
    const numB = Number(rawB);
    if (Number.isNaN(numA) || Number.isNaN(numB)) {
      if (rawA !== rawB) return rawA < rawB ? -1 : 1;
      continue;
    }
    if (numA !== numB) return numA < numB ? -1 : 1;
  }
  if (preA === preB) return 0;
  if (preA === "") return 1;
  if (preB === "") return -1;
  return preA < preB ? -1 : 1;
}

export type UpgradeDecision = "up-to-date" | "upgrade" | "ahead";

/** Pure decision: "ahead" means the installed version is NEWER than the published latest (never downgrade). */
export function resolveUpgrade({ current, latest }: { current: string; latest: string }): UpgradeDecision {
  const order = compareVersions(current, latest);
  if (order === 0) return "up-to-date";
  return order > 0 ? "ahead" : "upgrade";
}

/**
 * Rewrite the "curb" dependency to `spec`, preserving every other entry and
 * key order, and re-serialize the way the scaffolder writes package.json
 * (2-space indent, trailing newline). Throws when there is no curb dep.
 */
export function rewriteCurbDep(pkgJsonText: string, spec: string): string {
  const pkg = JSON.parse(pkgJsonText) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps =
    pkg.dependencies?.curb !== undefined
      ? pkg.dependencies
      : pkg.devDependencies?.curb !== undefined
        ? pkg.devDependencies
        : null;
  if (!deps) throw new Error('package.json has no "curb" dependency to rewrite.');
  deps.curb = spec;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

interface LatestManifest {
  version: string;
  tarball: string;
}

/** Fetch and validate `<cdn>/latest.json`. Every failure names the URL and a fix. */
export async function fetchLatest(base: string, timeoutMs = 10_000): Promise<LatestManifest> {
  const url = `${base}/latest.json`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach the curb CDN at ${url} (${reason}). Check your network, or set CURB_CDN to a mirror.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `The curb CDN returned HTTP ${response.status} for ${url}. If this persists, the latest-version pointer may not be published yet.`,
    );
  }
  let manifest: unknown;
  try {
    manifest = await response.json();
  } catch {
    throw new Error(`The curb CDN response at ${url} is not valid JSON.`);
  }
  const { version, tarball } = (manifest ?? {}) as Partial<LatestManifest>;
  if (typeof version !== "string" || version === "" || typeof tarball !== "string" || tarball === "") {
    throw new Error(
      `Unexpected latest.json shape at ${url}: expected { "version": "…", "tarball": "…" }.`,
    );
  }
  return { version, tarball };
}

/** The `curb upgrade` command. Throws with an actionable message on failure (the CLI maps that to exit 1). */
export async function runUpgrade(args: string[], cwd = process.cwd()): Promise<void> {
  const checkOnly = args.includes("--check");
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json in ${cwd}. Run \`curb upgrade\` from your project root.`);
  }
  const pkgText = readFileSync(pkgPath, "utf8");
  const spec = curbDepSpec(pkgText);
  if (spec === null) {
    throw new Error(
      `package.json in ${cwd} has no "curb" dependency, so this is not a curb project. Run \`curb upgrade\` from a project created with create-curb-app.`,
    );
  }
  if (isFileSpec(spec)) {
    console.log(
      "This project links curb from a repo checkout (file: dependency). Update it with git in the framework repo; `curb upgrade` only manages CDN tarball installs.",
    );
    return;
  }

  const base = cdnBase();
  const latest = await fetchLatest(base);
  const current = curbVersion();
  const decision = resolveUpgrade({ current, latest: latest.version });
  if (decision === "up-to-date") {
    console.log(`curb v${current} is up to date.`);
    return;
  }
  if (decision === "ahead") {
    console.log(
      `Installed curb v${current} is newer than the latest published v${latest.version}; nothing to do.`,
    );
    return;
  }
  if (checkOnly) {
    console.log(`curb v${current} → v${latest.version} is available. Run \`curb upgrade\` to update.`);
    return;
  }

  writeFileSync(pkgPath, rewriteCurbDep(pkgText, `${base}/${latest.tarball}`));
  // Through the shell: npm is a .cmd shim on Windows, which Node starts no other way.
  const install = spawnSync("npm install", { cwd, stdio: "inherit", shell: true });
  if (install.error || install.status !== 0) {
    writeFileSync(pkgPath, pkgText);
    const cause = install.error ? install.error.message : `exit code ${install.status ?? "signal"}`;
    throw new Error(
      `npm install failed (${cause}); package.json was restored to v${current}. Fix the npm error above and re-run \`curb upgrade\`.`,
    );
  }
  console.log(
    `curb updated: v${current} → v${latest.version}. The agent docs in node_modules/curb/docs/agent-guide/ were updated with it.`,
  );
}

/**
 * Passive update notice for `curb dev`: fire-and-forget, never awaited by the
 * boot path. Prints one line when a newer version is published; stays silent
 * for repo-linked (file:) projects and on any failure.
 */
export function notifyIfUpdateAvailable(projectRoot: string): void {
  (async () => {
    const spec = curbDepSpec(readFileSync(join(projectRoot, "package.json"), "utf8"));
    if (spec === null || isFileSpec(spec)) return;
    const latest = await fetchLatest(cdnBase(), 3_000);
    const current = curbVersion();
    if (resolveUpgrade({ current, latest: latest.version }) === "upgrade") {
      console.log(`[curb] update available: v${current} → v${latest.version} — run \`curb upgrade\``);
    }
  })().catch(() => {
    // KEEP-JUSTIFIED: the update notice is best-effort telemetry; it must never break or delay dev.
  });
}
