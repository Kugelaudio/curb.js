import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { DeliverOutcome, SessionRegistry, StartOutcome, UpdateOutcome } from "./session-registry.js";
import { CursorTooOldError, type EventJournal } from "./event-journal.js";
import type { HookRuns, HookStartOutcome } from "./hook-runs.js";
import { isHookName } from "../hooks.js";
import {
  HookRunRequest,
  HostMessage,
  MAX_STOP_GRACE_MS,
  PROTOCOL_VERSION,
  StartCallRequest,
  SUPPORTED_VERSIONS,
  type DrainResponse,
  type ErrorBody,
  type ErrorCode,
  type Health,
  type HookRunResponse,
  type HostMessageResponse,
  type SessionList,
  type SessionUpdateResponse,
  type StartCallResponse,
  type StopCallResponse,
} from "./protocol.js";

/**
 * How a host starts, inspects and ends the calls on this runner, and reads everything it
 * has to say. The shapes are the host protocol in `protocol.ts`.
 *
 * PER RUNNER, not per call: `ready` and `draining` belong to the runner, and one port
 * serves every call on it.
 *
 * A PER-RUNNER BEARER TOKEN. A fleet-wide token would let one compromised runner replay it
 * against every other; a per-runner one discloses nothing beyond the runner that holds it.
 *
 * IT MUST NEVER TAKE DOWN A CALL. Every handler failure becomes a 500 and a log line, and a
 * listener that cannot be opened leaves the calls running without one.
 */

/** The address to listen on, `host:port`. Absent means this process is not managed. */
export const MANAGEMENT_ADDRESS_ENV = "CURB_MANAGEMENT_ADDR";

/**
 * The per-runner bearer token every route but `/health` requires. Absent is REFUSED, not
 * "no auth": an unauthenticated port admits anything that can reach it.
 */
export const MANAGEMENT_TOKEN_ENV = "CURB_MANAGEMENT_TOKEN";

/**
 * The protocol version is IN THE PATH. Host and runner are deployed on separate schedules;
 * in the path a mismatch is a 404 naming the versions, in a header it would be a 200 with a
 * body of the wrong shape.
 */
const PREFIX = `/v${PROTOCOL_VERSION}`;

/**
 * How often an idle events stream proves it is alive. A reader's deadline should be a
 * comfortable multiple of this.
 */
const HEARTBEAT_MS = 15_000;

/** Why a stop that names no reason ended. */
const DEFAULT_STOP_REASON = "host_stop";

/**
 * The most `POST /v1/hooks/{name}` reads: an event carries a transcript of up to 1 MiB in
 * JSON, whose escaping can double it. Every other route stays at the far smaller
 * {@link readBody} bound.
 */
export const MAX_HOOK_BODY_BYTES = 2 * 1024 * 1024;

export interface ManagementServer {
  readonly address: string;
  close(): Promise<void>;
}

/** The token as the environment states it, trimmed; "" when unset. */
export function managementTokenFrom(env: NodeJS.ProcessEnv = process.env): string {
  return (env[MANAGEMENT_TOKEN_ENV] ?? "").trim();
}

export interface ManagementServerOptions {
  /** `host:port`. Defaults to the environment. */
  address?: string;
  /** The per-runner bearer token. Defaults to the environment. */
  token?: string;
  /** The stream `GET /v1/runner/events` serves. Absent means that route answers 503. */
  journal?: EventJournal;
  /** Makes this a hook runner. Absent means the hook routes answer 501. */
  hooks?: HookRuns;
  /** How often an idle stream pings. Injected so a test need not wait the real interval. */
  heartbeatMs?: number;
  log?: (message: string) => void;
}

/**
 * `registry` is NULL for a runner that takes no calls over the wire: a runner handed its
 * one call at start serves the events stream and refuses the session routes, rather than
 * advertising a way to start a second call in a process built for one.
 *
 * A registry that places no calls (`curb start`, `curb dev`: LiveKit or the preview places
 * them) serves every route about the calls it runs and refuses the placement routes
 * (`POST /v1/sessions`, `GET /v1/runner`, `POST /v1/runner/drain`) with 501.
 *
 * A hook runner (`options.hooks`) is managed like any runner and takes no calls: it serves the
 * hook routes, `GET /v1/runner` and `POST /v1/runner/drain`, and refuses `POST /v1/sessions`.
 */
export async function startManagementServer(
  registry: SessionRegistry | null,
  options: ManagementServerOptions = {},
): Promise<ManagementServer | null> {
  const log = options.log ?? ((message: string) => console.error(message));
  const address = (options.address ?? process.env[MANAGEMENT_ADDRESS_ENV] ?? "").trim();
  if (address === "") return null;

  const token = options.token === undefined ? managementTokenFrom() : options.token.trim();
  if (token === "") {
    log(
      `curb: refusing to open the management port without ${MANAGEMENT_TOKEN_ENV}; the ` +
        `token is the only thing authorizing a caller.`,
    );
    return null;
  }

  const parsed = parseAddress(address);
  if (parsed === null) {
    log(
      `curb: cannot read ${MANAGEMENT_ADDRESS_ENV}=${address} as a host:port. ` +
        `Use for example 0.0.0.0:7071.`,
    );
    return null;
  }

  const streams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    void handle(
      registry,
      request,
      response,
      log,
      token,
      options.journal,
      options.hooks,
      options.heartbeatMs ?? HEARTBEAT_MS,
      streams,
    );
  });

  try {
    await listen(server, parsed.host, parsed.port);
  } catch (error) {
    log(`curb: cannot listen on ${address}: ${describe(error)}`);
    return null;
  }

  // What was BOUND, not what was asked for: port 0 means "any free port".
  const bound = server.address();
  const boundAddress =
    bound !== null && typeof bound === "object" ? `${parsed.host}:${bound.port}` : address;

  return {
    address: boundAddress,
    close: async () => {
      // END every events stream before dropping sockets: `end()` flushes what is still
      // buffered (the terminal `ended` record, written just before close) and terminates
      // the chunked body, so a reader sees the record and then a clean EOF. Destroying the
      // socket first would drop it, and a clean shutdown would read as a truncated stream.
      await endStreams(streams, STREAM_END_TIMEOUT_MS);
      await new Promise<void>((resolve) => {
        // Whatever is still open (a reader that never drained) is cut here; `close` waits
        // for every open connection otherwise.
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

/** How long a clean shutdown waits for readers to receive the end of their stream. */
const STREAM_END_TIMEOUT_MS = 2_000;

function endStreams(streams: Set<ServerResponse>, timeoutMs: number): Promise<void> {
  const ending = [...streams].map(
    (response) =>
      new Promise<void>((resolve) => {
        if (response.writableFinished || response.destroyed) {
          resolve();
          return;
        }
        response.once("finish", () => resolve());
        response.once("close", () => resolve());
        response.end();
      }),
  );
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.all(ending).then(() => undefined), deadline]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * `host:port`, with the host required so nothing binds a wildcard by accident. Port 0 is
 * allowed and means "any free port"; the bound one is reported.
 */
function parseAddress(address: string): { host: string; port: number } | null {
  const at = address.lastIndexOf(":");
  if (at <= 0) return null;
  const host = address.slice(0, at);
  const port = Number(address.slice(at + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return { host, port };
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

async function handle(
  registry: SessionRegistry | null,
  request: IncomingMessage,
  response: ServerResponse,
  log: (message: string) => void,
  token: string,
  journal: EventJournal | undefined,
  hooks: HookRuns | undefined,
  heartbeatMs: number,
  streams: Set<ServerResponse>,
): Promise<void> {
  // The base is a placeholder; the Host header is caller-controlled and nothing routes on it.
  const url = new URL(request.url ?? "/", "http://curb.local");
  const method = request.method ?? "GET";

  // The one unversioned route: a client that guessed the prefix wrong must still be able to
  // read which versions exist.
  if (url.pathname === "/health") {
    const health: Health = {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      versions: SUPPORTED_VERSIONS,
    };
    send(response, 200, health);
    return;
  }

  // Checked BEFORE the version, so an unauthenticated caller learns nothing about which
  // routes exist. Absent and wrong tokens answer identically.
  if (!authorized(request, token)) {
    fail(response, 401, "unauthorized");
    return;
  }

  if (!url.pathname.startsWith(`${PREFIX}/`)) {
    fail(response, 404, "unknown_version", {
      detail: `unknown API version in ${url.pathname}; this runner speaks ${PREFIX}`,
      versions: SUPPORTED_VERSIONS,
    });
    return;
  }
  const route = url.pathname.slice(PREFIX.length);

  try {
    if (method === "GET" && route === "/runner/events") {
      streamEvents(url, response, journal, log, heartbeatMs, streams);
      return;
    }
    // Before the call routes, so a runner with no registry still answers as one taking no hooks.
    const hookRunId = method === "GET" ? hookRunRoute(route) : null;
    const hookName = method === "POST" ? hookRoute(route) : null;
    if (hookRunId !== null || hookName !== null) {
      if (hooks === undefined) {
        fail(response, 501, "runner_takes_no_hooks", {
          detail: "this runner takes calls; start one with CURB_RUNNER_ROLE=hooks to run hooks",
        });
      } else if (hookRunId !== null) {
        readHookRun(hooks, hookRunId, response);
      } else if (hookName !== null) {
        await startHook(hooks, hookName, request, response);
      }
      return;
    }
    // Everything past here drives calls. A runner handed its call at start has none of it,
    // and says so rather than 404-ing as though the route were misspelled.
    if (registry === null) {
      fail(response, 501, "runner_takes_no_calls", {
        detail: "this runner was handed its call at start and serves only /v1/runner/events",
      });
      return;
    }
    const managing =
      (method === "GET" && route === "/runner") || (method === "POST" && route === "/runner/drain");
    const placing = method === "POST" && route === "/sessions";
    if ((managing && !registry.managed) || (placing && !registry.placesCalls)) {
      fail(response, 501, "runner_takes_no_calls", {
        detail: registry.managed
          ? "this is a hook runner; place calls on a runner started without a hook role"
          : "LiveKit dispatch places the calls on this process; the host can list, message, " +
            "adjust and end them, but not place, count or drain them",
      });
      return;
    }
    if (method === "GET" && route === "/runner") {
      send(response, 200, registry.status());
      return;
    }
    if (method === "GET" && route === "/sessions") {
      const list: SessionList = { sessions: registry.list() };
      send(response, 200, list);
      return;
    }
    if (method === "POST" && route === "/runner/drain") {
      // Answered at once, not when the last call ends: draining can take the length of a
      // conversation.
      void registry.drain();
      const drained: DrainResponse = {
        draining: true,
        activeSessions: registry.status().activeSessions,
      };
      send(response, 202, drained);
      return;
    }
    if (method === "POST" && route === "/sessions") {
      await startSession(registry, request, response);
      return;
    }
    const messagesFor = messagesRoute(route);
    if (messagesFor !== null && method === "POST") {
      await deliverMessage(registry, messagesFor, request, response);
      return;
    }
    const sessionId = sessionRoute(route);
    if (sessionId !== null && method === "GET") {
      const call = registry.get(sessionId);
      if (call === null) {
        fail(response, 404, "session_not_found", { detail: `no such call: ${sessionId}` });
        return;
      }
      send(response, 200, call);
      return;
    }
    if (sessionId !== null && method === "PATCH") {
      await updateSession(registry, sessionId, request, response);
      return;
    }
    if (sessionId !== null && method === "DELETE") {
      const graceMs = parseGraceMs(url.searchParams.get("graceMs"));
      if (graceMs === null) {
        fail(response, 400, "invalid_request", {
          detail: `graceMs must be an integer from 0 to ${MAX_STOP_GRACE_MS}`,
        });
        return;
      }
      const reason = url.searchParams.get("reason") || DEFAULT_STOP_REASON;
      const stopped = await registry.stop(sessionId, reason, graceMs);
      // 202 either way: a stop is retried, and a second must not turn a completed teardown
      // into an error.
      const body: StopCallResponse = { sessionId, stopped };
      send(response, 202, body);
      return;
    }
    fail(response, 404, "not_found", { detail: `no such route: ${method} ${url.pathname}` });
  } catch (error) {
    // A handler that threw is a runner bug, reported as one. It must not reach the server's
    // error event, which would take the process, and every live call, down.
    log(`curb: management request ${method} ${url.pathname} failed: ${describe(error)}`);
    fail(response, 500, "internal", { detail: describe(error) });
  }
}

/** The id in `/sessions/{id}`, or null for any other route (including deeper paths). */
function sessionRoute(route: string): string | null {
  return lastSegment(route, "/sessions/");
}

/** The one decoded path segment after `prefix`, or null when `route` is anything else. */
function lastSegment(route: string, prefix: string): string | null {
  if (!route.startsWith(prefix)) return null;
  const encoded = route.slice(prefix.length);
  if (encoded === "" || encoded.includes("/")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null; // a malformed escape names nothing
  }
}

/** The id in `/sessions/{id}/messages`, or null for any other route. */
function messagesRoute(route: string): string | null {
  const suffix = "/messages";
  if (!route.endsWith(suffix)) return null;
  return sessionRoute(route.slice(0, -suffix.length));
}

/** The name in `/hooks/{name}`, or null for any other route. */
function hookRoute(route: string): string | null {
  return lastSegment(route, "/hooks/");
}

/** The id in `/hooks/runs/{id}`, or null for any other route. */
function hookRunRoute(route: string): string | null {
  return lastSegment(route, "/hooks/runs/");
}

/** `graceMs` from the query: absent is 0, anything but an integer in range is null. */
function parseGraceMs(raw: string | null): number | null {
  if (raw === null) return 0;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value <= MAX_STOP_GRACE_MS ? value : null;
}

/**
 * Whether this request carries the runner's token. Constant-time, because a short-circuiting
 * compare leaks the token a byte at a time; lengths are compared first because
 * `timingSafeEqual` throws on a mismatch, and the length is not the secret.
 */
function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/**
 * Follow this runner's journal as newline-delimited JSON until the caller goes away.
 *
 * Backpressure is deliberately NOT awaited. `write` returning false means the reader is
 * behind; the journal keeps taking records and the cursor catches it up on the next
 * connection. No reader is worth blocking a conversation on.
 */
function streamEvents(
  url: URL,
  response: ServerResponse,
  journal: EventJournal | undefined,
  log: (message: string) => void,
  heartbeatMs: number,
  streams: Set<ServerResponse>,
): void {
  if (journal === undefined) {
    fail(response, 503, "no_journal", { detail: "this runner keeps no journal" });
    return;
  }

  const raw = url.searchParams.get("from") ?? "0";
  const from = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(from)) {
    fail(response, 400, "invalid_request", {
      detail: `from must be a non-negative integer, got ${raw}`,
    });
    return;
  }

  // SUBSCRIBE BEFORE WRITING HEADERS. `subscribe` validates the cursor and throws before it
  // delivers anything, which is what leaves the 410 answerable at all. The replay arrives
  // before the headers are out, so it is buffered and flushed after them.
  let streaming = false;
  const replayed: string[] = [];
  let unsubscribe: () => void;
  try {
    unsubscribe = journal.subscribe(from, (record) => {
      const line = `${JSON.stringify(record)}\n`;
      if (streaming) response.write(line);
      else replayed.push(line);
    });
  } catch (error) {
    if (error instanceof CursorTooOldError) {
      // The records between the cursor and the buffer are gone; the reader must be able to
      // say so rather than resume into a hole that looks seamless.
      fail(response, 410, "cursor_too_old", {
        detail: error.message,
        requested: error.requested,
        oldestRetained: error.oldestRetained,
      });
      return;
    }
    throw error;
  }

  response.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-store",
    // Chunked, so a proxy does not turn a live stream into one delivery at the end.
    "transfer-encoding": "chunked",
  });
  response.flushHeaders();
  streaming = true;
  for (const line of replayed) response.write(line);

  // KEEPALIVE, NOT A JOURNAL RECORD. It is written straight to the socket and carries no
  // envelope: a ping that entered the bounded replay buffer would evict conversation records
  // on an idle runner, and a reader skips it without advancing its cursor.
  const heartbeat = setInterval(() => {
    response.write(`${JSON.stringify({ ping: Date.now() })}\n`);
  }, heartbeatMs);
  heartbeat.unref?.();

  streams.add(response);
  let attached = true;
  const stop = (): void => {
    if (!attached) return;
    attached = false;
    clearInterval(heartbeat);
    unsubscribe();
    streams.delete(response);
  };
  // Both, because a dropped connection surfaces as one or the other.
  response.on("close", stop);
  response.on("error", (error: unknown) => {
    stop();
    log(`curb: an events subscriber disconnected: ${describe(error)}`);
  });
}

async function startSession(
  registry: SessionRegistry,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    fail(response, 400, "invalid_request", { detail: `the body is not JSON: ${describe(error)}` });
    return;
  }

  const parsed = StartCallRequest.safeParse(body);
  if (!parsed.success) {
    // Every field named individually: an omitted token and an omitted room are different
    // bugs on the host.
    fail(response, 400, "invalid_request", { detail: describeIssues(parsed.error.issues) });
    return;
  }

  const outcome = await registry.start(parsed.data);
  if (outcome.ok) {
    const started: StartCallResponse = {
      sessionId: outcome.sessionId,
      accepted: outcome.accepted,
    };
    send(response, 202, started);
    return;
  }
  fail(response, statusFor(outcome.code), outcome.code, { detail: outcome.detail });
}

function describeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.map(String).join(".") || "(body)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Takes one hook run and answers before it ends: a run takes as long as the customer's code does,
 * and a host that loses this connection must be able to pick the run up by its id.
 */
async function startHook(
  hooks: HookRuns,
  name: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!isHookName(name)) {
    fail(response, 404, "hook_not_declared", { detail: `no hook is named ${name}` });
    return;
  }
  let text: string;
  try {
    text = await readHookBody(request);
  } catch (error) {
    if (!(error instanceof HookBodyTooLargeError)) throw error;
    fail(response, 413, "payload_too_large", { detail: error.message });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    fail(response, 400, "invalid_request", { detail: `the body is not JSON: ${describe(error)}` });
    return;
  }
  const parsed = HookRunRequest.safeParse(body);
  if (!parsed.success) {
    fail(response, 400, "invalid_request", { detail: describeIssues(parsed.error.issues) });
    return;
  }
  // The event as it arrived, not as parsed: parsing drops the fields this build does not know,
  // and a hook receives everything a webhook would.
  const event = (body as Pick<HookRunRequest, "event">).event;
  const outcome = hooks.start(name, { ...parsed.data, event });
  if (!outcome.ok) {
    fail(response, hookStartStatus(outcome.code), outcome.code, { detail: outcome.detail });
    return;
  }
  const accepted: HookRunResponse = { runId: outcome.runId, accepted: true };
  send(response, 202, accepted);
}

function readHookRun(hooks: HookRuns, runId: string, response: ServerResponse): void {
  const status = hooks.status(runId);
  if (status === null) {
    fail(response, 404, "hook_run_not_found", { detail: `no such run: ${runId}` });
    return;
  }
  send(response, 200, status);
}

function hookStartStatus(code: Extract<HookStartOutcome, { ok: false }>["code"]): number {
  switch (code) {
    case "invalid_request":
      return 400;
    case "hook_not_declared":
      return 404;
    case "runner_draining":
      return 503;
  }
}

async function deliverMessage(
  registry: SessionRegistry,
  sessionId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    fail(response, 400, "invalid_request", { detail: `the body is not JSON: ${describe(error)}` });
    return;
  }
  const parsed = HostMessage.safeParse(body);
  if (!parsed.success) {
    fail(response, 400, "invalid_request", { detail: describeIssues(parsed.error.issues) });
    return;
  }

  // Answered once the agent's handlers settled, so a refusal reaches the host as a code.
  const outcome = await registry.deliver(sessionId, parsed.data);
  if (!outcome.ok) {
    fail(response, deliverStatus(outcome.code), outcome.code, {
      detail: outcome.detail,
      ...(outcome.issues === undefined ? {} : { issues: outcome.issues }),
    });
    return;
  }
  const answer: HostMessageResponse = { id: parsed.data.id, delivered: outcome.delivered };
  send(response, 202, answer);
}

async function updateSession(
  registry: SessionRegistry,
  sessionId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    fail(response, 400, "invalid_request", { detail: `the body is not JSON: ${describe(error)}` });
    return;
  }
  // The agent checks the body itself (shape, gate, values), so a host and a client app are
  // judged by one set of rules.
  const outcome = await registry.update(sessionId, body);
  if (!outcome.ok) {
    fail(response, updateStatus(outcome.code), outcome.code, {
      detail: outcome.detail,
      ...(outcome.path === undefined ? {} : { path: outcome.path }),
      ...(outcome.issues === undefined ? {} : { issues: outcome.issues }),
    });
    return;
  }
  const answer: SessionUpdateResponse = { sessionId, settings: outcome.settings };
  send(response, 200, answer);
}

function updateStatus(code: Extract<UpdateOutcome, { ok: false }>["code"]): number {
  switch (code) {
    case "session_not_found":
      return 404;
    case "not_adjustable":
      return 403;
    case "invalid_settings":
      return 422;
  }
}

function deliverStatus(code: Extract<DeliverOutcome, { ok: false }>["code"]): number {
  switch (code) {
    case "session_not_found":
      return 404;
    case "runner_at_capacity":
      return 409;
    // The call is there and took the request; its agent refused this message.
    case "no_handler":
    case "invalid_payload":
    case "handler_failed":
      return 422;
  }
}

function statusFor(code: Extract<StartOutcome, { ok: false }>["code"]): number {
  switch (code) {
    case "runner_draining":
      // "Place this call on another runner", distinct from 409's "this runner cannot take it".
      return 503;
    case "start_failed":
      return 500;
    case "runner_at_capacity":
    case "generation_mismatch":
      return 409;
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // A start payload is a few hundred bytes. Bounded so a hostile body cannot grow the
      // heap of a process serving live calls.
      if (size > 64 * 1024) {
        reject(new Error("the request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

class HookBodyTooLargeError extends Error {
  constructor() {
    super(`the body is over the ${MAX_HOOK_BODY_BYTES} bytes this route reads`);
  }
}

/**
 * The body of a hook request, or {@link HookBodyTooLargeError}. An oversized body is read to its
 * end and dropped, so the client is answered with the 413 rather than a reset in mid-write.
 */
function readHookBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HOOK_BODY_BYTES) chunks.length = 0;
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_HOOK_BODY_BYTES) reject(new HookBodyTooLargeError());
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function fail(
  response: ServerResponse,
  status: number,
  error: ErrorCode,
  extra: Omit<ErrorBody, "error"> = {},
): void {
  const body: ErrorBody = { error, ...extra };
  send(response, status, body);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(encoded.length),
  });
  response.end(encoded);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
