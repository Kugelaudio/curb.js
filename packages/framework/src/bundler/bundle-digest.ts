import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** The manifest file at a bundle root. Excluded from `files[]` and from the digest. */
export const MANIFEST_FILENAME = "curb.bundle.json";

/**
 * Domain separator and version of the canonical stream defined in this file.
 *
 * It is the FIRST line of the digested bytes, so a future format cannot be mistaken for
 * this one by an implementation that only knows the other: two streams that differ only
 * in a rule neither side stated would hash differently with no way to say why.
 */
export const BUNDLE_DIGEST_FORMAT = "CURB-BUNDLE-DIGEST-V1";

/** One file in the bundle, as `manifest.files[]` carries it plus the mode the digest sees. */
export type BundleFile = {
  /** Bundle-root-relative POSIX path, no `./` prefix. */
  path: string;
  digest: `sha256:${string}`;
  size: number;
  /**
   * "755" when the owner-execute bit is set, "644" otherwise.
   *
   * Part of the digested bytes and reported here so a verifier can see what was hashed
   * without re-stat-ing the tree.
   */
  mode: "755" | "644";
};

/**
 * The canonical byte stream a bundle's digest is taken over.
 *
 * Written out in full because a second implementation -- a host that verifies a bundle
 * before it reads a byte of it -- has to reproduce it exactly. A digest two implementations compute differently is worse than no digest:
 * it fails verification on a correct bundle and blames storage for it.
 *
 * ```text
 *   header := "CURB-BUNDLE-DIGEST-V1" LF
 *   count  := decimal(number of entries) LF
 *   entry  := path NUL mode NUL decimal(size) NUL sha256-hex LF
 *   stream := header count entry*
 * ```
 *
 * and `treeDigest = "sha256:" + hex(sha256(stream))`.
 *
 * `sha256-hex` is the lowercase hex digest of the file's CONTENTS, without the `sha256:`
 * prefix `manifest.files[].digest` carries. `count` is present so a truncated stream
 * cannot hash to a valid shorter bundle.
 *
 * The rules that make it canonical, each one a thing that would otherwise differ between
 * two builds of the same revision or between two implementations:
 *
 *   - `path` is bundle-root-relative, POSIX-separated (`/`), with no `./` prefix, no
 *     leading and no trailing slash. Its bytes are UTF-8, exactly as the filesystem
 *     reported the name; no case folding and no Unicode normalization is applied,
 *     because the name that resolves at runtime is the name on disk.
 *   - entries are sorted ASCENDING by the UTF-8 BYTES of `path`. That is Go's
 *     `sort.Strings` / `bytes.Compare`, and it is deliberately NOT JavaScript's default
 *     `Array.prototype.sort`, which orders UTF-16 code units and disagrees with byte
 *     order above the BMP. See {@link compareBytes}.
 *   - `curb.bundle.json` at the bundle root is EXCLUDED. It carries the digest, so it
 *     cannot be inside it.
 *   - directories are not entries, so an empty directory is invisible to the digest.
 *     Nothing in a bundle depends on one existing; a runner recreates the tree from the
 *     files.
 *   - `mode` is "755" when the owner-execute bit is set and "644" otherwise. Nothing
 *     else about `st_mode` is recorded: owner, group, setuid and sticky bits are host
 *     facts, while the execute bit is the one thing a vendored native prebuild's
 *     runnability actually depends on.
 *   - mtime, atime, ctime, size-on-disk, uid, gid, inode and device are NOT recorded.
 *     Nothing inside the digested bytes may depend on when or
 *     where a file was written.
 *   - symbolic links are a BUILD ERROR rather than an entry. `curb build` dereferences
 *     on copy, so a link in a finished bundle means something was placed by a path this
 *     digest cannot describe; hashing the link target's name would make the digest a
 *     function of the build machine's layout. See {@link collectBundleFiles}.
 */
function canonicalStream(files: readonly BundleFile[]): Buffer {
  const parts: Buffer[] = [
    Buffer.from(`${BUNDLE_DIGEST_FORMAT}\n`, "utf8"),
    Buffer.from(`${files.length}\n`, "utf8"),
  ];
  for (const file of files) {
    parts.push(
      Buffer.from(
        `${file.path}\0${file.mode}\0${file.size}\0${file.digest.slice("sha256:".length)}\n`,
        "utf8",
      ),
    );
  }
  return Buffer.concat(parts);
}

/**
 * Byte-wise comparison of two paths, the ordering Go's `sort.Strings` produces.
 *
 * JavaScript's default sort compares UTF-16 code units, so a path containing an astral
 * character (an emoji in a fixture name is enough) sorts before a BMP character above
 * U+E000 there and after it in UTF-8. Two implementations that disagree about ORDER
 * produce different digests for identical bytes.
 */
export function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * The digest of a bundle, given its complete file list.
 *
 * Pure: it sorts its input rather than trusting the caller's order, so the digest cannot
 * depend on the order the tree happened to be walked in.
 */
export function treeDigest(files: readonly BundleFile[]): `sha256:${string}` {
  const sorted = [...files].sort((left, right) => compareBytes(left.path, right.path));
  return `sha256:${createHash("sha256").update(canonicalStream(sorted)).digest("hex")}`;
}

/**
 * Every file in the bundle except its manifest, digested and sized.
 *
 * `manifest.files`. A file that cannot be read or stat-ed FAILS the build, naming the
 * path: a manifest that under-reports its own contents is exactly the failure the digest
 * exists to prevent -- the runner would verify a set
 * that does not include the file that is wrong.
 */
export async function collectBundleFiles(outDir: string): Promise<BundleFile[]> {
  const files: BundleFile[] = [];

  async function walk(directory: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        `curb build: cannot read ${directory} while listing the bundle's files: ` +
          `${error instanceof Error ? error.message : String(error)}\n` +
          `  The manifest must list every file in the bundle, so a directory it cannot ` +
          `read is a build failure rather than an omission.`,
      );
    }

    for (const entry of entries) {
      const path = `${prefix}${entry.name}`;
      const absolute = join(directory, entry.name);

      if (entry.isSymbolicLink()) {
        throw new Error(
          `curb build: ${path} is a symbolic link.\n` +
            `  A bundle is copied with dereference: true, so a link in the finished tree ` +
            `means a file was placed by a path the manifest cannot describe. Digesting the ` +
            `link would make the bundle's identity a function of this machine's layout.`,
        );
      }
      if (entry.isDirectory()) {
        await walk(absolute, `${path}/`);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `curb build: ${path} is neither a regular file nor a directory.\n` +
            `  Sockets, FIFOs and devices have no content to digest and cannot be shipped ` +
            `in an artifact; remove it from the bundle or from the tree it was copied from.`,
        );
      }
      // The manifest cannot be inside its own digest. Only at the ROOT: a dependency that
      // happens to ship a file of that name deeper in the tree is ordinary content.
      if (path === MANIFEST_FILENAME) continue;

      let contents: Buffer;
      let mode: number;
      try {
        contents = await readFile(absolute);
        mode = (await stat(absolute)).mode;
      } catch (error) {
        throw new Error(
          `curb build: cannot digest ${path}: ` +
            `${error instanceof Error ? error.message : String(error)}\n` +
            `  Every file in a bundle is listed in its manifest with a digest. A file this ` +
            `build cannot read must fail the build, never be silently left out of the list.`,
        );
      }

      files.push({
        path,
        digest: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
        size: contents.byteLength,
        // 0o100 is the owner-execute bit. See the mode rule in canonicalStream.
        mode: (mode & 0o100) !== 0 ? "755" : "644",
      });
    }
  }

  await walk(outDir, "");
  return files.sort((left, right) => compareBytes(left.path, right.path));
}
