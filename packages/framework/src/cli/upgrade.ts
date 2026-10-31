// `curb upgrade`: repoint the project's "curb" dependency at the newest release
// from wherever the project gets it, and reinstall. A project on
// `npm:curb.js@<version>` reads npm's dist-tags; any other published install
// reads the `latest.json` pointer the CDN keeps next to its tarballs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { curbVersion } from "../version.js";

/** Same convention as create-curb.js: env override, no trailing slash. */
export function cdnBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CURB_CDN ?? "https://cdn.kugelaudio.com/curb").replace(/\/$/, "");
}

/** Same convention for npm, for a project behind a registry mirror. */
export function npmRegistry(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CURB_NPM_REGISTRY ?? "https://registry.npmjs.org").replace(/\/$/, "");
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

/** Projects import "curb"; npm holds it as curb.js, so they depend on it through this alias. */
const NPM_ALIAS = "npm:curb.js";

/** npm alias specs: the project follows npm's dist-tags. */
export function isNpmSpec(spec: string): boolean {
  return spec === NPM_ALIAS || spec.startsWith(`${NPM_ALIAS}@`);
}

/** Semver precedence of two prerelease strings: per dot field, numbers compare as numbers and
 * rank below words, and with every field equal the longer one is higher. */
function comparePrereleases(a: string, b: string): number {
  const fieldsA = a.split(".");
  const fieldsB = b.split(".");
  for (let i = 0; i < Math.min(fieldsA.length, fieldsB.length); i++) {
    const rawA = fieldsA[i]!;
    const rawB = fieldsB[i]!;
    if (rawA === rawB) continue;
    const numericA = /^\d+$/.test(rawA);
    const numericB = /^\d+$/.test(rawB);
    if (numericA && numericB) return Number(rawA) < Number(rawB) ? -1 : 1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return rawA < rawB ? -1 : 1;
  }
  if (fieldsA.length === fieldsB.length) return 0;
  return fieldsA.length < fieldsB.length ? -1 : 1;
}

/**
 * Semver-ish compare: numeric per dot segment, missing segments are 0; a
 * release outranks its own prereleases, which compare by semver precedence;
 * non-numeric core segments fall back to plain string compare. Returns -1 / 0 / 1.
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
  return comparePrereleases(preA, preB);
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

/** The version a dist-tag of curb.js on npm points at. Every failure names the URL and a fix. */
export async function fetchNpmVersion(registry: string, tag: string, timeoutMs = 10_000): Promise<string> {
  const url = `${registry}/-/package/curb.js/dist-tags`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach npm at ${url} (${reason}). Check your network, or set CURB_NPM_REGISTRY to a mirror.`,
    );
  }
  if (!response.ok) throw new Error(`npm returned HTTP ${response.status} for ${url}.`);
  let tags: unknown;
  try {
    tags = await response.json();
  } catch {
    throw new Error(`The npm response at ${url} is not valid JSON.`);
  }
  const version = (tags as Record<string, unknown> | null)?.[tag];
  if (typeof version !== "string" || version === "") {
    throw new Error(`curb.js has no "${tag}" release on npm (${url}).`);
  }
  return version;
}

/** The newest release for a project with this spec, and the spec that installs it. */
async function newestRelease(
  spec: string,
  { preview = false, timeoutMs }: { preview?: boolean; timeoutMs?: number } = {},
): Promise<{ version: string; spec: string }> {
  if (isNpmSpec(spec)) {
    const version = await fetchNpmVersion(npmRegistry(), preview ? "preview" : "latest", timeoutMs);
    return { version, spec: `${NPM_ALIAS}@${version}` };
  }
  const base = cdnBase();
  const latest = await fetchLatest(base, timeoutMs);
  return { version: latest.version, spec: `${base}/${latest.tarball}` };
}

/** The `curb upgrade` command. Throws with an actionable message on failure (the CLI maps that to exit 1). */
export async function runUpgrade(args: string[], cwd = process.cwd()): Promise<void> {
  const checkOnly = args.includes("--check");
  const preview = args.includes("--preview");
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json in ${cwd}. Run \`curb upgrade\` from your project root.`);
  }
  const pkgText = readFileSync(pkgPath, "utf8");
  const spec = curbDepSpec(pkgText);
  if (spec === null) {
    throw new Error(
      `package.json in ${cwd} has no "curb" dependency, so this is not a curb project. Run \`curb upgrade\` from a project created with \`npm create curb.js\`.`,
    );
  }
  if (isFileSpec(spec)) {
    console.log(
      "This project links curb from a repo checkout (file: dependency). Update it with git in the framework repo; `curb upgrade` only manages installs from npm or the CDN.",
    );
    return;
  }

  if (preview && !isNpmSpec(spec)) {
    throw new Error(
      `Previews are published to npm only, and this project installs curb from ${spec}. To move it to npm, run \`npm install curb@npm:curb.js@preview\`.`,
    );
  }

  const latest = await newestRelease(spec, { preview });
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
    console.log(`curb v${current} → v${latest.version} is available. Run \`curb upgrade${preview ? " --preview" : ""}\` to update.`);
    return;
  }

  writeFileSync(pkgPath, rewriteCurbDep(pkgText, latest.spec));
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
    const latest = await newestRelease(spec, { timeoutMs: 3_000 });
    const current = curbVersion();
    if (resolveUpgrade({ current, latest: latest.version }) === "upgrade") {
      console.log(`[curb] update available: v${current} → v${latest.version} — run \`curb upgrade\``);
    }
  })().catch(() => {
    // KEEP-JUSTIFIED: the update notice is best-effort telemetry; it must never break or delay dev.
  });
}
