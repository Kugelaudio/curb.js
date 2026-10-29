import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";
import { mergeFramesPlugin, patchMergeFrames } from "./merge-frames-plugin.js";

/**
 * The patch is only worth having if it still applies to the `@livekit/agents` Curb ships
 * with, and only safe if the rewritten function returns exactly what upstream returns.
 * Both are checked against the installed package, not a copy: a dependency bump that
 * changes the function fails here before any project's build quietly loses the patch.
 */
const agentsDist = dirname(createRequire(import.meta.url).resolve("@livekit/agents"));
const installed = (file: string) => readFileSync(join(agentsDist, file), "utf8");

class StubFrame {
  constructor(
    public data: Int16Array,
    public sampleRate: number,
    public channels: number,
    public samplesPerChannel: number,
  ) {}
}

/**
 * Pulls `mergeFrames` out of a utils source into a module of its own, beside a global stub
 * AudioFrame, and imports it. The function body is the installed package's, unmodified.
 */
const modules = mkdtempSync(join(tmpdir(), "curb-merge-frames-"));
let loaded = 0;
async function load(source: string): Promise<(buffer: unknown) => StubFrame> {
  const start = source.indexOf("const mergeFrames = (buffer) => {");
  const end = source.indexOf("\n};", start) + 3;
  const file = join(modules, `merge-frames-${loaded++}.mjs`);
  writeFileSync(file, `const AudioFrame = globalThis.__curbStubFrame;\n${source.slice(start, end)}\nexport { mergeFrames };\n`);
  (globalThis as { __curbStubFrame?: unknown }).__curbStubFrame = StubFrame;
  return ((await import(pathToFileURL(file).href)) as { mergeFrames: (buffer: unknown) => StubFrame }).mergeFrames;
}

const frame = (length: number, seed: number) =>
  new StubFrame(Int16Array.from({ length }, (_, i) => ((i * 7919 + seed * 104729) % 65536) - 32768), 16000, 1, length);

describe("mergeFrames patch", () => {
  it.each(["utils.js", "utils.cjs"])("applies to the installed @livekit/agents dist/%s", (file) => {
    const patched = patchMergeFrames(installed(file));
    expect(patched).not.toBeNull();
    expect(patched).not.toContain("[...data, ...frame.data]");
  });

  it("returns the same frame as upstream for every buffer shape", async () => {
    const source = installed("utils.js");
    const slow = await load(source);
    const fast = await load(patchMergeFrames(source)!);
    const buffers = [
      [frame(160, 1)],
      [frame(160, 1), frame(160, 2), frame(160, 3), frame(160, 4)],
      [frame(352, 5), frame(160, 6), frame(1, 7), frame(512, 8)],
      Array.from({ length: 300 }, (_, i) => frame(160, i)),
    ];
    for (const buffer of buffers) {
      const a = slow(buffer);
      const b = fast(buffer);
      expect(b.data).toEqual(a.data);
      expect([b.sampleRate, b.channels, b.samplesPerChannel]).toEqual([a.sampleRate, a.channels, a.samplesPerChannel]);
    }
    const single = frame(10, 9);
    expect(fast(single)).toBe(single);
    expect(() => fast([])).toThrow("buffer is empty");
    expect(() => fast([frame(4, 1), new StubFrame(new Int16Array(4), 24000, 1, 4)])).toThrow("sample rate mismatch");
  });

  it("leaves a source alone when the slow form is not there", () => {
    expect(patchMergeFrames("export const x = 1;\n")).toBeNull();
    const fixed = patchMergeFrames(installed("utils.js"))!;
    expect(patchMergeFrames(fixed)).toBeNull();
  });

  it("rewrites the module esbuild bundles, and warns instead when it cannot", async () => {
    const build = (contents: string, resolveDir: string) =>
      esbuild.build({
        stdin: { contents, resolveDir, loader: "js" },
        bundle: true,
        write: false,
        format: "esm",
        platform: "node",
        packages: "external",
        logLevel: "silent",
        plugins: [mergeFramesPlugin()],
      });
    const result = await build(`export { mergeFrames } from "./utils.js";`, agentsDist);
    expect(result.outputFiles[0].text).toContain("data.set(frame.data, offset)");
    expect(result.warnings).toEqual([]);

    const changed = join(mkdtempSync(join(tmpdir(), "curb-merge-frames-")), "node_modules/@livekit/agents/dist");
    mkdirSync(changed, { recursive: true });
    writeFileSync(join(changed, "utils.js"), "export const mergeFrames = (buffer) => buffer;\n");
    const unpatched = await build(`export { mergeFrames } from "./utils.js";`, changed);
    expect(unpatched.warnings.map((w) => w.text)).toEqual([
      expect.stringContaining("did not match the known slow form; left unpatched"),
    ]);
  });
});
