import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { npmRestore } from "./npm-install.js";
import { binaryFilesOf, platformCopyChange, savedPart, seedSave, staysInTab } from "./project-sync.js";

afterEach(() => vi.unstubAllGlobals());

describe("what the platform holds", () => {
  it("keeps installed packages and secrets in the tab", () => {
    expect(staysInTab("node_modules/ms/index.js")).toBe(true);
    expect(staysInTab("packages/a/node_modules/x.js")).toBe(true);
    expect(staysInTab(".env")).toBe(true);
    expect(staysInTab("src/.env.local")).toBe(true);
    expect(staysInTab(".env.example")).toBe(false);
    expect(staysInTab("src/agent/agent.tsx")).toBe(false);
  });

  it("saves only the platform's part of a change", () => {
    const change = {
      writes: new Map([
        ["package.json", "{}"],
        ["node_modules/ms/index.js", "x"],
        [".env", "A=1"],
      ]),
      deletes: ["src/old.ts", "node_modules/old/index.js"],
    };
    expect(savedPart(change)).toEqual({ writes: [{ path: "package.json", text: "{}" }], deletes: ["src/old.ts"] });
    expect(savedPart({ writes: new Map([[".env", "A=1"]]), deletes: [] })).toBeNull();
  });

  it("makes the working copy the platform's, keeping what stays in the tab", () => {
    const working = new Map([
      ["src/agent/agent.tsx", "old"],
      ["src/agent/gone.ts", "x"],
      ["README.md", "same"],
      ["node_modules/ms/index.js", "kept"],
      [".env", "A=1"],
    ]);
    const change = platformCopyChange(working, [
      { path: "src/agent/agent.tsx", text: "new" },
      { path: "README.md", text: "same" },
      { path: "context/a.md", text: "a" },
      { path: "vendor/curb.tgz", size: 3 },
    ]);
    expect([...change.writes]).toEqual([
      ["src/agent/agent.tsx", "new"],
      ["context/a.md", "a"],
    ]);
    expect(change.deletes).toEqual(["src/agent/gone.ts"]);
  });

  it("seeds a new copy with the template and the binary files it depends on", () => {
    const template = { "package.json": '{"dependencies":{"curb":"file:vendor/curb.tgz"}}', "src/agent/agent.tsx": "x" };
    expect(binaryFilesOf(new Map(Object.entries(template)))).toEqual([["vendor/curb.tgz", "/curb-browser/vendor/curb.tgz"]]);
    expect(seedSave(template, [["vendor/curb.tgz", new Uint8Array([1, 2, 3])]])).toEqual({
      writes: [
        { path: "package.json", text: template["package.json"] },
        { path: "src/agent/agent.tsx", text: "x" },
        { path: "vendor/curb.tgz", base64: "AQID" },
      ],
      deletes: [],
      replace: true,
    });
  });
});

/** A one-file npm tarball (`package/<name>`), gzipped. */
function tarball(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

describe("installing a loaded project's packages", () => {
  it("installs what the lockfile reaches from package.json and removes what nothing reaches", async () => {
    const ms = tarball({ "package.json": '{"name":"ms","version":"2.1.3"}', "index.js": "module.exports = 1;" });
    const integrity = `sha512-${createHash("sha512").update(ms).digest("base64")}`;
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return new Response(new Uint8Array(ms));
    });
    const files = new Map([
      ["package.json", JSON.stringify({ dependencies: { curb: "file:vendor/curb.tgz", ms: "^2.1.3" } })],
      [
        "package-lock.json",
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { curb: "file:vendor/curb.tgz", ms: "^2.1.3" } },
            "node_modules/curb": { version: "0.1.0", resolved: "file:vendor/curb.tgz", dependencies: { livekit: "^1" } },
            "node_modules/livekit": { version: "1.0.0", resolved: "https://registry.npmjs.org/livekit/-/livekit-1.0.0.tgz" },
            "node_modules/ms": { version: "2.1.3", resolved: "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz", integrity },
          },
        }),
      ],
      ["node_modules/left-pad/package.json", '{"version":"1.0.0"}'],
      ["node_modules/left-pad/index.js", ""],
    ]);
    const change = await npmRestore(files, () => {});
    expect(fetched).toEqual(["https://registry.npmjs.org/ms/-/ms-2.1.3.tgz"]);
    expect([...change.writes.keys()].sort()).toEqual(["node_modules/ms/index.js", "node_modules/ms/package.json"]);
    expect(change.deletes.sort()).toEqual(["node_modules/left-pad/index.js", "node_modules/left-pad/package.json"]);

    // Installed at the lockfile's version: nothing to do the second time.
    for (const [path, text] of change.writes) files.set(path, text);
    for (const path of change.deletes) files.delete(path);
    const again = await npmRestore(files, () => {});
    expect(again.writes.size + again.deletes.length).toBe(0);
  });
});
