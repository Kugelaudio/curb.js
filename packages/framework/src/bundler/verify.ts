import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  RENDER_CHECK_ARG,
  RENDER_CHECK_MARKER,
  type RenderCheckReport,
} from "./render-check.js";

/**
 * Prove the artifact RUNS before the build calls itself a success.
 *
 * Two packaging bugs shipped out of builds that reported success, and both were found
 * days later by a human running the artifact by hand: a dependency-version mismatch
 * that crashed it at import (`Class extends value undefined`), and a manifest
 * `entrypoint` naming a file that exits 0 having started nothing -- which the hosted
 * platform would have recorded as a healthy runner for a call that never happened.
 * Neither is visible to tsc, to the unit suite, or to the build's own bookkeeping.
 * Only starting the thing finds them.
 *
 * Three properties of this check are load-bearing:
 *
 *   - the artifact runs outside every dependency-install ancestry. A repository build is
 *     copied to OS temp; a hosted build is copied beside its dependency root. Otherwise Node's
 *     upward resolution silently reaches the real install above it and every packaging
 *     bug passes as a false green (see docs/build-verification.md);
 *   - the entrypoint is read from curb.bundle.json rather than hardcoded. The
 *     entrypoint being wrong IS one of the two bugs, so a constant here would verify a
 *     file the runner never executes;
 *   - success is a marker the worker logs, not the exit status. The library entry exits
 *     cleanly and starts nothing; the marker is only reachable once every import
 *     resolved AND a worker actually began.
 *
 * A started worker is necessary and not sufficient. The third packaging bug to reach a
 * human was an artifact that booted, joined a room, and had nothing to say: the project's
 * context/ markdown was never packaged, so every `<Text src=…>` raised and the agent
 * rendered empty. Nothing about the start marker could have caught it. So the artifact is
 * asked, second, to render its complete authoring surface and report what it holds --
 * see render-check.ts, which runs inside the artifact.
 */

/**
 * Logged by `@livekit/agents` the moment `AgentServer.run()` starts the worker, and
 * BEFORE it opens the WebSocket to LiveKit. That ordering is what lets this check run
 * offline against placeholder credentials.
 */
export const WORKER_START_MARKER = '"msg":"starting worker"';

/** Long enough for a cold filesystem in CI, short enough to notice a hang. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Grace period between asking the worker to stop and killing its process group. */
const TERMINATE_GRACE_MS = 2_000;

/**
 * Cap on captured child output. A failing artifact usually says everything in its
 * first stack trace, while a retry loop can print forever; the cap bounds memory and
 * the report keeps the HEAD, where the first failure is.
 */
const MAX_CAPTURED_BYTES = 256 * 1024;

export type VerifyOptions = {
  /** The finished artifact root: the directory holding curb.bundle.json. */
  outDir: string;
  timeoutMs?: number;
  /** Node binary to run the artifact with. Defaults to the one running the build. */
  nodePath?: string;
  /**
   * Where the isolated copy is made. Defaults to a fresh directory under the OS temp
   * dir; tests use it to place the copy deterministically.
   */
  isolationRoot?: string;
  /** Extra environment for the child, merged over the placeholder credentials. */
  env?: Record<string, string>;
  /**
   * The `context/` markdown the project holds, as `<Text src>` keys. When given, the
   * artifact must report exactly this set back or the build fails. Omitted (only by
   * tests that synthesise an artifact) skips the render check entirely.
   */
  expectedContextFiles?: string[];
};

/**
 * Hosted builds put TMPDIR inside their bounded attempt workspace, which also owns the
 * installed node_modules. Verification cannot copy there without making the install an
 * ancestor of the supposedly isolated artifact, so it uses the scratch directory beside
 * the outermost dependency root. Local builds keep the OS-temp default.
 */
export function verificationIsolationRoot(
  profile: string | undefined,
  dependencyRoot: string,
): string | undefined {
  return profile === "hosted" ? dirname(dependencyRoot) : undefined;
}

/**
 * Where this check's own wall clock went, phase by phase.
 *
 * Split apart rather than reported as one number because the two starts are the whole
 * question: verification -- a runner cold start, done twice -- may be over half of
 * `curb build`, and a single combined figure cannot
 * tell a slow boot from a slow render from a slow 600 MB copy. The copy and the removal
 * are timed too; they are not starts, and folding them into one would attribute file IO
 * to the runtime.
 */
export type VerifyPhaseTimings = {
  /** Copying the finished artifact out of dependency ancestry, or zero when already isolated. */
  isolateMs: number;
  /** The FIRST start: spawn to the worker's start marker. */
  startMs: number;
  /** The SECOND start: the same entrypoint again under `curb-render-check`, spawn to
   * exit. Zero when no render check was asked for. */
  renderMs: number;
  /** Removing the isolated copy again. */
  cleanupMs: number;
};

export type VerifyResult = {
  /** The entrypoint as the manifest declared it, artifact-relative. */
  entrypoint: string;
  /** Where the artifact ran: an isolated copy, or outDir when it was already isolated. */
  isolatedDir: string;
  /** Wall time from spawn to marker. */
  durationMs: number;
  /** Everything the child printed up to the marker. */
  output: string;
  /** What the artifact rendered, or undefined when the render check was not asked for. */
  render?: RenderCheckReport;
  /** What each phase of this check cost. See VerifyPhaseTimings. */
  timings: VerifyPhaseTimings;
};

/** What `runUntilMarker` knows: the first start, before anything renders or is timed. */
type StartedArtifact = Omit<VerifyResult, "render" | "timings">;

/** The artifact did not start. Carries the child's output so the build can print it. */
export class ArtifactVerificationError extends Error {
  readonly output: string;

  constructor(message: string, output: string) {
    // The output is folded into the message because the CLI's failure path prints
    // `error.message` and nothing else. A verification failure that only says "the
    // artifact did not start" sends the reader back to reproducing it by hand, which
    // is the loop this check exists to close.
    const detail = output.trim().length > 0 ? output.trimEnd() : "(the artifact printed nothing)";
    super(`${message}\n\n  --- artifact output ---\n${indent(detail)}\n  --- end of output ---`);
    this.name = "ArtifactVerificationError";
    this.output = output;
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/**
 * The environment the artifact is started with.
 *
 * Built from scratch rather than inherited: a developer's shell holds real LiveKit
 * credentials, and inheriting them would point the check at a real server -- turning a
 * hermetic, offline assertion into one that passes or fails on the network. The
 * placeholders are enough because the marker is logged before the first connect.
 */
function verificationEnv(extra?: Record<string, string>): Record<string, string> {
  const passthrough: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "SystemRoot", "APPDATA"]) {
    const value = process.env[name];
    if (value !== undefined) passthrough[name] = value;
  }
  return {
    ...passthrough,
    // Unroutable on purpose: the worker retries the connection it will never make,
    // and this check kills it at the marker long before that matters.
    LIVEKIT_URL: "ws://127.0.0.1:1",
    LIVEKIT_API_KEY: "curb-build-verify",
    LIVEKIT_API_SECRET: "curb-build-verify-secret",
    CURB_AGENT_NAME: "curb-build-verify",
    ...extra,
  };
}

/**
 * Read the entrypoint the artifact DECLARES.
 *
 * Every failure here is fatal rather than a fallback to a known path: a manifest a
 * runner cannot follow is exactly the defect this check was added for, and guessing
 * the entry would hide it.
 */
export async function readManifestEntrypoint(outDir: string): Promise<string> {
  const manifestPath = join(outDir, "curb.bundle.json");
  if (!existsSync(manifestPath)) {
    throw new ArtifactVerificationError(
      `curb build: the artifact has no curb.bundle.json at ${manifestPath}, so nothing ` +
        `names its entrypoint and no runner can start it.`,
      "",
    );
  }

  let manifest: unknown;
  const raw = await readFile(manifestPath, "utf8");
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new ArtifactVerificationError(
      `curb build: ${manifestPath} is not valid JSON: ${(error as Error).message}`,
      raw,
    );
  }

  const entrypoint = (manifest as { entrypoint?: unknown })?.entrypoint;
  if (typeof entrypoint !== "string" || entrypoint.trim() === "") {
    throw new ArtifactVerificationError(
      `curb build: ${manifestPath} declares no "entrypoint", so the hosted runner has ` +
        `nothing to execute.`,
      raw,
    );
  }
  if (isAbsolute(entrypoint) || normalize(entrypoint).startsWith("..")) {
    throw new ArtifactVerificationError(
      `curb build: ${manifestPath} declares entrypoint "${entrypoint}", which points ` +
        `outside the artifact. It must be a path relative to the artifact root.`,
      raw,
    );
  }
  return entrypoint;
}

/**
 * Fail if any directory above `dir` holds a node_modules.
 *
 * The isolation is the whole point: with an install above it, Node resolves the
 * artifact's imports against that install and a package the artifact is missing
 * entirely still loads. The check would pass on an artifact nobody can run.
 */
function ancestorInstall(dir: string): string | undefined {
  let current = dirname(dir);
  for (;;) {
    if (existsSync(join(current, "node_modules"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function assertNoAncestorInstall(dir: string): Promise<void> {
  const ancestor = ancestorInstall(dir);
  if (ancestor !== undefined) {
    throw new ArtifactVerificationError(
      `curb build: cannot verify the artifact in ${dir} because ${ancestor}/node_modules ` +
        `sits above it. Node would resolve the artifact's imports against that install ` +
        `and every missing package would appear to load. Set TMPDIR to a directory with ` +
        `no node_modules above it.`,
      "",
    );
  }
}

/**
 * Ensure the artifact is outside dependency ancestry, start the entrypoint its manifest
 * declares, and wait for the worker's start marker. An artifact that is already isolated
 * runs in place; a repository artifact is copied to an isolated temp directory first.
 *
 * Resolves when the marker appears; throws ArtifactVerificationError when the child
 * exits first (for any reason, including exit 0), when it times out, or when the
 * artifact cannot be isolated at all.
 */
export async function verifyArtifactStarts(options: VerifyOptions): Promise<VerifyResult> {
  const outDir = await realpath(resolve(options.outDir));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const nodePath = options.nodePath ?? process.execPath;
  const entrypoint = await readManifestEntrypoint(outDir);

  let isolatedDir = outDir;
  let removeIsolatedDir = false;
  let isolateMs = 0;
  let renderMs = 0;
  let cleanupMs = 0;
  let result: VerifyResult;
  try {
    if (ancestorInstall(outDir) !== undefined) {
      // realpath because macOS hands out /var/folders/... which is a symlink to
      // /private/var/...; the ancestor walk has to see the path Node will actually resolve.
      const isolationRoot = options.isolationRoot ?? (await realpath(tmpdir()));
      isolatedDir = await mkdtemp(join(isolationRoot, "curb-verify-"));
      removeIsolatedDir = true;
      await assertNoAncestorInstall(isolatedDir);
      const copyStartedAt = Date.now();
      try {
        await cp(outDir, isolatedDir, { recursive: true });
      } catch (error) {
        // Attributed rather than propagated raw: a bare ENOSPC out of a build reads like
        // the build ran out of disk, not like the verification copy did.
        throw new ArtifactVerificationError(
          `curb build: could not copy the artifact to ${isolatedDir} to verify it: ` +
            `${(error as Error).message}`,
          "",
        );
      }
      isolateMs = Date.now() - copyStartedAt;
    }

    const entryFile = join(isolatedDir, entrypoint);
    // Containment, checked after the copy rather than trusted from the manifest string:
    // a normalized path can still leave the tree through a symlink.
    if (!entryFile.startsWith(isolatedDir + sep)) {
      throw new ArtifactVerificationError(
        `curb build: entrypoint "${entrypoint}" resolves outside the artifact.`,
        "",
      );
    }
    if (!existsSync(entryFile)) {
      throw new ArtifactVerificationError(
        `curb build: curb.bundle.json names entrypoint "${entrypoint}", which does not ` +
          `exist in the artifact. A runner following the manifest would fail to start.`,
        "",
      );
    }

    const env = verificationEnv(options.env);
    const started = await runUntilMarker({
      isolatedDir,
      entrypoint,
      entryFile,
      nodePath,
      timeoutMs,
      env,
    });

    // The second start, timed apart from the first. Same entrypoint, same isolated tree;
    // what differs is that this one renders the agent and exits on its own.
    let render: RenderCheckReport | undefined;
    if (options.expectedContextFiles !== undefined) {
      const renderStartedAt = Date.now();
      render = await runRenderCheck({
        isolatedDir,
        entrypoint,
        entryFile,
        nodePath,
        timeoutMs,
        env,
        expectedContextFiles: options.expectedContextFiles,
      });
      renderMs = Date.now() - renderStartedAt;
    }
    result = {
      ...started,
      render,
      // cleanupMs is filled in below: removing the copy is the last thing this check
      // does, so it is not knowable while the result is being built.
      timings: { isolateMs, startMs: started.durationMs, renderMs, cleanupMs: 0 },
    };
  } finally {
    if (removeIsolatedDir) {
      const cleanupStartedAt = Date.now();
      await rm(isolatedDir, { recursive: true, force: true });
      cleanupMs = Date.now() - cleanupStartedAt;
    }
  }
  result.timings.cleanupMs = cleanupMs;
  return result;
}

type RunOptions = {
  isolatedDir: string;
  entrypoint: string;
  entryFile: string;
  nodePath: string;
  timeoutMs: number;
  env: Record<string, string>;
};

function runUntilMarker(options: RunOptions): Promise<StartedArtifact> {
  const { isolatedDir, entrypoint, entryFile, nodePath, timeoutMs, env } = options;
  const startedAt = Date.now();

  return new Promise<StartedArtifact>((resolvePromise, rejectPromise) => {
    // detached so the worker gets its own process group. LiveKit forks a pool of job
    // processes; killing only the parent strands them, and a stranded pool holds the
    // temp tree open and keeps its health port bound for the next build.
    const child = spawn(nodePath, [entryFile, "start"], {
      cwd: isolatedDir,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let captured = "";
    let markerSeen = false;
    let settled = false;

    const capture = (chunk: Buffer): void => {
      if (captured.length < MAX_CAPTURED_BYTES) captured += chunk.toString("utf8");
      // Either stream is accepted. Today the marker is written to stdout; what proves
      // the worker started is that the line exists at all, not which fd carried it, and
      // a logger destination change should not turn this check into a false red.
      if (!markerSeen && captured.includes(WORKER_START_MARKER)) {
        markerSeen = true;
        finish();
      }
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const timer = setTimeout(() => {
      finish(
        new ArtifactVerificationError(
          `curb build: the artifact's entrypoint "${entrypoint}" did not start a worker ` +
            `within ${Math.round(timeoutMs / 1000)}s. Expected ${WORKER_START_MARKER} in ` +
            `its output.`,
          captured,
        ),
      );
    }, timeoutMs);

    child.on("error", (error) => {
      finish(
        new ArtifactVerificationError(
          `curb build: could not run the artifact's entrypoint "${entrypoint}": ` +
            error.message,
          captured,
        ),
      );
    });

    child.on("exit", (code, signal) => {
      // A marker already seen wins: this exit is the kill below, or a crash that
      // happened after the worker was demonstrably up.
      if (markerSeen) return finish();
      const how =
        signal !== null ? `was killed by ${signal}` : `exited with code ${code ?? "null"}`;
      finish(
        new ArtifactVerificationError(
          `curb build: the artifact's entrypoint "${entrypoint}" ${how} without starting ` +
            `a worker. Expected ${WORKER_START_MARKER} in its output.\n` +
            `  An entrypoint that stops before this line leaves the hosted runner ` +
            `recording a healthy start for a call that never happens.`,
          captured,
        ),
      );
    });

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopChild(child.pid);
      if (error) rejectPromise(error);
      else
        resolvePromise({
          entrypoint,
          isolatedDir,
          durationMs: Date.now() - startedAt,
          output: captured,
        });
    }
  });
}

type RenderCheckOptions = RunOptions & { expectedContextFiles: string[] };

/**
 * Ask the artifact to render its complete authoring surface, and check what it reports.
 *
 * Run as a SECOND invocation of the same entrypoint the runner executes, so what renders
 * is that file's module graph rather than a sibling's. It exits on its own; unlike the
 * worker there is nothing to keep alive and nothing to kill.
 */
async function runRenderCheck(options: RenderCheckOptions): Promise<RenderCheckReport> {
  const { entrypoint, entryFile, nodePath, isolatedDir, timeoutMs, env } = options;
  const child = await runToCompletion({
    nodePath,
    args: [entryFile, RENDER_CHECK_ARG],
    cwd: isolatedDir,
    env,
    timeoutMs,
  });

  const line = child.output
    .split("\n")
    .find((candidate) => candidate.startsWith(`${RENDER_CHECK_MARKER} `));
  if (!line) {
    throw new ArtifactVerificationError(
      `curb build: the artifact's entrypoint "${entrypoint}" could not render its agent. ` +
        `Expected a "${RENDER_CHECK_MARKER}" line in its output.\n` +
        `  An artifact that starts a worker but renders nothing joins the call and has ` +
        `nothing to say.`,
      child.output,
    );
  }

  let report: RenderCheckReport;
  try {
    report = JSON.parse(line.slice(RENDER_CHECK_MARKER.length + 1)) as RenderCheckReport;
  } catch (error) {
    throw new ArtifactVerificationError(
      `curb build: the artifact's render report is not valid JSON: ${(error as Error).message}`,
      child.output,
    );
  }

  if (report.errors.length > 0) {
    throw new ArtifactVerificationError(
      `curb build: the artifact rendered with ${report.errors.length} authoring ` +
        `error(s):\n${indent(report.errors.join("\n"))}`,
      child.output,
    );
  }

  // The set, not the count: a build that ships two of three markdown files leaves one
  // skill silently empty, which is the failure this whole check exists for.
  const shipped = new Set(report.contextFiles ?? []);
  const missing = options.expectedContextFiles.filter((src) => !shipped.has(src));
  if (missing.length > 0) {
    throw new ArtifactVerificationError(
      `curb build: the artifact is missing context markdown the project declares:\n` +
        missing.map((src) => `    - context/${src}`).join("\n") +
        `\n  It carries: ${[...shipped].join(", ") || "(none)"}.\n` +
        `  Every <Text src=…> pointing at one of these would raise inside a live call.`,
      child.output,
    );
  }

  return report;
}

type RunToCompletionOptions = {
  nodePath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
};

/** Run a child to exit, capturing its output. Rejects on a non-zero exit or a timeout. */
function runToCompletion(options: RunToCompletionOptions): Promise<{ output: string }> {
  const { nodePath, args, cwd, env, timeoutMs } = options;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(nodePath, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });

    let captured = "";
    let settled = false;
    const capture = (chunk: Buffer): void => {
      if (captured.length < MAX_CAPTURED_BYTES) captured += chunk.toString("utf8");
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopChild(child.pid);
      if (error) rejectPromise(error);
      else resolvePromise({ output: captured });
    };

    const timer = setTimeout(() => {
      settle(
        new ArtifactVerificationError(
          `curb build: the artifact did not finish rendering within ` +
            `${Math.round(timeoutMs / 1000)}s.`,
          captured,
        ),
      );
    }, timeoutMs);

    child.on("error", (error) => {
      settle(new ArtifactVerificationError(`curb build: could not run the artifact: ${error.message}`, captured));
    });

    child.on("exit", (code, signal) => {
      if (code === 0) return settle();
      const how = signal !== null ? `was killed by ${signal}` : `exited with code ${code ?? "null"}`;
      settle(
        new ArtifactVerificationError(
          `curb build: the artifact ${how} while rendering its agent.`,
          captured,
        ),
      );
    });
  });
}

/** Stop the worker and the job processes it forked, then stop insisting. The child must have
 * been spawned `detached`, so it leads a process group of its own. */
export function stopChild(pid: number | undefined): void {
  if (pid === undefined) return;
  const signal = (name: NodeJS.Signals): void => {
    try {
      // Negative pid: the whole process group created by `detached`.
      process.kill(-pid, name);
    } catch {
      // KEEP-JUSTIFIED: the group is already gone (the common case -- the child
      // exiting is one of the ways we get here). There is nothing left to stop and
      // nothing to report.
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), TERMINATE_GRACE_MS).unref();
}
