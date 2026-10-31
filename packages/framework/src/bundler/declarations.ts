import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExperimentDeclaration } from "../experiments.js";
import type { GoalDeclaration } from "../goals.js";
import type { HookName } from "../hooks.js";
import type { BundleAsset } from "./assets.js";
import { DECLARATIONS_COMMAND, DECLARATIONS_MARKER, type DeclarationsReport } from "./declarations-child.js";
import { LayerEscapeError, missingModuleEscape } from "./layer-escape.js";
import { stopChild } from "./verify.js";

/**
 * The manifest fields that describe what a bundle IMPLEMENTS and what it ASKS FOR:
 * `runtimeProtocolVersion`, `runtime.node`, `requiredSecrets` and `requiredCapabilities`, and
 * what the agent MEASURES: `goals` and `experiments`, and what it RUNS AFTER A CALL: `hooks`.
 *
 * They are gathered here rather than written inline in the manifest literal because each
 * one is a claim someone downstream enforces, and a claim needs its derivation next to it.
 * A host may refuse a bundle over any of them, compare the first two before it imports a
 * line of customer code, and grant exactly the capability set and no more.
 */

/**
 * The runner-to-bundle protocol generation this bundle targets.
 *
 * `1.0` is the only MAJOR so far. The version pins the runner-to-bundle interface only --
 * the entrypoint module shape, the `HostedRuntimeContext` fields, the lifecycle ordering,
 * the reserved environment names and the closed vocabularies -- and explicitly NOT the
 * framework version, the project's code or the Node major, each of which the manifest
 * carries separately.
 *
 * What this constant does NOT yet claim, stated here so nobody reads it as more than it
 * is: a host could assert `mod.runtimeProtocolVersion === manifest.runtimeProtocolVersion`
 * against an entrypoint exporting `createHostedAgent`. The entrypoint `curb build` writes
 * today is a LiveKit worker, not that module shape, so the export side of that assertion
 * does not exist yet. Stamping the manifest is what lets an artifact be PUBLISHED; making
 * the entrypoint export it is the runner seam, and it is separate work.
 */
export const RUNTIME_PROTOCOL_VERSION = "1.0";

/**
 * The Node major the artifact must run on.
 *
 * The major running THIS build, because that is the ABI the vendored native prebuilds
 * were selected for: a compiled addon is bound to `NODE_MODULE_VERSION`, and the tree the
 * bundler mirrors is the one this Node resolved. Reporting the esbuild syntax target
 * instead ("node24") would name a floor the bindings do not honour, and a runner image
 * matched to it would load an addon built for another ABI.
 *
 * Consistent with the rule that the builder and the runner share the host platform --
 * the same rule that makes `target` the host's pair.
 */
export function hostNodeMajor(): string {
  const major = process.versions.node.split(".")[0];
  if (!/^\d+$/.test(major)) {
    throw new Error(
      `curb build: cannot read this Node's major version from ${process.versions.node}.\n` +
        `  The manifest must say which Node major the artifact needs; a bundle that does ` +
        `not cannot be matched to a runner image.`,
    );
  }
  return major;
}

/** One entry of `manifest.requiredSecrets`. */
export type BundleSecret = {
  name: string;
  required: boolean;
  phase: "build" | "runtime";
};

/**
 * Read the runtime secret names a project explicitly declares in package.json.
 *
 * The framework never infers provider credentials from its defaults. A project may choose
 * other providers in its `<Agent>` props, so a guessed name would refuse a deployment that
 * never reads it. The project is the authority; the bundle carries names only, never values.
 */
export async function bundleRequiredSecrets(projectRoot: string): Promise<BundleSecret[]> {
  const packagePath = join(projectRoot, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    throw new Error(
      `curb build: cannot read the project's secret declarations from ${packagePath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const root = parsed as { curb?: { requiredRuntimeSecrets?: unknown } };
  const declaration = root.curb?.requiredRuntimeSecrets;
  if (declaration === undefined) return [];

  const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (
    !Array.isArray(declaration) ||
    declaration.some((name) => typeof name !== "string" || !validName.test(name))
  ) {
    throw new Error(
      "curb build: package.json curb.requiredRuntimeSecrets must be an array of " +
        "non-empty environment variable names (for example, [\"LLM_API_KEY\"]).",
    );
  }

  return [...new Set(declaration)].sort().map((name) => ({
    name,
    required: true,
    phase: "runtime" as const,
  }));
}

/**
 * The capabilities every artifact this builder produces requires, whatever the project is.
 *
 * Derived from the generated worker entry in `index.ts`, which is a fixed file this same
 * build writes: it unconditionally starts a LiveKit voice session (`realtime.audio`) and
 * hands it curb's conversation loop, whose turns run a model (`provider.llm`) over
 * speech-to-text (`provider.stt`) and text-to-speech (`provider.tts`). There is no branch
 * in that file where any of the four is unused -- the direct-join and worker/dispatch
 * modes differ in how the room is obtained, not in what runs inside it.
 *
 * This is why an empty `requiredCapabilities` could not ship. A host that grants exactly
 * the declared set and no more would read an empty list as a bundle that cannot reach a
 * model, and it would be a field that lies rather than a field that says "nothing
 * declared".
 */
const ARTIFACT_CAPABILITIES = [
  "provider.llm",
  "provider.stt",
  "provider.tts",
  "realtime.audio",
] as const;

/**
 * Capabilities NOT declared, and why each absence is a finding rather than an oversight:
 *
 *   - `egress.public`: the artifact's outbound traffic is its model, speech and media
 *     providers, which the capabilities above already cover. An agent tool that fetched an arbitrary URL
 *     would need this, and nothing at build time can see one -- tools are ordinary
 *     functions in the project's module graph. Declaring it unconditionally would grant
 *     every bundle public egress to cover a case this builder cannot detect.
 *   - `storage.conversation`: the conversation store is off by default in a hosted runner
 *     (`getDefaultConversationStore` in server/conversation-store.ts). Declaring it would ask for durable
 *     transcript writes on behalf of a bundle that does not perform them.
 *
 * Both need a project-level declaration surface to answer honestly. That is the open
 * question recorded in `docs/build-verification.md`.
 */

/**
 * Every MCP declaration reachable in the project's agent source.
 *
 * `<Mcp id url />` in the agent tree and `mcpServers` in a `defineAgent` config are the
 * two ways a project declares one. Both are ordinary source text, so this reads the agent
 * source the bundle SHIPS under `assets/agent-source/` -- the same bytes the module graph
 * carries, put there by `assets.ts` from the generated registry's own key list. Re-walking
 * `src/agent/` would be a third discovery implementation that has to agree with the other
 * two forever.
 *
 * The match is deliberately generous: a mention of either name in a comment declares the
 * capability. Over-declaring grants a capability the bundle never uses; under-declaring is
 * a refused connection in the middle of a live call. Those are not symmetric.
 */
const MCP_DECLARATION = /\bMcp\b|\bmcpServers\b/;

/**
 * What the finished bundle asks the runner to grant, sorted so two builds of one revision
 * produce the same list.
 *
 * Reads the artifact rather than the checkout: by the time this runs, `assets/` is written
 * and is what a runner would see.
 */
export async function deriveRequiredCapabilities(options: {
  outDir: string;
  assets: readonly BundleAsset[];
}): Promise<string[]> {
  const capabilities = new Set<string>(ARTIFACT_CAPABILITIES);

  for (const asset of options.assets) {
    if (asset.kind !== "agent-source") continue;
    const absolute = join(options.outDir, asset.path);
    let source: string;
    try {
      source = await readFile(absolute, "utf8");
    } catch (error) {
      throw new Error(
        `curb build: cannot read ${asset.path} to derive the bundle's capabilities: ` +
          `${error instanceof Error ? error.message : String(error)}\n` +
          `  This build wrote that file moments ago. Failing here rather than declaring a ` +
          `capability set derived from a source set that is missing a file: the runner ` +
          `grants exactly what is declared, so a silent omission is a refused tool call ` +
          `inside a live call.`,
      );
    }
    if (MCP_DECLARATION.test(source)) capabilities.add("integration.mcp");
  }

  return [...capabilities].sort();
}

/** `manifest.goals`, `manifest.experiments` and `manifest.hooks`: what the agent declares in
 * `defineAgent`. */
export type BundleAgentDeclarations = {
  goals: GoalDeclaration[];
  experiments: ExperimentDeclaration[];
  hooks: HookName[];
};

/** How long the agent's module may take to import before the build gives up on it. */
export const DECLARATIONS_TIMEOUT_MS = 30_000;

/** The CLI shim the build runs from: the child goes through it, so tsx and the project's spanning
 * tsconfig are set up exactly as for `curb check`. */
const CURB_BIN = fileURLToPath(new URL("../../bin/curb.js", import.meta.url));

/** More output than this from the child is dropped; the report line comes early. */
const MAX_CHILD_OUTPUT_CHARS = 1_000_000;

/**
 * The goals, experiments and hooks the project's agent declares, as the manifest carries them.
 *
 * They are values in the agent's module, so the build imports `src/agent/agent.tsx` (not its
 * skills) the way `curb check` does, in a child process (`declarations-child.ts`) that prints
 * them and exits: an agent that opens a handle at import cannot keep the build running, and a
 * package missing from a dependency layer loads as a stub there. The artifact's render check
 * loads the same agent, but it does not run in every build (`--dependency-layer`, `--no-verify`,
 * `--no-trace` skip it), and every build writes all three fields. `defineAgent` validates them on
 * import, so goals, experiments or hooks a platform would refuse fail the build here, naming the
 * problem.
 *
 * In a `--dependency-layer` build, a failure while a stub was loaded, and a module Node still
 * cannot find, are escapes (exit 75: the builder falls back to a full build), not the project's
 * error; see {@link missingModuleEscape}.
 */
export async function bundleAgentDeclarations(options: {
  projectRoot: string;
  dependencyLayer: boolean;
  timeoutMs?: number;
}): Promise<BundleAgentDeclarations> {
  const timeoutMs = options.timeoutMs ?? DECLARATIONS_TIMEOUT_MS;
  const { report, output } = await runDeclarationsChild(options.projectRoot, timeoutMs);
  if (report.ok) return { goals: report.goals, experiments: report.experiments, hooks: report.hooks };

  if (options.dependencyLayer) {
    // With a stub loaded the failure may be the stub's (a name the importer needs that it does
    // not export, a value it is not), and a full install has the real package: an escape, so
    // the builder falls back to a full build. Only a failure with no stub involved is the
    // project's own.
    const standIn = report.standIns?.[0];
    if (standIn !== undefined) {
      throw new LayerEscapeError(
        "unresolved_import",
        standIn,
        `The agent's module failed to load with a stand-in for ${report.standIns!.join(", ")}, ` +
          `which the build inputs lack: ${report.message}`,
      );
    }
    const failure = Object.assign(new Error(report.message), report.code === undefined ? {} : { code: report.code });
    const escape = missingModuleEscape(failure, options.projectRoot);
    if (escape) throw escape;
  }
  // Node loads a .tsx file as CommonJS in a package without "type": "module", and CommonJS
  // cannot require curb, whose module graph awaits at its top level.
  const commonJs = report.code === "ERR_REQUIRE_ASYNC_MODULE";
  throw new Error(
    `curb build: cannot load the agent in src/agent/ to read its goals and experiments: ${report.message}\n` +
      (commonJs
        ? '  A curb project is an ES module package: add "type": "module" to package.json, as `npm create curb.js` writes it.'
        : "  The agent's module must import without throwing; `curb check` reports why it does not.") +
      tailOf(output),
  );
}

/** Run `curb build-declarations` to its report line. Rejects when it prints none or times out. */
function runDeclarationsChild(
  projectRoot: string,
  timeoutMs: number,
): Promise<{ report: DeclarationsReport; output: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_PROJECT_DIR: projectRoot };
  // The shim writes the spanning tsconfig for its working directory, the project, itself.
  delete env.TSX_TSCONFIG_PATH;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CURB_BIN, DECLARATIONS_COMMAND, projectRoot], {
      cwd: projectRoot,
      env,
      // Its own process group, so a timeout stops whatever the agent's module started too.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const capture = (chunk: Buffer): void => {
      if (output.length < MAX_CHILD_OUTPUT_CHARS) output += chunk.toString("utf8");
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const settle = (outcome: { report: DeclarationsReport } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopChild(child.pid);
      if ("error" in outcome) rejectPromise(outcome.error);
      else resolvePromise({ report: outcome.report, output });
    };

    const timer = setTimeout(() => {
      settle({
        error: new Error(
          `curb build: importing the agent to read its goals and experiments did not finish within ` +
            `${Math.round(timeoutMs / 1000)} s, so the build stopped it.\n` +
            "  Something src/agent/agent.tsx imports waits at import (a top-level await on a network call, " +
            "a client that connects before the module exports). Move that work into a tool or a component." +
            tailOf(output),
        ),
      });
    }, timeoutMs);

    child.on("error", (error) => {
      settle({ error: new Error(`curb build: could not start the child that reads the agent's goals and experiments: ${error.message}`) });
    });
    child.on("exit", (code, signal) => {
      const line = output.split("\n").find((candidate) => candidate.startsWith(`${DECLARATIONS_MARKER} `));
      if (line) {
        try {
          return settle({ report: JSON.parse(line.slice(DECLARATIONS_MARKER.length + 1)) as DeclarationsReport });
        } catch (error) {
          return settle({ error: new Error(`curb build: the agent's goals and experiments came back unreadable: ${(error as Error).message}`) });
        }
      }
      const how = signal !== null ? `was killed by ${signal}` : `exited with code ${code ?? "null"}`;
      settle({
        error: new Error(
          `curb build: the child that reads the agent's goals and experiments ${how} without reporting them.\n` +
            "  Does the agent's module call process.exit, or crash Node, when it is imported?" +
            tailOf(output),
        ),
      });
    });
  });
}

/** The end of the child's output, for a failure message. */
function tailOf(output: string): string {
  const lines = output
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith(`${DECLARATIONS_MARKER} `))
    .slice(-20);
  return lines.length > 0 ? `\n  Its output:\n${lines.map((line) => `    ${line}`).join("\n")}` : "";
}
