import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Room } from "@livekit/rtc-node";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Agent, AgentSiteRuntime, Text, useSession } from "../index.js";
import { AgentSession, type AgentLlmClient } from "../agent-session.js";
import { azure, kugelaudio } from "../providers.js";
import type { VoiceAgentBundle } from "../voice-host.js";
import type { VoiceSessionHandle } from "../server/voice/orchestration.js";
import { AppMessages } from "../messages.js";
import { SessionSettings } from "../session-settings.js";
import {
  HOSTED_MARKER,
  joinRoomAndServe,
  type DirectJoinConfig,
  type DirectJoinSession,
  type JoinSeams,
  type WarmVoiceRunner,
} from "../bundler/direct-join.js";
import { MAX_SESSIONS_VAR, readManagedConfig, runManaged } from "../bundler/managed-runner.js";
import { MANAGEMENT_ADDRESS_ENV, MANAGEMENT_TOKEN_ENV } from "./management-server.js";
import { createCallScratch } from "./call-scratch.js";

/**
 * Several calls of one deployment in ONE runner process: what each call may see of itself,
 * and what it must never see of the call next to it.
 *
 * The room and the voice pipeline are stand-ins (the suite is hermetic); the management
 * port, the registry, the join path, the agent runtime and the scratch directories are real.
 */

const TOKEN = "multi-call-test-token";

/** Every scratch directory in this file is created here, and the whole tree goes at the end. */
const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), "curb-multi-call-test-"));
afterAll(() => rmSync(SCRATCH_ROOT, { recursive: true, force: true }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// --- an agent that renders what it knows about its call -------------------------------------

function CallProbe() {
  const { call } = useSession();
  return <Text>{call ? `call ${call.sessionId} scratch ${call.scratchDir ?? "none"}` : "no call"}</Text>;
}

function probeRuntime(): AgentSiteRuntime {
  return new AgentSiteRuntime(() => (
    <Agent>
      <CallProbe />
    </Agent>
  ));
}

/** What the agent rendered about its call, read from the context the model is given. */
function renderedCall(runtime: AgentSiteRuntime): { sessionId: string; scratchDir: string } | null {
  const match = /call (\S+) scratch (\S+)/.exec(runtime.snapshot().stateSnapshot.join("\n"));
  return match ? { sessionId: match[1]!, scratchDir: match[2]! } : null;
}

function bundleOf(runtime: AgentSiteRuntime): VoiceAgentBundle {
  return {
    runtime,
    session: new AgentSession(runtime, vi.fn<AgentLlmClient>()),
    agentId: "probe",
    definition: { firstTurn: "agent" },
  } as unknown as VoiceAgentBundle;
}

/** Seams for a join whose room and voice pipeline are stand-ins. */
function standInSeams(options: { scratchRoot?: string; startFails?: boolean } = {}): JoinSeams {
  let rooms = 0;
  return {
    createRoom: () =>
      ({
        name: `room-${++rooms}`,
        connect: async () => undefined,
        disconnect: async () => undefined,
      }) as unknown as Room,
    buildProviders: async () =>
      ({ stt: { close: async () => {} }, tts: { close: async () => {} } }) as never,
    startVoiceAgent: async (start) => {
      if (options.startFails) throw new Error("no STT key");
      // Closing the handle is what a stop from the management port does.
      return { close: async () => start.onClosed?.() } as unknown as VoiceSessionHandle;
    },
    scratchRoot: options.scratchRoot ?? SCRATCH_ROOT,
  };
}

function quiet() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

// --- the scratch directory itself ----------------------------------------------------------

describe("a call's scratch directory", () => {
  it("is private to its owner and removed exactly once, however often removal is asked", async () => {
    const scratch = await createCallScratch({ root: SCRATCH_ROOT });
    expect(statSync(scratch.dir).mode & 0o777).toBe(0o700);
    writeFileSync(join(scratch.dir, "note.txt"), "left behind");

    await Promise.all([scratch.remove(), scratch.remove()]);
    await scratch.remove();
    expect(existsSync(scratch.dir)).toBe(false);
  });

  it("names TMPDIR when it cannot be created", async () => {
    await expect(createCallScratch({ root: join(SCRATCH_ROOT, "does-not-exist") })).rejects.toThrow(/TMPDIR/);
  });
});

// --- the call's identity, as its agent sees it --------------------------------------------

describe("useSession().call", () => {
  it("is absent until a call is bound, and a runtime is bound to one call only", () => {
    const runtime = probeRuntime();
    expect(runtime.snapshot().stateSnapshot.join("\n")).toContain("no call");

    runtime.bindCall({ sessionId: "s1", scratchDir: "/scratch/one" });
    expect(renderedCall(runtime)).toEqual({ sessionId: "s1", scratchDir: "/scratch/one" });

    // A second binding would hand one call's identity to another call's conversation.
    expect(() => runtime.bindCall({ sessionId: "s2" })).toThrow(/already serves call s1/);
    expect(renderedCall(runtime)?.sessionId).toBe("s1");
  });
});

describe("joinRoomAndServe and the call's scratch directory", () => {
  it("binds the call's id and its own directory, and removes the directory when the call ends", async () => {
    quiet();
    const runtime = probeRuntime();
    const session = await joinRoomAndServe(
      { url: "ws://realtime", token: "jwt", sessionId: "sess-1" },
      { ...standInSeams(), createBundle: async () => bundleOf(runtime) },
    );
    const seen = renderedCall(runtime)!;
    expect(seen.sessionId).toBe("sess-1");
    expect(existsSync(seen.scratchDir)).toBe(true);

    await session.handle.close();
    await session.ended;
    expect(existsSync(seen.scratchDir)).toBe(false);
  });

  it("removes the directory when the voice session fails to start", async () => {
    quiet();
    const root = mkdtempSync(join(SCRATCH_ROOT, "failed-start-"));
    await expect(
      joinRoomAndServe(
        { url: "ws://realtime", token: "jwt", sessionId: "sess-1" },
        { ...standInSeams({ scratchRoot: root, startFails: true }), createBundle: async () => bundleOf(probeRuntime()) },
      ),
    ).rejects.toThrow(/voice session failed to start/);
    expect(readdirSync(root)).toEqual([]);
  });

  it("runs the call without one, and says why, when none can be created", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const runtime = probeRuntime();
    const session = await joinRoomAndServe(
      { url: "ws://realtime", token: "jwt", sessionId: "sess-1" },
      {
        ...standInSeams({ scratchRoot: join(SCRATCH_ROOT, "missing") }),
        createBundle: async () => bundleOf(runtime),
      },
    );
    expect(renderedCall(runtime)).toEqual({ sessionId: "sess-1", scratchDir: "none" });
    expect(errors.mock.calls.map((call) => call.join(" ")).join("\n")).toMatch(
      /call room-1 runs without a scratch directory: .*TMPDIR/,
    );
    await session.handle.close();
    await session.ended;
  });
});

// --- one managed runner, several calls -----------------------------------------------------

function http(
  address: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: address.split(":")[0],
        port: Number(address.split(":")[1]),
        path,
        method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function readyLine(log: ReturnType<typeof vi.spyOn>): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const line = log.mock.calls
      .map((args: unknown[]) => String(args[0]))
      .find((text: string) => text.startsWith(`${HOSTED_MARKER} {"event":"ready"`));
    if (line) return JSON.parse(line.slice(HOSTED_MARKER.length + 1)) as Record<string, unknown>;
    if (Date.now() > deadline) throw new Error("the runner never said ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const start = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId,
  realtimeUrl: "wss://rooms.invalid",
  realtimeToken: `token-${sessionId}`,
  ...extra,
});

describe("one managed runner serving several calls", () => {
  it("gives each call its own id and scratch directory, and removes each one as its call ends", async () => {
    vi.stubEnv(MANAGEMENT_TOKEN_ENV, TOKEN);
    const log = quiet();
    const runtimes: AgentSiteRuntime[] = [];
    const warm: WarmVoiceRunner = {
      definition: { firstTurn: "agent" } as WarmVoiceRunner["definition"],
      settings: { stt: azure.stt(), tts: kugelaudio.tts() },
      vad: {} as WarmVoiceRunner["vad"],
      takeBundle: async () => {
        const runtime = probeRuntime();
        runtimes.push(runtime);
        return bundleOf(runtime);
      },
    };
    const seams = standInSeams();
    const running = runManaged(
      { address: "127.0.0.1:0", maxSessions: 2 },
      { warm: async () => warm, join: (config: DirectJoinConfig) => joinRoomAndServe(config, seams) },
    );
    const address = String((await readyLine(log)).address);

    const [first, second] = await Promise.all([
      http(address, "/v1/sessions", "POST", start("s1")),
      http(address, "/v1/sessions", "POST", start("s2")),
    ]);
    expect([first.status, second.status]).toEqual([202, 202]);

    const calls = new Map(runtimes.map((runtime) => [renderedCall(runtime)!.sessionId, renderedCall(runtime)!]));
    expect([...calls.keys()].sort()).toEqual(["s1", "s2"]);
    const one = calls.get("s1")!.scratchDir;
    const two = calls.get("s2")!.scratchDir;
    expect(one).not.toBe(two);

    // What one call writes is not in the other's directory.
    writeFileSync(join(one, "s1-only.txt"), "for s1");
    expect(readdirSync(two)).toEqual([]);

    // A stop answers once the call has left the runner, and by then its directory is gone.
    expect((await http(address, "/v1/sessions/s1", "DELETE")).status).toBe(202);
    expect(existsSync(one)).toBe(false);
    expect(existsSync(two)).toBe(true);
    const status = JSON.parse((await http(address, "/v1/runner")).body) as { sessions: Array<{ sessionId: string }> };
    expect(status.sessions.map((call) => call.sessionId)).toEqual(["s2"]);

    expect((await http(address, "/v1/sessions/s2", "DELETE")).status).toBe(202);
    expect(existsSync(two)).toBe(false);
    expect((await http(address, "/v1/runner/drain", "POST")).status).toBe(202);
    await running;
  });

  it("takes exactly the CURB_MAX_SESSIONS it booted with, and refuses the next and a foreign deployment", async () => {
    vi.stubEnv(MANAGEMENT_TOKEN_ENV, TOKEN);
    const log = quiet();
    // The environment as the runner boots with it, read once, the way the generated entry does.
    const config = readManagedConfig({
      [MANAGEMENT_ADDRESS_ENV]: "127.0.0.1:0",
      [MAX_SESSIONS_VAR]: "3",
      CURB_DEPLOYMENT_ID: "dep-a",
    })!;
    const join = vi.fn(async (call: DirectJoinConfig): Promise<DirectJoinSession> => {
      let end!: () => void;
      const ended = new Promise<void>((resolve) => {
        end = resolve;
      });
      return {
        room: {} as Room,
        roomName: `room-${call.sessionId}`,
        ended,
        messages: new AppMessages(),
        settings: new SessionSettings(),
        handle: { close: async () => end() } as unknown as VoiceSessionHandle,
      };
    });
    const running = runManaged(config, {
      warm: async () => ({}) as WarmVoiceRunner,
      join,
    });
    const ready = await readyLine(log);
    expect(ready.maxSessions).toBe(3);
    const address = String(ready.address);

    const accepted = await Promise.all(
      ["s1", "s2", "s3"].map((id) => http(address, "/v1/sessions", "POST", start(id, { deploymentId: "dep-a" }))),
    );
    expect(accepted.map((answer) => answer.status)).toEqual([202, 202, 202]);

    const full = await http(address, "/v1/sessions", "POST", start("s4"));
    expect(full.status).toBe(409);
    expect(JSON.parse(full.body)).toMatchObject({ error: "runner_at_capacity" });

    // Fixed at boot: a restored snapshot whose environment now says otherwise still takes 3.
    vi.stubEnv(MAX_SESSIONS_VAR, "10");
    expect((await http(address, "/v1/sessions", "POST", start("s5"))).status).toBe(409);
    expect(JSON.parse((await http(address, "/v1/runner")).body)).toMatchObject({
      deploymentId: "dep-a",
      maxSessions: 3,
      activeSessions: 3,
    });

    // A freed slot takes the next call of THIS deployment, never one pinned to another.
    expect((await http(address, "/v1/sessions/s1", "DELETE")).status).toBe(202);
    const foreign = await http(address, "/v1/sessions", "POST", start("s6", { deploymentId: "dep-b" }));
    expect(foreign.status).toBe(409);
    expect(JSON.parse(foreign.body)).toMatchObject({ error: "generation_mismatch" });
    expect((await http(address, "/v1/sessions", "POST", start("s4"))).status).toBe(202);

    expect(join.mock.calls.map(([call]) => call.sessionId).sort()).toEqual(["s1", "s2", "s3", "s4"]);
    for (const id of ["s2", "s3", "s4"]) await http(address, `/v1/sessions/${id}`, "DELETE");
    expect((await http(address, "/v1/runner/drain", "POST")).status).toBe(202);
    await running;
  });
});
