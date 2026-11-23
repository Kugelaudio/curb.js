import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runCurbBuild } from "./index.js";

/**
 * A `curb build` artifact starts at its manifest entry in a fresh Node process, without the CLI,
 * and its model client must still keep the connection open between turns: the bundle loads the
 * dispatcher snapshot itself (`dispatcherSnapshotImport`), before Node installs its own dispatcher
 * (`runtimeHttpPlugin`).
 */

const frameworkRoot = resolve(import.meta.dirname, "..", "..");
const fixtureProject = join(frameworkRoot, "src", "test-fixtures", "project");
/** Longer than Node's own 4 s idle limit, as a caller's turn is. */
const GAP_MS = 5_000;

let projectRoot: string;
let outRoot: string;
let entry: string;

beforeAll(async () => {
  // Beside the fixture, so `../../../../index.js` from src/agent still reaches the framework.
  projectRoot = mkdtempSync(join(frameworkRoot, "src", "test-fixtures", "keep-alive-run-"));
  cpSync(fixtureProject, projectRoot, {
    recursive: true,
    filter: (source) => !source.split(sep).includes(".curb"),
  });
  const agent = join(projectRoot, "src", "agent", "agent.tsx");
  writeFileSync(
    agent,
    [
      'import { runAiSdkAgent as twoTurnsRun } from "../../../../orchestration.js";',
      'import { kugelaudio as twoTurnsKugelaudio } from "../../../../providers.js";',
      // Two model calls a caller's turn apart, made by the artifact itself as it loads.
      'if (process.env.CURB_TEST_TWO_TURNS === "1") {',
      '  const turn = { systemPrompt: "You answer the phone.", skillTitle: "", stateSnapshot: [], tools: [], messages: [{ role: "user", content: "Hallo" }] };',
      "  await twoTurnsRun(turn, { llm: twoTurnsKugelaudio.llm() });",
      `  await new Promise((resolve) => setTimeout(resolve, ${GAP_MS}));`,
      "  await twoTurnsRun(turn, { llm: twoTurnsKugelaudio.llm() });",
      "}",
      readFileSync(agent, "utf8"),
    ].join("\n"),
  );
  // Inside the framework package, so the artifact's externals resolve from its node_modules:
  // the trace that would copy them beside the artifact is skipped.
  outRoot = mkdtempSync(join(frameworkRoot, ".keep-alive-artifact-"));
  await runCurbBuild({ projectRoot, outDir: outRoot, skipTrace: true, skipVerify: true });
  const manifest = JSON.parse(readFileSync(join(outRoot, "curb.bundle.json"), "utf8")) as { entrypoint: string };
  entry = join(outRoot, manifest.entrypoint);
}, 240_000);

afterAll(() => {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  if (outRoot) rmSync(outRoot, { recursive: true, force: true });
});

it("keeps the model connection between turns in an artifact started at its manifest entry", async () => {
  const clientPorts: (number | undefined)[] = [];
  const server = createServer((req, res) => {
    clientPorts.push(req.socket.remotePort);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          created: 0,
          model: "qwen3.8-27b",
          choices: [{ index: 0, message: { role: "assistant", content: "Hallo." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  // No idle limit and no `Keep-Alive: timeout` hint, which the client would otherwise follow:
  // a second connection can only be the client's own idle limit.
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env: NodeJS.ProcessEnv = {
    // The readiness probe imports the bundle, constructs the agent and exits, with no room.
    CURB_READINESS_PROBE: "1",
    CURB_TEST_TWO_TURNS: "1",
    KUGELAUDIO_API_KEY: "test-kugel-key",
    KUGELAUDIO_API_BASE: `${origin}/`,
  };
  for (const name of ["PATH", "HOME", "TMPDIR"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  try {
    await promisify(execFile)(process.execPath, [entry], { env, timeout: 60_000 });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  expect(clientPorts).toHaveLength(2);
  expect(clientPorts[1]).toBe(clientPorts[0]);
}, 90_000);
