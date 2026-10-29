import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MessageRefusedError, type MessageIssue } from "../messages.js";
import { SettingsRefusedError, type EffectiveSettings } from "../settings-update.js";
import type { HostedCallReporter } from "./call-reporter.js";
import type { HostMessage } from "./protocol.js";
import type { AdoptedCall, CallHandle, SessionRegistry } from "./session-registry.js";

/**
 * The job link: how a LiveKit job process registers its call with the `curb start` process
 * that serves the management port.
 *
 * WHY A LINK. LiveKit's worker runs every job in a CHILD process it forks, so the call (its
 * runtime, its app messages, its settings) lives in one process and the management port in
 * another. The parent opens a local socket in a private temporary directory and names it in
 * {@link JOB_LINK_ENV}; every child inherits the variable and opens one connection per call.
 *
 * ONE CONNECTION PER CALL, newline-delimited JSON both ways. The child reports the call's
 * records (turns, events, agent-to-host messages); the parent forwards the host's requests
 * (message, settings change, stop) and gets each one's answer. The parent's registry owns the
 * reporter, so records keep one sequence per call however many jobs a worker runs.
 *
 * A local socket in a 0700 directory, not a TCP port: only this user's processes can reach it,
 * and nothing about it is exposed beyond the machine.
 */

/** Set by `curb start` for its job processes. Internal: not a setting a project makes. */
export const JOB_LINK_ENV = "CURB_JOB_LINK";

/** How long a job waits for the parent to accept its call before running it unregistered. */
const OPEN_TIMEOUT_MS = 5_000;

/** Registers calls placed on this process (by LiveKit or the preview) with the registry. */
export interface CallRegistrar {
  /** Rejects when the call cannot be registered; it then runs without a management port. */
  open(sessionId: string): Promise<AdoptedCall>;
}

/** The in-process registrar: `curb dev`, where the management port and the call share a process. */
export function localRegistrar(registry: SessionRegistry): CallRegistrar {
  return { open: async (sessionId) => registry.adopt(sessionId) };
}

/** The registrar a job process uses, when its parent serves a management port; else null. */
export function registrarFromEnv(env: NodeJS.ProcessEnv = process.env): CallRegistrar | null {
  const path = env[JOB_LINK_ENV]?.trim();
  return path ? linkRegistrar(path) : null;
}

type Wire = Record<string, unknown> & { t: string };

/** NDJSON framing over a socket. `send` is a no-op once the socket is gone. */
function frame(socket: Socket, onMessage: (message: Wire) => void) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    for (; newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      let message: Wire;
      try {
        message = JSON.parse(line) as Wire;
      } catch {
        // Both ends are this file, so a bad line is a bug; it ends this call's link only.
        socket.destroy(new Error(`the job link received a line that is not JSON: ${line.slice(0, 80)}`));
        return;
      }
      onMessage(message);
    }
  });
  return {
    send(message: Wire): boolean {
      if (socket.destroyed || !socket.writable) return false;
      socket.write(`${JSON.stringify(message)}\n`);
      return true;
    },
  };
}

/** A refusal as it crosses the link. */
type WireError = {
  kind: "message" | "settings" | "error";
  code?: string;
  detail: string;
  path?: string;
  issues?: MessageIssue[];
};

function toWire(error: unknown): WireError {
  if (error instanceof MessageRefusedError) {
    return { kind: "message", code: error.code, detail: stripCode(error.code, error.message), ...(error.issues ? { issues: error.issues } : {}) };
  }
  if (error instanceof SettingsRefusedError) {
    return {
      kind: "settings",
      code: error.code,
      detail: stripCode(error.code, error.message),
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.issues === undefined ? {} : { issues: error.issues }),
    };
  }
  return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
}

function stripCode(code: string, message: string): string {
  return message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message;
}

function fromWire(error: WireError, context: { key?: string }): Error {
  if (error.kind === "message" && error.code !== undefined) {
    return new MessageRefusedError(
      error.code as MessageRefusedError["code"],
      { key: context.key ?? "", from: "host" },
      error.detail,
      error.issues === undefined ? {} : { issues: error.issues },
    );
  }
  if (error.kind === "settings" && error.code !== undefined) {
    return new SettingsRefusedError(error.code as SettingsRefusedError["code"], "host", error.detail, {
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.issues === undefined ? {} : { issues: error.issues }),
    });
  }
  return new Error(error.detail);
}

export interface JobLink {
  /** The socket path, as {@link JOB_LINK_ENV} names it. */
  readonly path: string;
  close(): Promise<void>;
}

/**
 * The parent side: accept job connections and register each call with `registry`.
 * Never throws into a call: a broken connection ends that call's registration only.
 */
export async function startJobLink(
  registry: SessionRegistry,
  options: { log?: (message: string) => void } = {},
): Promise<JobLink> {
  const log = options.log ?? ((message: string) => console.error(message));
  const dir = process.platform === "win32" ? null : mkdtempSync(join(tmpdir(), "curb-jobs-"));
  const path = dir === null ? `\\\\.\\pipe\\curb-jobs-${randomUUID()}` : join(dir, "link.sock");
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serveJob(registry, socket, log);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  // The worker usually ends by signal, inside LiveKit's own handler: the directory goes then.
  const removeDir = () => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
  };
  process.once("exit", removeDir);

  return {
    path,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      process.removeListener("exit", removeDir);
      removeDir();
    },
  };
}

/** One job connection: one call, from `open` until the job ends or goes away. */
function serveJob(registry: SessionRegistry, socket: Socket, log: (message: string) => void): void {
  let call: AdoptedCall | null = null;
  let sessionId = "";
  let connected = false;
  let finished = false;
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; key?: string }>();
  let nextRequest = 0;

  const request = (message: Wire, key?: string) =>
    new Promise<unknown>((resolve, reject) => {
      const rid = String((nextRequest += 1));
      pending.set(rid, { resolve, reject, ...(key === undefined ? {} : { key }) });
      if (!link.send({ ...message, rid })) {
        pending.delete(rid);
        reject(new Error(`call ${sessionId}'s job process is gone`));
      }
    });

  const handle: CallHandle = {
    ended,
    deliver: async (message: HostMessage) => {
      await request({ t: "deliver", message }, message.name);
    },
    update: async (body: unknown) => (await request({ t: "update", body })) as EffectiveSettings,
    close: async (reason: string, graceMs: number) => {
      await request({ t: "close", reason, graceMs });
    },
  };

  const link = frame(socket, (message) => {
    switch (message.t) {
      case "open": {
        sessionId = String(message.sessionId);
        try {
          call = registry.adopt(sessionId);
          link.send({ t: "opened" });
        } catch (error) {
          link.send({ t: "refused", detail: error instanceof Error ? error.message : String(error) });
          socket.end();
        }
        return;
      }
      case "turn":
        call?.reporter.turn(message.turn as Parameters<HostedCallReporter["turn"]>[0]);
        return;
      case "event":
        call?.reporter.event(
          String(message.name),
          message.payload as Record<string, unknown>,
          message.durationMs as number | undefined,
        );
        return;
      case "host":
        call?.reporter.host(message.message as Parameters<HostedCallReporter["host"]>[0]);
        return;
      case "count":
        call?.reporter.count(message.tallies as Parameters<HostedCallReporter["count"]>[0]);
        return;
      case "connected":
        connected = true;
        call?.connected(handle);
        return;
      case "failed":
        finished = true;
        call?.failed(new Error(String(message.detail)));
        return;
      case "ended":
        finished = true;
        resolveEnded();
        return;
      case "result": {
        const waiting = pending.get(String(message.rid));
        if (waiting === undefined) return;
        pending.delete(String(message.rid));
        if (message.ok === true) waiting.resolve(message.value);
        else waiting.reject(fromWire(message.error as WireError, { key: waiting.key }));
        return;
      }
      default:
        log(`curb: job link: unknown message ${JSON.stringify(message.t)} from call ${sessionId}`);
    }
  });

  socket.on("error", (error) => log(`curb: job link for call ${sessionId}: ${error.message}`));
  socket.on("close", () => {
    for (const [rid, waiting] of pending) {
      pending.delete(rid);
      waiting.reject(new Error(`call ${sessionId}'s job process went away`));
    }
    if (finished || call === null) return;
    // The job died without saying how the call ended: it ended.
    if (connected) resolveEnded();
    else call.failed(new Error("the job process went away before the call connected"));
  });
}

/** The child side: one connection per call to the parent's link. */
export function linkRegistrar(path: string): CallRegistrar {
  return {
    open: (sessionId) =>
      new Promise<AdoptedCall>((resolve, reject) => {
        const socket = connect(path);
        let undelivered = 0;
        let handle: CallHandle | null = null;
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`the management process did not accept call ${sessionId} within ${OPEN_TIMEOUT_MS} ms`));
        }, OPEN_TIMEOUT_MS);

        const record = (message: Wire): boolean => {
          if (link.send(message)) return true;
          undelivered += 1;
          return false;
        };
        const reporter: HostedCallReporter = {
          turn: (turn) => void record({ t: "turn", turn }),
          event: (name, payload, durationMs) =>
            void record({ t: "event", name, payload, ...(durationMs === undefined ? {} : { durationMs }) }),
          host: (message) => record({ t: "host", message }),
          count: (tallies) => void record({ t: "count", tallies }),
          // The parent's registry writes the terminal record when the call leaves it.
          finish: async () => {},
          journaled: true,
          get undelivered() {
            return undelivered;
          },
        };

        const answer = (rid: unknown, run: () => Promise<unknown>) => {
          run().then(
            (value) => link.send({ t: "result", rid, ok: true, ...(value === undefined ? {} : { value }) }),
            (error: unknown) => link.send({ t: "result", rid, ok: false, error: toWire(error) }),
          );
        };

        const link = frame(socket, (message) => {
          switch (message.t) {
            case "opened":
              clearTimeout(timer);
              resolve({
                reporter,
                connected: (live) => {
                  handle = live;
                  link.send({ t: "connected" });
                  void live.ended.finally(() => {
                    link.send({ t: "ended" });
                    socket.end();
                  });
                },
                failed: (error) => {
                  link.send({ t: "failed", detail: error instanceof Error ? error.message : String(error) });
                  socket.end();
                },
              });
              return;
            case "refused":
              clearTimeout(timer);
              reject(new Error(String(message.detail)));
              return;
            case "deliver":
              answer(message.rid, async () => handle?.deliver(message.message as HostMessage));
              return;
            case "update":
              answer(message.rid, async () => {
                if (handle === null) throw new Error("the call has not connected yet");
                return handle.update(message.body);
              });
              return;
            case "close":
              answer(message.rid, async () => handle?.close(String(message.reason), Number(message.graceMs)));
              return;
          }
        });
        socket.once("connect", () => link.send({ t: "open", sessionId }));
        socket.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      }),
  };
}
