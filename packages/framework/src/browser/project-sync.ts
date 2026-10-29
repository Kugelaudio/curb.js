/**
 * A project opened from a hosting platform's link is the platform's: the platform holds its
 * files, the tab loads them on every connect and saves every change there before applying
 * it, so the project is the same in any browser. The tab's own copy is a working copy.
 *
 * Two kinds of path never leave the tab: `node_modules/` (the tab installs it again from
 * `package-lock.json`) and `.env` files (secrets stay in the browser that was given them).
 *
 * Pure: the page (`page.ts`) and the socket (`relay.ts`) do the IO.
 */

import type { ProjectChange } from "./npm-install.js";

/** A file of the platform's copy as `ready` carries it: text, or a binary file by its size. */
export type PlatformFile = { path: string; text: string } | { path: string; size: number };

/** One file a save sends: text, or bytes as base64. */
export type SavedFile = { path: string; text: string } | { path: string; base64: string };

/** What the tab asks the platform to store: `replace` makes `writes` the whole copy. */
export type ProjectSave = { writes: SavedFile[]; deletes: string[]; replace?: boolean };

/**
 * The project's files the tab holds as bytes the page ships rather than as text (a vendored
 * Curb tarball), by the page asset they come from. A project has one when its package.json
 * depends on it.
 */
export const BINARY_FILES: Readonly<Record<string, string>> = { "vendor/curb.tgz": "/curb-browser/vendor/curb.tgz" };

/** The binary files `files`' package.json depends on. */
export function binaryFilesOf(files: ReadonlyMap<string, string>): Array<[path: string, asset: string]> {
  const packageJson = files.get("package.json") ?? "";
  return Object.entries(BINARY_FILES).filter(([path]) => packageJson.includes(`file:${path}`));
}

function isEnvFile(path: string): boolean {
  const name = path.split("/").at(-1)!;
  return (name === ".env" || name.startsWith(".env.")) && name !== ".env.example";
}

/** A path that stays in this tab: installed packages and secrets. */
export function staysInTab(path: string): boolean {
  return path.startsWith("node_modules/") || path.includes("/node_modules/") || isEnvFile(path);
}

/** The part of a change the platform stores: null when it is all the tab's own. */
export function savedPart(change: ProjectChange): ProjectSave | null {
  const writes = [...change.writes].filter(([path]) => !staysInTab(path)).map(([path, text]) => ({ path, text }));
  const deletes = change.deletes.filter((path) => !staysInTab(path));
  return writes.length === 0 && deletes.length === 0 ? null : { writes, deletes };
}

/**
 * What makes `files` (the working copy) the platform's copy: every path the tab does not keep
 * for itself becomes the platform's text, or goes. Binary files stay out of the working copy
 * (the page ships them). Only what differs is in the change.
 */
export function platformCopyChange(files: ReadonlyMap<string, string>, platform: readonly PlatformFile[]): ProjectChange {
  const incoming = new Map<string, string>();
  for (const file of platform) if ("text" in file && !staysInTab(file.path)) incoming.set(file.path, file.text);
  const change: ProjectChange = { writes: new Map(), deletes: [] };
  for (const path of files.keys()) {
    if (!staysInTab(path) && !incoming.has(path)) change.deletes.push(path);
  }
  for (const [path, text] of incoming) if (files.get(path) !== text) change.writes.set(path, text);
  return change;
}

/** The copy a new project starts as: the template's files and the binary files it depends on. */
export function seedSave(template: Readonly<Record<string, string>>, binaries: ReadonlyArray<[path: string, bytes: Uint8Array]>): ProjectSave {
  const writes: SavedFile[] = Object.entries(template)
    .filter(([path]) => !staysInTab(path))
    .map(([path, text]) => ({ path, text }));
  for (const [path, bytes] of binaries) writes.push({ path, base64: base64(bytes) });
  return { writes, deletes: [], replace: true };
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
