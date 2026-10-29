import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { treeDigest, collectBundleFiles, MANIFEST_FILENAME, type BundleFile } from "./bundle-digest.js";

/**
 * The canonical form is a CONTRACT with a second implementation: the Go runner verifies a
 * bundle before it reads a byte of it, so it has to reproduce this digest exactly. These
 * tests pin each rule the format states, because a rule nobody tests is a rule the two
 * implementations are free to disagree about.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "curb-digest-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, contents: string, mode = 0o644): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  chmodSync(absolute, mode);
}

const file = (path: string, digest: string, size: number, mode: "755" | "644" = "644"): BundleFile => ({
  path,
  digest: digest as `sha256:${string}`,
  size,
  mode,
});

describe("the canonical bundle digest", () => {
  it("does not depend on the order files are listed in", () => {
    const a = file("a.txt", "sha256:aa", 1);
    const b = file("b/c.txt", "sha256:bb", 2);
    expect(treeDigest([a, b])).toBe(treeDigest([b, a]));
  });

  it("changes when a file's contents change", () => {
    const before = treeDigest([file("a.txt", "sha256:aa", 1)]);
    expect(treeDigest([file("a.txt", "sha256:ab", 1)])).not.toBe(before);
  });

  it("changes when a file moves", () => {
    const before = treeDigest([file("a.txt", "sha256:aa", 1)]);
    expect(treeDigest([file("b.txt", "sha256:aa", 1)])).not.toBe(before);
  });

  it("changes when the executable bit changes", () => {
    // A vendored native prebuild that loses +x is broken. A digest that could not see the
    // difference would call the broken tree identical to the working one.
    const before = treeDigest([file("native/binding.node", "sha256:aa", 1, "644")]);
    expect(treeDigest([file("native/binding.node", "sha256:aa", 1, "755")])).not.toBe(before);
  });

  it("distinguishes one file from two whose names concatenate to it", () => {
    // The separators are load-bearing: without them "ab" + "c" and "a" + "bc" hash alike.
    expect(treeDigest([file("ab", "sha256:11", 1), file("c", "sha256:22", 1)])).not.toBe(
      treeDigest([file("a", "sha256:11", 1), file("bc", "sha256:22", 1)]),
    );
  });

});

describe("collecting a bundle's files", () => {
  it("lists every file with a POSIX path, digest and size, sorted by path bytes", async () => {
    write("entry/worker.mjs", "worker");
    write("assets/context/policy.md", "# policy");
    write("node_modules/dep/index.js", "module.exports = 1;");

    const files = await collectBundleFiles(root);

    expect(files.map((f) => f.path)).toEqual([
      "assets/context/policy.md",
      "entry/worker.mjs",
      "node_modules/dep/index.js",
    ]);
    // sha256("worker")
    expect(files[1]).toMatchObject({
      digest: "sha256:87eba76e7f3164534045ba922e7770fb58bbd14ad732bbf5ba6f11cc56989e6e",
      size: 6,
      mode: "644",
    });
  });

  it("excludes the manifest, which cannot be inside its own digest", async () => {
    write(MANIFEST_FILENAME, "{}");
    write("entry/worker.mjs", "worker");

    const files = await collectBundleFiles(root);
    expect(files.map((f) => f.path)).toEqual(["entry/worker.mjs"]);
  });

  it("keeps a nested file that merely shares the manifest's name", async () => {
    // Only the ROOT manifest is the bundle's own. A dependency shipping a file of that
    // name deeper in the tree is ordinary content and must be digested like any other.
    write(`node_modules/dep/${MANIFEST_FILENAME}`, "{}");

    const files = await collectBundleFiles(root);
    expect(files.map((f) => f.path)).toEqual([`node_modules/dep/${MANIFEST_FILENAME}`]);
  });

  it("records the executable bit and nothing else about the mode", async () => {
    write("entry/worker.mjs", "worker", 0o644);
    write("native/binding.node", "binary", 0o755);
    write("native/other.node", "binary", 0o700);

    const files = await collectBundleFiles(root);
    expect(files.map((f) => [f.path, f.mode])).toEqual([
      ["entry/worker.mjs", "644"],
      ["native/binding.node", "755"],
      ["native/other.node", "755"],
    ]);
  });

  it("ignores mtimes, so the digest does not depend on when files were written", async () => {
    write("entry/worker.mjs", "worker");
    const before = treeDigest(await collectBundleFiles(root));

    utimesSync(join(root, "entry/worker.mjs"), new Date(0), new Date(0));
    expect(treeDigest(await collectBundleFiles(root))).toBe(before);
  });

  it("refuses a symbolic link rather than digesting where it points", async () => {
    write("entry/worker.mjs", "worker");
    symlinkSync(join(root, "entry/worker.mjs"), join(root, "link.mjs"));

    await expect(collectBundleFiles(root)).rejects.toThrow(/symbolic link/);
  });

  it("fails loudly on a file it cannot read, rather than omitting it", async () => {
    write("entry/worker.mjs", "worker");
    write("secret.bin", "nope", 0o000);

    // Root ignores permission bits, so this assertion is only meaningful unprivileged.
    if (process.getuid?.() === 0) return;
    await expect(collectBundleFiles(root)).rejects.toThrow(/cannot digest secret\.bin/);
  });
});
