import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * Packs a project's source into the tar.gz `curb deploy` uploads.
 *
 * Hand-written ustar rather than a dependency: the format is a 512-byte header per entry,
 * and the framework stays free of a tar package for this one writer. The output is
 * deterministic (sorted entries, zero mtime/uid/gid), so packing an unchanged tree twice
 * gives the same digest.
 *
 * The C4 limits are enforced HERE as well as on the server, so a too-large project fails
 * in a second with the file that broke it rather than after an upload.
 */

const MIB = 1024 * 1024;

export const ARCHIVE_LIMITS = {
  compressedBytes: 50 * MIB,
  unpackedBytes: 200 * MIB,
  files: 10_000,
  fileBytes: 50 * MIB,
  pathDepth: 8,
} as const;

export type ArchiveLimits = { [K in keyof typeof ARCHIVE_LIMITS]: number };

/** Directory names never packed, at any depth: installed deps, VCS, curb's local state, run data, secrets. */
const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".curb", ".data", ".mcp-auth"]);
/** Excluded only at the project root: build output the hosted builder makes itself. */
const EXCLUDED_ROOT_DIRS = new Set(["dist"]);
const EXCLUDED_FILES = new Set([".DS_Store"]);

/** `.env`, `.env.local`, `.env.production`, ...: secrets, which go through `curb secrets push`. */
function isEnvFile(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

interface Entry {
  path: string;
  kind: "file" | "symlink";
  mode: number;
  /** File bytes; empty for a symlink. */
  data: Buffer;
  linkTarget?: string;
}

export interface PackedArchive {
  bytes: Buffer;
  /** `sha256:<hex>` over `bytes`. */
  digest: string;
  files: number;
  unpackedBytes: number;
  /** Relative paths left out by the exclusion rules (an excluded directory is one entry). */
  excluded: string[];
}

export function packProject(root: string, limits: ArchiveLimits = ARCHIVE_LIMITS): PackedArchive {
  const absoluteRoot = realpathSync(resolve(root));
  if (!statSync(join(absoluteRoot, "package.json"), { throwIfNoEntry: false })?.isFile()) {
    throw new ArchiveError(`${absoluteRoot} has no package.json. Run \`curb deploy\` from the project root.`);
  }
  const entries: Entry[] = [];
  const excluded: string[] = [];
  let unpackedBytes = 0;

  const walk = (dir: string, depth: number) => {
    const names = readdirSync(dir).sort();
    for (const name of names) {
      const absolute = join(dir, name);
      const path = relative(absoluteRoot, absolute).split(sep).join("/");
      const stats = lstatSync(absolute);
      const atRoot = dir === absoluteRoot;
      if (
        (stats.isDirectory() && (EXCLUDED_DIRS.has(name) || (atRoot && EXCLUDED_ROOT_DIRS.has(name)))) ||
        EXCLUDED_FILES.has(name) ||
        isEnvFile(name)
      ) {
        excluded.push(path);
        continue;
      }
      if (depth + 1 > limits.pathDepth) {
        throw new ArchiveError(`${path} is nested ${depth + 1} levels deep; the upload limit is ${limits.pathDepth}.`);
      }
      if (stats.isSymbolicLink()) {
        entries.push(symlinkEntry(absoluteRoot, absolute, path));
      } else if (stats.isDirectory()) {
        walk(absolute, depth + 1);
        continue;
      } else if (stats.isFile()) {
        if (stats.size > limits.fileBytes) {
          throw new ArchiveError(
            `${path} is ${formatBytes(stats.size)}; a single file may be at most ${formatBytes(limits.fileBytes)}. ` +
              "Move it out of the project or add it at runtime.",
          );
        }
        unpackedBytes += stats.size;
        if (unpackedBytes > limits.unpackedBytes) {
          throw new ArchiveError(
            `The project is over ${formatBytes(limits.unpackedBytes)} unpacked (reached at ${path}). ` +
              "Remove large files (recordings, datasets, build output) from the project directory.",
          );
        }
        entries.push({
          path,
          kind: "file",
          // Only the executable bit is meaningful to the builder.
          mode: stats.mode & 0o111 ? 0o755 : 0o644,
          data: readFileSync(absolute),
        });
      } else {
        throw new ArchiveError(`${path} is not a regular file, directory or symlink (a socket or device?). Remove it.`);
      }
      if (entries.length > limits.files) {
        throw new ArchiveError(`The project has more than ${limits.files} files. Remove generated files from the project directory.`);
      }
    }
  };
  walk(absoluteRoot, 0);

  const tar = Buffer.concat([...entries.flatMap(tarEntry), Buffer.alloc(1024)]);
  const bytes = gzipSync(tar, { level: 9 });
  if (bytes.length > limits.compressedBytes) {
    throw new ArchiveError(
      `The compressed project is ${formatBytes(bytes.length)}; the upload limit is ${formatBytes(limits.compressedBytes)}. ` +
        "Remove large files from the project directory.",
    );
  }
  return {
    bytes,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    files: entries.length,
    unpackedBytes,
    excluded,
  };
}

/** A symlink is kept as a link, and only when it stays inside the project. */
function symlinkEntry(root: string, absolute: string, path: string): Entry {
  const target = readlinkSync(absolute);
  const lexical = resolve(join(absolute, ".."), target);
  // Compared as a real path, like the root: on macOS /var is /private/var, and an absolute
  // link written through the alias is still inside the project.
  const resolved = existsSync(lexical) ? realpathSync(lexical) : lexical;
  const inside = resolved === root || resolved.startsWith(root + sep);
  if (!inside) {
    throw new ArchiveError(`${path} is a symlink to ${target}, outside the project. Copy the file in or remove the link.`);
  }
  // An absolute link inside the project is rewritten relative, so it survives unpacking elsewhere.
  const linkTarget = isAbsolute(target) ? relative(join(absolute, ".."), resolved).split(sep).join("/") : target.split(sep).join("/");
  return { path, kind: "symlink", mode: 0o777, data: Buffer.alloc(0), linkTarget };
}

export function formatBytes(bytes: number): string {
  return bytes >= MIB ? `${(bytes / MIB).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
}

// ---------------------------------------------------------------------------
// ustar writer
// ---------------------------------------------------------------------------

function tarEntry(entry: Entry): Buffer[] {
  const blocks: Buffer[] = [];
  const split = splitUstarPath(entry.path);
  const longLink = entry.linkTarget !== undefined && Buffer.byteLength(entry.linkTarget) > 100;
  if (!split || longLink) {
    // PAX extended header for a path (or link) that does not fit the ustar fields.
    const records = [paxRecord("path", entry.path)];
    if (longLink) records.push(paxRecord("linkpath", entry.linkTarget as string));
    const pax = Buffer.from(records.join(""), "utf8");
    blocks.push(header({ name: "PaxHeader", prefix: "", mode: 0o644, size: pax.length, type: "x" }), pad(pax));
  }
  const { name, prefix } = split ?? { name: entry.path.slice(-100), prefix: "" };
  blocks.push(
    header({
      name,
      prefix,
      mode: entry.mode,
      size: entry.data.length,
      type: entry.kind === "symlink" ? "2" : "0",
      linkName: entry.linkTarget && !longLink ? entry.linkTarget : "",
    }),
  );
  if (entry.data.length > 0) blocks.push(pad(entry.data));
  return blocks;
}

/** A PAX record is `<len> <key>=<value>\n`, where len counts the whole record including itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}

/** Splits a path into the ustar name (<=100 bytes) and prefix (<=155 bytes), or null when it cannot. */
function splitUstarPath(path: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.indexOf("/"); index >= 0; index = path.indexOf("/", index + 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name.length > 0) return { name, prefix };
  }
  return null;
}

function header(fields: { name: string; prefix: string; mode: number; size: number; type: string; linkName?: string }): Buffer {
  const block = Buffer.alloc(512);
  const write = (value: string, offset: number, length: number) => block.write(value, offset, length, "utf8");
  const octal = (value: number, offset: number, length: number) =>
    write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
  write(fields.name, 0, 100);
  octal(fields.mode, 100, 8);
  octal(0, 108, 8); // uid
  octal(0, 116, 8); // gid
  octal(fields.size, 124, 12);
  octal(0, 136, 12); // mtime: zero, so the digest depends on content only
  write("        ", 148, 8); // checksum placeholder (spaces) while summing
  write(fields.type, 156, 1);
  write(fields.linkName ?? "", 157, 100);
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  write(fields.prefix, 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

function pad(data: Buffer): Buffer {
  const remainder = data.length % 512;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - remainder)]);
}
