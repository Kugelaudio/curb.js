import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARCHIVE_LIMITS, ArchiveError, packProject } from "./archive.js";

let root: string;
let scratch: string;

function put(path: string, content: string | Buffer = "x"): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** Lists and extracts with the system tar, so the writer is checked against a real reader. */
function extract(bytes: Buffer): { names: string[]; dir: string } {
  const file = join(scratch, "a.tgz");
  writeFileSync(file, bytes);
  const out = join(scratch, "out");
  mkdirSync(out, { recursive: true });
  const list = spawnSync("tar", ["-tzf", file], { encoding: "utf8" });
  expect(list.status, list.stderr).toBe(0);
  const unpack = spawnSync("tar", ["-xzf", file, "-C", out], { encoding: "utf8" });
  expect(unpack.status, unpack.stderr).toBe(0);
  return { names: list.stdout.trim().split("\n").sort(), dir: out };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "curb-archive-"));
  scratch = mkdtempSync(join(tmpdir(), "curb-archive-out-"));
  put("package.json", '{"name":"my-agent"}');
  put("package-lock.json", "{}");
  put("src/agent/agent.tsx", "export const agent = 1;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("packProject", () => {
  it("packs the source and leaves out deps, VCS, local state, build output and every .env file", () => {
    put("node_modules/react/index.js");
    put("src/nested/node_modules/x.js");
    put(".git/HEAD");
    put(".curb/link.json");
    put(".data/conversations.jsonl");
    put(".mcp-auth/token.json");
    put("dist/index.js");
    put(".env", "ANTHROPIC_API_KEY=sk-secret");
    put(".env.local");
    put("src/.env.production");
    put("env.example", "ANTHROPIC_API_KEY=");
    put("src/dist/kept.ts", "kept");
    put(".DS_Store");

    const archive = packProject(root);
    const { names, dir } = extract(archive.bytes);
    expect(names).toEqual([
      "env.example",
      "package-lock.json",
      "package.json",
      "src/agent/agent.tsx",
      "src/dist/kept.ts",
    ]);
    expect(readFileSync(join(dir, "src/agent/agent.tsx"), "utf8")).toBe("export const agent = 1;\n");
    expect(archive.bytes.includes(Buffer.from("sk-secret"))).toBe(false);
    expect(archive.excluded).toEqual(
      expect.arrayContaining([".env", ".env.local", "src/.env.production", "node_modules", "src/nested/node_modules", "dist", ".git"]),
    );
    expect(archive.files).toBe(5);
  });

  it("digests the exact bytes and is deterministic for an unchanged tree", () => {
    const first = packProject(root);
    const second = packProject(root);
    expect(first.digest).toBe(`sha256:${createHash("sha256").update(first.bytes).digest("hex")}`);
    expect(second.digest).toBe(first.digest);
  });

  it("keeps a path longer than 100 bytes intact", () => {
    const long = `src/${"deep-directory-name/".repeat(6)}${"f".repeat(80)}.ts`;
    const longer = `src/${"a".repeat(120)}/${"b".repeat(120)}.ts`;
    put(long, "long");
    put(longer, "longer");
    const { names, dir } = extract(packProject(root).bytes);
    expect(names).toContain(long);
    expect(names).toContain(longer);
    expect(readFileSync(join(dir, longer), "utf8")).toBe("longer");
  });

  it("keeps a symlink inside the project as a relative link", () => {
    put("src/real.ts", "real");
    symlinkSync(join(root, "src/real.ts"), join(root, "src/alias.ts"));
    const { dir } = extract(packProject(root).bytes);
    expect(readlinkSync(join(dir, "src/alias.ts"))).toBe("real.ts");
  });

  it("refuses a symlink that leaves the project", () => {
    symlinkSync("/etc/hosts", join(root, "hosts"));
    expect(() => packProject(root)).toThrow(/hosts is a symlink to \/etc\/hosts, outside the project/);
    rmSync(join(root, "hosts"));
    symlinkSync("../../outside", join(root, "src/escape"));
    expect(() => packProject(root)).toThrow(ArchiveError);
  });

  it("enforces the upload limits client-side with the file that broke them", () => {
    const limits = { ...ARCHIVE_LIMITS };
    put("big.bin", Buffer.alloc(2048));
    expect(() => packProject(root, { ...limits, fileBytes: 1024 })).toThrow(/big\.bin is 2\.0 KiB; a single file may be at most 1\.0 KiB/);
    expect(() => packProject(root, { ...limits, unpackedBytes: 1024 })).toThrow(/over 1\.0 KiB unpacked \(reached at big\.bin\)/);
    expect(() => packProject(root, { ...limits, files: 2 })).toThrow(/more than 2 files/);
    expect(() => packProject(root, { ...limits, compressedBytes: 10 })).toThrow(/compressed project is .* the upload limit is/);
    put("a/b/c/d.ts");
    expect(() => packProject(root, { ...limits, pathDepth: 3 })).toThrow(/a\/b\/c\/d\.ts is nested 4 levels deep; the upload limit is 3/);
  });

  it("states the published limits", () => {
    expect(ARCHIVE_LIMITS).toEqual({
      compressedBytes: 50 * 1024 * 1024,
      unpackedBytes: 200 * 1024 * 1024,
      files: 10_000,
      fileBytes: 50 * 1024 * 1024,
      pathDepth: 8,
    });
  });

  it("refuses a directory that is not a project root", () => {
    rmSync(join(root, "package.json"));
    expect(() => packProject(root)).toThrow(/has no package\.json/);
  });
});
