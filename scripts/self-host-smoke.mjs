#!/usr/bin/env node
// Proves a Curb agent can be hosted by anyone: no KugelAudio platform, no LiveKit keys.
//
//   node scripts/self-host-smoke.mjs [--keep]
//
// 1. checks the schema validator against the protocol fixtures (valid pass, invalid fail);
// 2. builds examples/insurance-agent with the real CLI (`curb build`, verification on);
// 3. starts the built entrypoint as a MANAGED runner (CURB_MANAGEMENT_ADDR/TOKEN) in an
//    environment holding nothing but PATH, HOME and TMPDIR;
// 4. waits for the stable stdout line `curb-hosted {"event":"ready",...}`;
// 5. drives host protocol v1 over HTTP and validates every JSON answer and every event
//    stream record against the published protocol.schema.json;
// 6. sends SIGTERM and expects `draining`, `ended`, EOF on the stream and exit code 0.
//
// Places no call: a call needs a realtime room, and this check is about the host protocol.
// --keep leaves the built artifact in place and prints its path.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { schemaValidator } from "./lib/json-schema-lite.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const framework = join(root, "packages/framework");
const project = join(root, "examples/insurance-agent");
const hosted = join(framework, "src/hosted");
const READY_PREFIX = 'curb-hosted {"event":"ready"';
const HOSTED_MARKER = "curb-hosted ";
const BUILD_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 30_000;

const keep = process.argv.includes("--keep");
const startedAt = performance.now();
const timings = [];
const children = new Set();
let workDir = null;

async function phase(name, run) {
  const began = performance.now();
  const result = await run();
  const ms = performance.now() - began;
  timings.push([name, ms]);
  console.log(`  ok  ${name} (${(ms / 1000).toFixed(1)}s)`);
  return result;
}

function fail(message) {
  throw new Error(message);
}

// --- the schema ---------------------------------------------------------------------------

const schema = schemaValidator(JSON.parse(readFileSync(join(hosted, "protocol.schema.json"), "utf8")));

function expectValid(type, value, what) {
  const errors = schema.validate(type, value);
  if (errors.length > 0) {
    fail(`${what} is not a valid ${type}:\n    ${errors.join("\n    ")}\n  value: ${JSON.stringify(value)}`);
  }
  return value;
}

/** The validator must agree with the fixtures, or a green below proves nothing. */
function checkValidatorAgainstFixtures() {
  let count = 0;
  for (const kind of ["valid", "invalid"]) {
    const dir = join(hosted, "protocol-fixtures", kind);
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const type = file.split(".")[0];
      const errors = schema.validate(type, JSON.parse(readFileSync(join(dir, file), "utf8")));
      if (kind === "valid" && errors.length > 0) fail(`validator refuses valid/${file}: ${errors.join("; ")}`);
      if (kind === "invalid" && errors.length === 0) fail(`validator accepts invalid/${file}`);
      count += 1;
    }
  }
  return count;
}

// --- processes ----------------------------------------------------------------------------

/** Runs to completion; rejects with the captured output on a non-zero exit. */
function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}:\n${output}`));
    });
  });
}

/** The environment a self-hoster's orchestrator would give a runner, and nothing else. */
function runnerEnv(address, token) {
  // A runner refuses to start without the key its agent's LLM needs; a self-hoster's
  // orchestrator passes the real one. Warming never calls the model.
  const env = {
    CURB_MANAGEMENT_ADDR: address,
    CURB_MANAGEMENT_TOKEN: token,
    KUGELAUDIO_API_KEY: "kugel-placeholder-for-warmup",
  };
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function startRunner(entry, cwd, env) {
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  const lines = [];
  let pending = "";
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    output += chunk;
    pending += chunk;
    const parts = pending.split("\n");
    pending = parts.pop();
    for (const line of parts) {
      lines.push(line);
      for (const waiter of [...waiters]) waiter();
    }
  });
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
      for (const waiter of [...waiters]) waiter();
    });
  });

  /** Resolves with the first stdout line starting with `prefix`. */
  const waitForLine = (prefix, timeoutMs) =>
    new Promise((resolve, reject) => {
      const done = () => {
        const line = lines.find((candidate) => candidate.startsWith(prefix));
        if (line !== undefined) {
          cleanup();
          resolve(line);
        } else if (child.exitCode !== null || child.signalCode !== null) {
          cleanup();
          reject(new Error(`the runner exited before printing ${prefix}:\n${output}`));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`no ${prefix} line within ${timeoutMs} ms:\n${output}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        waiters.splice(waiters.indexOf(done), 1);
      };
      waiters.push(done);
      done();
    });

  return { child, exited, waitForLine, output: () => output, lines };
}

// --- HTTP ---------------------------------------------------------------------------------

async function call(base, method, path, { token, body, rawBody } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined || rawBody !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`${method} ${path} answered ${response.status} with a body that is not JSON: ${text}`);
  }
  return { status: response.status, json };
}

async function expectAnswer(base, method, path, options, status, type, check = () => {}) {
  const answer = await call(base, method, path, options);
  const what = `${method} ${path}`;
  if (answer.status !== status) fail(`${what}: expected ${status}, got ${answer.status} ${JSON.stringify(answer.json)}`);
  expectValid(type, answer.json, what);
  check(answer.json, what);
  return answer.json;
}

function expectError(code) {
  return (body, what) => {
    if (body.error !== code) fail(`${what}: expected error ${code}, got ${body.error}`);
  };
}

/**
 * Follows the events stream and collects its NDJSON lines until EOF. Pings are counted and
 * dropped; every record is validated as a JournalRecord.
 */
async function openEvents(base, token, from) {
  const response = await fetch(`${base}/v1/runner/events?from=${from}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) fail(`GET /v1/runner/events?from=${from}: expected 200, got ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-ndjson")) fail(`events stream content-type is ${type}`);

  const records = [];
  let pings = 0;
  let notify = () => {};
  /** "end" for a complete chunked response, "socket" when the runner closed the connection. */
  let endedBy = null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const finished = (async () => {
    let buffer = "";
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        // The runner closing the socket is EOF for a reader; any other failure is not.
        if (error?.cause?.code !== "UND_ERR_SOCKET") throw error;
        endedBy = "socket";
        break;
      }
      const { value, done } = chunk;
      if (done) {
        endedBy = "end";
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop();
      for (const line of parts.filter((part) => part.trim() !== "")) {
        const parsed = JSON.parse(line);
        if ("ping" in parsed && !("envelope" in parsed)) {
          expectValid("Ping", parsed, "a heartbeat");
          pings += 1;
          continue;
        }
        records.push(expectValid("JournalRecord", parsed, `event record ${line}`));
        notify();
      }
    }
    if (buffer.trim() !== "") fail(`the events stream ended mid-line: ${buffer}`);
  })();
  // KEEP-JUSTIFIED: not a swallow. Every caller awaits `finished`; this only stops a failure
  // that lands before that await from crashing the process as an unhandled rejection.
  finished.catch(() => {});

  const nextRecord = (index, timeoutMs) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no event record #${index + 1} within ${timeoutMs} ms`)), timeoutMs);
      const poll = () => {
        if (records.length > index) {
          clearTimeout(timer);
          resolve(records[index]);
        }
      };
      notify = poll;
      poll();
      finished.catch(reject);
    });

  return {
    records,
    nextRecord,
    finished,
    cancel: () => reader.cancel(),
    pings: () => pings,
    endedBy: () => endedBy,
  };
}

// --- the check ----------------------------------------------------------------------------

async function main() {
  console.log("self-host smoke: build a Curb agent and run it as a managed runner with no platform");

  const fixtures = await phase("validator agrees with protocol-fixtures/", () => checkValidatorAgainstFixtures());
  console.log(`      ${fixtures} fixture(s)`);

  workDir = mkdtempSync(join(tmpdir(), "curb-self-host-"));
  const outDir = join(workDir, "dist");
  const buildEnv = { ...process.env };
  for (const name of Object.keys(buildEnv)) {
    if (name.startsWith("LIVEKIT_") || name.startsWith("CURB_")) delete buildEnv[name];
  }
  await phase("curb build examples/insurance-agent", () =>
    run(process.execPath, [join(framework, "bin/curb.js"), "build", "--out", outDir], {
      cwd: project,
      env: buildEnv,
      timeoutMs: BUILD_TIMEOUT_MS,
    }),
  );

  const manifest = JSON.parse(readFileSync(join(outDir, "curb.bundle.json"), "utf8"));
  if (typeof manifest.entrypoint !== "string") fail("curb.bundle.json names no entrypoint");

  // Port 0: the runner binds a free port and reports the bound one on its ready line.
  const token = randomBytes(24).toString("hex");
  const runner = startRunner(join(outDir, manifest.entrypoint), outDir, runnerEnv("127.0.0.1:0", token));

  const ready = await phase("runner printed the ready line", async () => {
    const line = await runner.waitForLine(READY_PREFIX, READY_TIMEOUT_MS);
    return expectValid("LifecycleReady", JSON.parse(line.slice(HOSTED_MARKER.length)), "the stdout ready line");
  });
  console.log(`      ${JSON.stringify(ready)}`);
  if (ready.maxSessions !== 1) fail(`maxSessions defaults to 1, the ready line says ${ready.maxSessions}`);
  const base = `http://${ready.address}`;

  await phase("host protocol v1 routes answer to schema", async () => {
    await expectAnswer(base, "GET", "/health", {}, 200, "Health");
    await expectAnswer(base, "GET", "/v1/runner", {}, 401, "ErrorBody", expectError("unauthorized"));
    await expectAnswer(base, "GET", "/v1/runner", { token: `${token}x` }, 401, "ErrorBody", expectError("unauthorized"));
    await expectAnswer(base, "POST", "/v1/sessions", { body: {} }, 401, "ErrorBody", expectError("unauthorized"));
    await expectAnswer(base, "GET", "/v1/runner", { token }, 200, "RunnerStatus", (status, what) => {
      if (status.activeSessions !== 0 || status.draining) fail(`${what}: an idle runner reports ${JSON.stringify(status)}`);
    });
    await expectAnswer(base, "GET", "/v1/sessions", { token }, 200, "SessionList", (list, what) => {
      if (list.sessions.length !== 0) fail(`${what}: an idle runner lists calls`);
    });
    await expectAnswer(base, "GET", "/v1/sessions/nobody", { token }, 404, "ErrorBody", expectError("session_not_found"));
    await expectAnswer(base, "PATCH", "/v1/sessions/nobody", { token, body: { tts: { voice: 17 } } }, 404, "ErrorBody", expectError("session_not_found"));
    await expectAnswer(base, "PATCH", "/v1/sessions/nobody", { token, rawBody: "{not json" }, 400, "ErrorBody", expectError("invalid_request"));
    await expectAnswer(base, "GET", "/v2/runner", { token }, 404, "ErrorBody", (body, what) => {
      expectError("unknown_version")(body, what);
      if (!body.versions?.includes(1)) fail(`${what}: unknown_version does not list version 1`);
    });
    await expectAnswer(base, "GET", "/v1/nowhere", { token }, 404, "ErrorBody", expectError("not_found"));
    await expectAnswer(base, "POST", "/v1/sessions", { token, body: { sessionId: "" } }, 400, "ErrorBody", expectError("invalid_request"));
    await expectAnswer(base, "POST", "/v1/sessions", { token, rawBody: "{not json" }, 400, "ErrorBody", expectError("invalid_request"));
    await expectAnswer(base, "DELETE", "/v1/sessions/nobody?graceMs=soon", { token }, 400, "ErrorBody", expectError("invalid_request"));
    await expectAnswer(base, "DELETE", "/v1/sessions/nobody?reason=smoke", { token }, 202, "StopCallResponse", (body, what) => {
      if (body.stopped !== false) fail(`${what}: stopping an unknown call reports stopped=${body.stopped}`);
    });
    await expectAnswer(base, "GET", "/v1/runner/events?from=-1", { token }, 400, "ErrorBody", expectError("invalid_request"));
  });

  await phase("events stream replays the ready record from 0", async () => {
    const stream = await openEvents(base, token, 0);
    const first = await stream.nextRecord(0, 5_000);
    await stream.cancel();
    if (first.class !== "lifecycle" || first.body.event !== "ready" || first.envelope !== 1) {
      fail(`the first record is not lifecycle ready at envelope 1: ${JSON.stringify(first)}`);
    }
  });

  const endedBy = await phase("SIGTERM drains, ends the stream and exits 0", async () => {
    // Resume AFTER the ready record: `from` is exclusive.
    const stream = await openEvents(base, token, 1);
    runner.child.kill("SIGTERM");
    const exit = await Promise.race([
      runner.exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("the runner did not exit after SIGTERM")), EXIT_TIMEOUT_MS)),
    ]);
    await stream.finished;
    const events = stream.records.map((record) => record.body.event);
    if (events.join(",") !== "draining,ended") {
      fail(`after SIGTERM the stream carried [${events}], expected [draining,ended] then EOF`);
    }
    if (stream.records[0].body.signal !== "SIGTERM") fail("the draining record does not name SIGTERM");
    if (stream.records.some((record, index) => record.envelope !== index + 2)) fail("envelopes are not gapless from 2");
    if (exit.code !== 0) fail(`the runner exited ${exit.code ?? exit.signal}, expected 0:\n${runner.output()}`);
    return stream.endedBy();
  });
  // Reported, not failed: both are EOF to a host, but a closed socket reads as a transport
  // error in many HTTP clients (Go reports unexpected EOF), so a host must treat it as EOF.
  console.log(
    endedBy === "end"
      ? "      the stream ended with a complete chunked response"
      : "      note: the runner closed the socket instead of ending the chunked response",
  );
}

/** Idempotent and synchronous, so it also runs from the process "exit" event. */
let released = false;
function release() {
  if (released) return;
  released = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  if (workDir !== null) {
    if (keep) console.log(`  kept ${workDir}`);
    else rmSync(workDir, { recursive: true, force: true });
  }
}
// A crash path the try below does not see (an uncaught exception) still kills the runner
// and removes the ~175 MB artifact.
process.on("exit", release);

try {
  await main();
  release();
  const total = (performance.now() - startedAt) / 1000;
  console.log(`\nself-host smoke: PASS in ${total.toFixed(1)}s`);
  for (const [name, ms] of timings) console.log(`  ${(ms / 1000).toFixed(1).padStart(6)}s  ${name}`);
} catch (error) {
  release();
  console.error(`\nself-host smoke: FAIL\n  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
