import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { MANIFEST_FILENAME, type BundleFile } from "./bundle-digest.js";
import { runCurbBuild, type BuildResult } from "./index.js";

/**
 * The project and the `--emit-layers` build that layered-build.test.ts (the emit side) and
 * layered-build.dependency-layer.test.ts (the hit side) both start from. Each test file
 * makes its own copy and its own emit build: the hit side prunes and edits the project, and
 * the manifest names the project's directory, so two files cannot share one tree. Split in
 * two so vitest runs the two halves in parallel workers instead of one file serially.
 *
 * The project is the fixture, copied beside it under src/test-fixtures/ (so its relative
 * imports of the framework still resolve) and given a few packages of its own and an
 * mcp.servers.json.
 */

export const frameworkRoot = resolve(import.meta.dirname, "..", "..");
const fixtureProject = join(frameworkRoot, "src", "test-fixtures", "project");
export const AGENT = "src/agent/agent.tsx";
export const MCP_SERVERS = '{"servers":[]}\n';
/** What the project's agent declares; every build's manifest must carry it. */
const GOALS = { callback: { tool: "request_callback" }, calm: { judge: "The caller stays calm." } };
const EXPERIMENTS = { greeting: { variants: { formal: 1, casual: 1 } } };
export const DECLARED = {
  goals: [
    { name: "callback", kind: "tool", tool: "request_callback" },
    { name: "calm", kind: "judge", criterion: "The caller stays calm." },
  ],
  experiments: [{ name: "greeting", variants: [{ name: "casual", weight: 1 }, { name: "formal", weight: 1 }] }],
};
export const declaredIn = (manifestPath: string) => {
  const { goals, experiments } = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  return { goals, experiments };
};

export const toPosix = (path: string) => path.split(sep).join("/");
export const byBytes = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));
export const sha256 = (bytes: Buffer): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(absolute));
    else found.push(absolute);
  }
  return found;
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
}

export let projectRoot: string;
export let outRoot: string;
export let emitted: BuildResult;

export type Manifest = {
  entrypoint: string;
  entryDigest: string;
  treeDigest: string;
  files: BundleFile[];
  externals: unknown[];
};
type BuildInputsRecord = {
  format: number;
  inputs: string[];
  edges: Array<{ importer: string; specifier: string; kind: string; resolved: string }>;
  recordedExternals: string[];
};

export const emitManifestPath = () => join(outRoot, "emit", MANIFEST_FILENAME);
// Read once: the emitted records do not change after beforeAll, and isApp runs per path.
let manifestCache: Manifest | undefined;
let buildInputsCache: BuildInputsRecord | undefined;
export const manifest = (): Manifest =>
  (manifestCache ??= JSON.parse(readFileSync(emitManifestPath(), "utf8")) as Manifest);
export const buildInputs = (): BuildInputsRecord =>
  (buildInputsCache ??= JSON.parse(
    readFileSync(join(outRoot, "layers", "build-inputs.json"), "utf8"),
  ) as BuildInputsRecord);

/** Where the build placed things, read back from the manifest rather than restated. */
export const layout = () => {
  const entryHome = dirname(dirname(manifest().entrypoint));
  const traceBase = resolve(frameworkRoot, ...entryHome.split("/").map(() => ".."));
  const projectHome = toPosix(relative(traceBase, projectRoot));
  return { entryHome, traceBase, projectHome, mcpServers: `${projectHome}/mcp.servers.json` };
};

/** The L2 app path set, restated here rather than imported so the test cannot agree with a bug. */
export const isApp = (path: string): boolean => {
  const { entryHome, mcpServers } = layout();
  return (
    path === MANIFEST_FILENAME ||
    path.startsWith("assets/") ||
    path === mcpServers ||
    path === `${entryHome}/entry/hosted.mjs` ||
    path === `${entryHome}/entry/worker.mjs`
  );
};

/** `curb build` as the hosted builder runs it: a child process in the project directory. */
export function runCli(
  cliArgs: string[],
  options: { nodeArgs?: string[]; env?: Record<string, string>; cwd?: string; bin?: string } = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  delete env.AGENT_PROJECT_DIR;
  const bin = options.bin ?? join(frameworkRoot, "bin", "curb.js");
  return spawnSync(process.execPath, [...(options.nodeArgs ?? []), bin, ...cliArgs], {
    cwd: options.cwd ?? projectRoot,
    env,
    encoding: "utf8",
    timeout: 150_000,
  });
}

/** Copy the fixture into a fresh project with its own packages, MCP list and declarations. */
export function createLayeredProject(): void {
  // Beside the fixture, so `../../../../index.js` from src/agent still reaches the framework.
  projectRoot = mkdtempSync(join(frameworkRoot, "src", "test-fixtures", "layer-run-"));
  cpSync(fixtureProject, projectRoot, {
    recursive: true,
    filter: (source) => !source.split(sep).includes(".curb"),
  });
  writeTree(projectRoot, {
    "mcp.servers.json": MCP_SERVERS,
    "node_modules/layer-foo/package.json": '{"name":"layer-foo","version":"1.0.0","main":"index.js"}',
    "node_modules/layer-foo/index.js": 'globalThis.__layerFoo = "foo@1";\n',
    "node_modules/layer-foo/README.md": "never read by esbuild\n",
    "node_modules/layer-bar/package.json":
      '{"name":"layer-bar","version":"1.0.0","main":"index.js","dependencies":{"layer-foo":"2.0.0"}}',
    "node_modules/layer-bar/index.js": 'globalThis.__layerBar = require("layer-foo");\n',
    "node_modules/layer-bar/node_modules/layer-foo/package.json":
      '{"name":"layer-foo","version":"2.0.0","main":"index.js"}',
    "node_modules/layer-bar/node_modules/layer-foo/index.js": 'module.exports = "foo@2";\n',
    "node_modules/layer-unused/package.json": '{"name":"layer-unused","version":"1.0.0","main":"index.js"}',
    "node_modules/layer-unused/index.js": "module.exports = 1;\n",
  });
  const agent = join(projectRoot, AGENT);
  writeFileSync(
    agent,
    [
      'import "layer-foo";',
      'import "layer-bar";',
      // Native externals no dependency layer holds: sharp, and @livekit/rtc-ffi-bindings, which
      // @livekit/rtc-node requires behind curb/orchestration. The build still reads the goals.
      'import sharp from "sharp";',
      'import { createVoiceAgentBundle } from "../../../../orchestration.js";',
      "export const nativeProbe = [typeof sharp, typeof createVoiceAgentBundle];",
      readFileSync(agent, "utf8").replace(
        "defineAgent({",
        `defineAgent({\n  goals: ${JSON.stringify(GOALS)},\n  experiments: ${JSON.stringify(EXPERIMENTS)},`,
      ),
    ].join("\n"),
  );

  outRoot = mkdtempSync(join(tmpdir(), "curb-layers-"));
}

/** The `--emit-layers` build every assertion reads back: the artifact under emit/, the records under layers/. */
export async function emitLayers(): Promise<BuildResult> {
  emitted = await runCurbBuild({
    projectRoot,
    outDir: join(outRoot, "emit"),
    skipVerify: true,
    emitLayers: join(outRoot, "layers"),
  });
  return emitted;
}

export function removeLayeredProject(): void {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  if (outRoot) rmSync(outRoot, { recursive: true, force: true });
}
