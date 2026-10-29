/**
 * The worker's files: an in-memory volume for what the agent server writes itself, which is
 * the conversation journal (`server/conversation-journal.ts`). The page keeps the volume
 * across workers (`page.ts`) and hands it to each new one, so a reload resumes the
 * conversation from the journal as `curb dev` does from disk. Only the calls the journal
 * makes are here; every other `fs` export stays unavailable (`PARTIAL` in `browser-build.ts`).
 */

import { Buffer } from "buffer/";

type Entry = { bytes: Buffer; ino: number };

const files = new Map<string, Entry>();
let nextIno = 1;
const listeners = new Set<(path: string, change: { append: string } | { text: string }) => void>();

/** What the page handed over: path -> text. Read once, as this module loads. */
const seed = (globalThis as { __CURB_VOLUME__?: Record<string, string> }).__CURB_VOLUME__ ?? {};
for (const [path, text] of Object.entries(seed)) files.set(path, { bytes: Buffer.from(text), ino: nextIno++ });

/** Every write, for the page to keep. */
export function onVolumeChange(listener: (path: string, change: { append: string } | { text: string }) => void): void {
  listeners.add(listener);
}

function noEntry(syscall: string, path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`), { code: "ENOENT", syscall, path });
}

function entry(syscall: string, path: string): Entry {
  const found = files.get(String(path));
  if (!found) throw noEntry(syscall, String(path));
  return found;
}

export function existsSync(path: string): boolean {
  return files.has(String(path));
}

/** Directories exist implicitly: a file's path is its key. */
export function mkdirSync(_path: string, _options?: object): undefined {
  return undefined;
}

export function statSync(path: string, options?: { throwIfNoEntry?: boolean }) {
  const found = files.get(String(path));
  if (!found) {
    if (options?.throwIfNoEntry === false) return undefined;
    throw noEntry("stat", String(path));
  }
  return { size: found.bytes.length, ino: found.ino, isFile: () => true, isDirectory: () => false };
}

export function appendFileSync(path: string, data: string): void {
  const key = String(path);
  const found = files.get(key);
  const bytes = Buffer.from(String(data));
  if (found) found.bytes = Buffer.concat([found.bytes, bytes]);
  else files.set(key, { bytes, ino: nextIno++ });
  for (const listener of listeners) listener(key, { append: String(data) });
}

export function truncateSync(path: string, length = 0): void {
  const found = entry("truncate", path);
  found.bytes = Buffer.from(found.bytes.subarray(0, length));
  for (const listener of listeners) listener(String(path), { text: found.bytes.toString("utf8") });
}

export function readFileSync(path: string, encoding?: string | { encoding?: string }) {
  const bytes = entry("open", path).bytes;
  const named = typeof encoding === "string" ? encoding : encoding?.encoding;
  return named ? bytes.toString(named as "utf8") : Buffer.from(bytes);
}

const descriptors = new Map<number, string>();
let nextFd = 3;

export function openSync(path: string, _flags?: string): number {
  entry("open", path);
  const fd = nextFd++;
  descriptors.set(fd, String(path));
  return fd;
}

export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
  const path = descriptors.get(fd);
  if (path === undefined) throw Object.assign(new Error("EBADF: bad file descriptor, read"), { code: "EBADF" });
  const bytes = entry("read", path).bytes;
  const chunk = bytes.subarray(position, Math.min(bytes.length, position + length));
  buffer.set(chunk, offset);
  return chunk.length;
}

export function closeSync(fd: number): void {
  descriptors.delete(fd);
}
