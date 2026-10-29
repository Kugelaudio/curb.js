import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthoringDiagnostic } from "../authoring.js";
import type { AgentServerReport } from "../server/main.js";
import type { ChildMessage, SupervisorMessage } from "./dev-ipc.js";
import type { AgentTarget } from "./dev-proxy.js";
import {
  AgentServerSupervisor,
  CRASH_LOOP_MS,
  REPLY_WAIT_MS,
  START_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  describeFiles,
  type AgentProcess,
} from "./dev-supervisor.js";

/** A fake agent server process: records what the supervisor sends it, and lets the test
 * play the child's side (ready, failed, activity, exit). */
class FakeProcess implements AgentProcess {
  readonly sent: SupervisorMessage[] = [];
  readonly kills: Array<NodeJS.Signals | undefined> = [];
  private messageListener: (message: ChildMessage) => void = () => {};
  private exitListener: (code: number | null) => void = () => {};
  constructor(readonly quiet: boolean) {}
  send(message: SupervisorMessage) {
    this.sent.push(message);
  }
  kill(signal?: NodeJS.Signals) {
    this.kills.push(signal);
  }
  onMessage(listener: (message: ChildMessage) => void) {
    this.messageListener = listener;
  }
  onExit(listener: (code: number | null) => void) {
    this.exitListener = listener;
  }
  emit(message: ChildMessage) {
    this.messageListener(message);
  }
  exit(code: number | null) {
    this.exitListener(code);
  }
  ready(port = 50_001, report: Partial<AgentServerReport> = {}) {
    this.emit({ type: "ready", port, report: { ...REPORT, ...report } });
  }
}

const REPORT: AgentServerReport = {
  banner: { agentIds: ["agent"], defaultAgentId: "agent", voiceIssue: null, management: null, hasMcp: false },
  errors: 0,
  warnings: 0,
  renderError: null,
  conversationStore: "JSONL /project/.data/conversations.jsonl",
};

const SYNTAX_ERROR: AuthoringDiagnostic = {
  code: "AGENT_AUTHORING_RENDER_FAILED",
  severity: "error",
  message: 'The agent could not be loaded: its code does not compile: Unexpected ";"',
  location: { agentId: "agent", source: "src/lib/helper.ts", line: 1, column: 43 },
  fix: "Fix the code at this line.",
};

function harness() {
  let clock = 0;
  const processes: FakeProcess[] = [];
  const targets: Array<{ target: AgentTarget; files: readonly string[] }> = [];
  const logs: Array<[string, string]> = [];
  const firstStart = vi.fn();
  const supervisor = new AgentServerSupervisor({
    spawn: ({ quiet }) => {
      const process = new FakeProcess(quiet);
      processes.push(process);
      return process;
    },
    target: (target, files) => targets.push({ target, files }),
    firstStart,
    log: (level, message) => logs.push([level, message]),
    now: () => clock,
  });
  return {
    supervisor,
    processes,
    targets,
    logs,
    firstStart,
    tick: (ms: number) => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
    latest: () => processes[processes.length - 1],
    lastTarget: () => targets[targets.length - 1].target,
  };
}

/** Booted and serving, with the first start's banner already printed. */
function serving() {
  const h = harness();
  h.supervisor.start();
  h.latest().ready(50_001);
  return h;
}

describe("AgentServerSupervisor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds the agent's traffic while the first server starts, then serves it and prints the banner once", () => {
    const h = harness();
    h.supervisor.start();
    expect(h.processes).toHaveLength(1);
    expect(h.latest().quiet).toBe(false);
    expect(h.lastTarget()).toEqual({ kind: "hold" });

    h.latest().ready(50_001);
    expect(h.lastTarget()).toEqual({ kind: "forward", port: 50_001 });
    expect(h.firstStart).toHaveBeenCalledWith({ report: REPORT });
    expect(h.logs).toEqual([]);
  });

  it("reloads on a change: stops the server, starts a quiet one, and logs one line naming the file", () => {
    const h = serving();
    const first = h.latest();
    h.supervisor.filesChanged(["src/agent/agent.tsx"]);
    expect(first.sent).toEqual([{ type: "stop", files: ["src/agent/agent.tsx"] }]);
    expect(h.lastTarget()).toEqual({ kind: "hold" });

    first.exit(0);
    expect(h.processes).toHaveLength(2);
    expect(h.latest().quiet).toBe(true);
    h.tick(1300);
    h.latest().ready(50_002);

    expect(h.lastTarget()).toEqual({ kind: "forward", port: 50_002 });
    expect(h.logs).toEqual([["info", "reloaded src/agent/agent.tsx in 1.3s"]]);
    expect(h.firstStart).toHaveBeenCalledTimes(1);
  });

  it("does not cut a live call: the reload waits for it, the pages are told once, and it runs when the call ends", () => {
    const h = serving();
    const server = h.latest();
    server.emit({ type: "activity", calls: 1, turns: 0, signIns: 0 });

    h.supervisor.filesChanged(["src/agent/claims/skill.tsx"]);
    h.supervisor.filesChanged(["src/lib/helper.ts"]);
    expect(server.sent).toEqual([{ type: "waiting", until: "call_ends", files: ["src/agent/claims/skill.tsx"] }]);
    expect(h.logs).toEqual([["info", "src/agent/claims/skill.tsx changed: reloading when the call ends"]]);
    expect(h.processes).toHaveLength(1);
    expect(h.lastTarget()).toEqual({ kind: "forward", port: 50_001 });

    // The call's own reply runs and ends; the call is still live.
    server.emit({ type: "activity", calls: 1, turns: 1, signIns: 0 });
    server.emit({ type: "activity", calls: 1, turns: 0, signIns: 0 });
    expect(server.sent).toHaveLength(1);

    server.emit({ type: "activity", calls: 0, turns: 0, signIns: 0 });
    expect(server.sent.at(-1)).toEqual({ type: "stop", files: ["src/agent/claims/skill.tsx", "src/lib/helper.ts"] });
  });

  it("lets a running reply finish before reloading, and says it waits for the reply", () => {
    const h = serving();
    const server = h.latest();
    server.emit({ type: "activity", calls: 0, turns: 1, signIns: 0 });
    h.supervisor.filesChanged(["src/agent/agent.tsx"]);
    h.supervisor.filesChanged(["src/agent/agent.tsx"]);
    expect(server.sent).toEqual([{ type: "waiting", until: "reply_ends", files: ["src/agent/agent.tsx"] }]);
    // One line, however many saves wait with it.
    expect(h.logs).toEqual([["info", "src/agent/agent.tsx changed: reloading when the reply ends (at most 30s)"]]);

    // A call starting meanwhile changes what the reload waits for.
    server.emit({ type: "activity", calls: 1, turns: 1, signIns: 0 });
    expect(server.sent.at(-1)).toEqual({ type: "waiting", until: "call_ends", files: ["src/agent/agent.tsx"] });

    server.emit({ type: "activity", calls: 0, turns: 0, signIns: 0 });
    expect(server.sent.at(-1)).toEqual({ type: "stop", files: ["src/agent/agent.tsx"] });
  });

  it("waits at most 30s for a reply, then reloads anyway and says it cut the reply", () => {
    const h = serving();
    const server = h.latest();
    server.emit({ type: "activity", calls: 0, turns: 1, signIns: 0 });
    h.supervisor.filesChanged(["src/agent/agent.tsx"]);
    h.tick(REPLY_WAIT_MS - 1);
    expect(server.sent.map((message) => message.type)).toEqual(["waiting"]);

    h.tick(1);
    expect(server.sent.at(-1)).toEqual({ type: "stop", files: ["src/agent/agent.tsx"] });
    expect(h.logs.at(-1)).toEqual(["info", "the reply did not end within 30s: reloading now, which cuts it off"]);
    expect(h.lastTarget()).toEqual({ kind: "hold" });
  });

  it("never cuts a live call: its reply's 30s start only once the call has ended", () => {
    const h = serving();
    const server = h.latest();
    server.emit({ type: "activity", calls: 0, turns: 1, signIns: 0 });
    h.supervisor.filesChanged(["src/agent/agent.tsx"]);
    h.tick(20_000);
    server.emit({ type: "activity", calls: 1, turns: 1, signIns: 0 });
    h.tick(10 * 60_000);
    expect(server.sent.at(-1)).toMatchObject({ type: "waiting", until: "call_ends" });

    // The call ends with a reply still running: that reply gets 30s of its own.
    server.emit({ type: "activity", calls: 0, turns: 1, signIns: 0 });
    h.tick(REPLY_WAIT_MS - 1);
    expect(server.sent.at(-1)).toMatchObject({ type: "waiting", until: "reply_ends" });
    h.tick(1);
    expect(server.sent.at(-1)).toEqual({ type: "stop", files: ["src/agent/agent.tsx"] });
  });

  it("holds the reload while an MCP sign-in is in progress, so its callback reaches this server", () => {
    const h = serving();
    const server = h.latest();
    server.emit({ type: "activity", calls: 0, turns: 0, signIns: 1 });
    h.supervisor.filesChanged(["src/agent/agent.tsx"]);
    // The sign-in happens in another window: the terminal says why nothing reloads, the page is not held.
    expect(server.sent).toEqual([]);
    expect(h.logs).toEqual([["info", "src/agent/agent.tsx changed: reloading when the MCP sign-in finishes (at most 5 min)"]]);
    expect(h.lastTarget()).toEqual({ kind: "forward", port: 50_001 });

    // The provider called back (or the sign-in was abandoned after 5 minutes, which the server reports the same way).
    server.emit({ type: "activity", calls: 0, turns: 0, signIns: 0 });
    expect(server.sent.at(-1)).toEqual({ type: "stop", files: ["src/agent/agent.tsx"] });
  });

  it("names the conversation store again when a reload changed it", () => {
    const h = serving();
    for (const store of ["JSONL /project/.data/conversations.jsonl", "sink /project/lib/sink.ts (KUGEL_CONVERSATION_SINK)"]) {
      h.supervisor.filesChanged([".env"]);
      h.latest().exit(0);
      h.latest().ready(50_002, { conversationStore: store });
    }
    expect(h.logs).toEqual([
      ["info", "reloaded .env in 0ms"],
      ["info", "reloaded .env in 0ms"],
      ["info", "conversation store: sink /project/lib/sink.ts (KUGEL_CONVERSATION_SINK)"],
    ]);
  });

  it("starts over when a file changes while a server is still starting", () => {
    const h = serving();
    h.supervisor.filesChanged(["src/a.ts"]);
    h.latest().exit(0);
    const starting = h.latest();

    h.supervisor.filesChanged(["src/b.ts"]);
    expect(starting.kills).toEqual(["SIGKILL"]);
    expect(h.processes).toHaveLength(3);
    // The killed one's exit is not a crash.
    starting.exit(null);
    expect(h.processes).toHaveLength(3);

    h.latest().ready(50_003);
    expect(h.lastTarget()).toEqual({ kind: "forward", port: 50_003 });
    expect(h.logs.at(-1)?.[1]).toMatch(/^reloaded src\/a\.ts and 1 more in /);
  });

  it("keeps running when an edit does not load, shows the diagnostic, and recovers on the next save", () => {
    const h = serving();
    h.supervisor.filesChanged(["src/lib/helper.ts"]);
    h.latest().exit(0);
    const broken = h.latest();
    broken.emit({ type: "failed", diagnostic: SYNTAX_ERROR });
    broken.exit(1);

    expect(h.lastTarget()).toEqual({
      kind: "unavailable",
      unavailable: { message: "The agent did not load.", diagnostics: [SYNTAX_ERROR] },
    });
    expect(h.logs).toEqual([
      [
        "error",
        'src/lib/helper.ts: The agent could not be loaded: its code does not compile: Unexpected ";" (src/lib/helper.ts:1:43)',
      ],
    ]);

    // Nothing restarts it until the files change.
    h.tick(60_000);
    expect(h.processes).toHaveLength(2);

    h.supervisor.filesChanged(["src/lib/helper.ts"]);
    expect(h.lastTarget()).toEqual({ kind: "hold" });
    expect(h.targets.at(-1)?.files).toEqual(["src/lib/helper.ts"]);
    h.latest().ready(50_004);
    expect(h.lastTarget()).toEqual({ kind: "forward", port: 50_004 });
    expect(h.logs.at(-1)).toEqual(["info", expect.stringMatching(/^reloaded src\/lib\/helper\.ts in /)]);
  });

  it("reports an agent that loads but does not render as an error line", () => {
    const h = serving();
    h.supervisor.filesChanged(["src/agent/claims/skill.tsx"]);
    h.latest().exit(0);
    h.latest().ready(50_002, { renderError: "boom in render" });
    expect(h.logs).toEqual([["error", "reloaded src/agent/claims/skill.tsx in 0ms, but the agent does not render: boom in render"]]);
    expect(h.lastTarget()).toEqual({ kind: "forward", port: 50_002 });
  });

  it("tells the banner when the first start does not load", () => {
    const h = harness();
    h.supervisor.start();
    h.latest().emit({ type: "failed", diagnostic: SYNTAX_ERROR });
    h.latest().exit(1);
    expect(h.firstStart).toHaveBeenCalledWith({
      failure: { message: "The agent did not load.", diagnostics: [SYNTAX_ERROR] },
    });
    // The next start is a reload: quiet.
    h.supervisor.filesChanged(["src/lib/helper.ts"]);
    expect(h.latest().quiet).toBe(true);
  });

  it("starts a crashed server again, unless it crashes right after starting", () => {
    const h = serving();
    h.tick(CRASH_LOOP_MS);
    h.latest().exit(1);
    expect(h.logs).toEqual([["error", "the agent server exited (exit code 1); starting it again"]]);
    expect(h.processes).toHaveLength(2);

    h.latest().ready(50_002);
    h.tick(1_000);
    h.latest().exit(1);
    expect(h.processes).toHaveLength(2);
    expect(h.lastTarget()).toMatchObject({ kind: "unavailable" });
    expect(h.logs.at(-1)?.[1]).toMatch(/right after it started; save a file to start it again/);
  });

  it("gives up on a server that does not start in time, and on one that does not stop", () => {
    const h = harness();
    h.supervisor.start();
    const stuck = h.latest();
    h.tick(START_TIMEOUT_MS);
    expect(stuck.kills).toEqual(["SIGKILL"]);
    stuck.exit(null);
    expect(h.lastTarget()).toEqual({
      kind: "unavailable",
      unavailable: { message: "The agent server did not start within 60s.", diagnostics: [] },
    });

    h.supervisor.filesChanged(["src/agent/agent.tsx"]);
    h.latest().ready();
    h.supervisor.filesChanged(["src/agent/agent.tsx"]);
    const stopping = h.latest();
    h.tick(STOP_TIMEOUT_MS);
    expect(stopping.kills).toEqual(["SIGKILL"]);
  });

  it("stops the server when curb dev exits", () => {
    const h = serving();
    h.supervisor.close();
    expect(h.latest().kills).toEqual(["SIGTERM"]);
    h.supervisor.filesChanged(["src/a.ts"]);
    expect(h.processes).toHaveLength(1);
  });
});

describe("describeFiles", () => {
  it("names one file, or the first and how many more", () => {
    expect(describeFiles([])).toBe("");
    expect(describeFiles(["src/a.ts"])).toBe("src/a.ts");
    expect(describeFiles(["src/a.ts", "src/b.ts", "src/c.ts"])).toBe("src/a.ts and 2 more");
  });
});
