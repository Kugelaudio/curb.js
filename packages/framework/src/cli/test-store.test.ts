import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentLlmClient } from "../agent-session.js";
import type { AgentRunRequest } from "../llm/types.js";
import type { ReplyStore, StoredReply } from "../testing/index.js";
import { createAgentSession } from "../server/bootstrap.js";
import { createTestProject } from "./test-project.js";
import { testCommand, type TestHost } from "./test.js";

/** A store in memory that counts what it is asked. */
function memoryStore() {
  const replies = new Map<string, StoredReply>();
  const store: ReplyStore & { gets: number } = {
    gets: 0,
    async get(key) {
      store.gets += 1;
      return replies.get(key) ?? null;
    },
    async put(key, reply) {
      if (!replies.has(key)) replies.set(key, reply);
    },
  };
  return store;
}

/** The fixture project's agent on a model that always answers "Sure.", 12 tokens a request,
 * counting what it was asked. `rules` is the spoken-reply suffix of its system prompt. */
function modelHost(rules = "## Spoken-reply rules (test)") {
  const requests: AgentRunRequest[] = [];
  const host: TestHost = {
    async createBundle() {
      let answered = 0;
      const llm: AgentLlmClient = async (request) => {
        requests.push(request);
        answered += 1;
        return { text: "Sure.", toolCalls: [] };
      };
      const { runtime, session } = await createAgentSession(llm, undefined, undefined, { spokenStyleSuffix: rules });
      return { runtime, session, tokens: () => ({ inputTokens: 10 * answered, outputTokens: 2 * answered, cacheReadTokens: 0, cacheWriteTokens: 0 }) };
    },
    simulator: () => async () => {
      throw new Error("a scripted scenario asks no simulator");
    },
  };
  return { host, requests };
}

const scenarioFile = (second: string) => `import { scenario } from "curb/testing";

export default scenario({
  name: "asks twice",
  turns: ["Hi, can you help me?", ${JSON.stringify(second)}],
});
`;

type Json = Record<string, any>;

describe("curb test and the reply store", () => {
  const projects: string[] = [];
  const project = (files: Record<string, string>) => {
    const root = createTestProject(files);
    projects.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function run(args: string[], root: string, host: TestHost, stores: ReplyStore[]) {
    const out: string[] = [];
    const code = await testCommand(args, root, { host, stores, out: (text) => void out.push(text), env: {} });
    return { code, printed: out.join("") };
  }
  /** The project at `root` with `file` as it is now: a project of its own holding the same saved
   * runs, since this process keeps the scenario module it imported first. */
  const edited = (root: string, file: string, content: string) => {
    const next = project({ [file]: content });
    if (existsSync(join(root, ".curb"))) cpSync(join(root, ".curb"), join(next, ".curb"), { recursive: true });
    return next;
  };
  const savedRuns = (root: string) => {
    try {
      return readdirSync(join(root, ".curb/test-runs"));
    } catch {
      return [];
    }
  };

  it("answers a second run from the store, says so per scenario, and splits the tokens", async () => {
    const root = project({ "src/agent/asks.scenario.ts": scenarioFile("Thanks, bye") });
    const store = memoryStore();
    const first = modelHost();

    const one = await run(["--json"], root, first.host, [store]);
    expect(one.code).toBe(0);
    const report = JSON.parse(one.printed) as Json;
    const asked = first.requests.length;
    expect(asked).toBeGreaterThan(0);
    expect(report.store).toEqual({ hits: 0, misses: asked, liveTokens: 12 * asked, savedTokens: 0 });
    expect(report.scenarios[0].replies).toEqual({ stored: 0, live: asked, summary: "live from turn 1 (no earlier run to compare with)" });
    // The saved conversation says what the store answered, request by request.
    const saved = JSON.parse(readFileSync(join(root, ".curb/test-runs", savedRuns(root)[0]!), "utf8")) as Json;
    expect(saved.conversations[0].replies).toMatchObject({ stored: 0, live: asked, from: { turn: 1, role: "agent" } });
    expect(saved.conversations[0].replies.requests).toHaveLength(asked);

    const second = modelHost();
    const two = await run([], root, second.host, [store]);
    expect(two.code).toBe(0);
    expect(second.requests).toHaveLength(0);
    expect(two.printed).toContain("  replies  stored\n");
    expect(two.printed).toMatch(new RegExp(`Tokens: .*${12 * asked} saved by the reply store \\(${asked} of ${asked} request\\(s\\) answered from it\\)`));
  });

  it("--dry calls no model, saves nothing, and names the turn and the part that changed", async () => {
    const first = project({ "src/agent/asks.scenario.ts": scenarioFile("Thanks, bye") });
    const store = memoryStore();
    await run([], first, modelHost().host, [store]);

    // The caller's second line changed: the store answers turn 1, and turn 2 would go live.
    const root = edited(first, "src/agent/asks.scenario.ts", scenarioFile("One more question, please"));
    const before = savedRuns(root);
    const dry = modelHost();
    const line = await run(["--dry"], root, dry.host, [store]);
    expect(dry.requests).toHaveLength(0);
    expect(line.code).toBe(0);
    expect(line.printed).toContain("Dry run, no model called: 1 of 1 scenario(s) would go live.");
    expect(line.printed).toContain("  asks twice (src/agent/asks.scenario.ts): live from turn 2 (the caller's words changed)");
    expect(savedRuns(root)).toEqual(before);

    // The system prompt changed: every request differs from the first one on.
    const rules = modelHost("## Spoken-reply rules (changed)");
    const json = await run(["--dry", "--json"], root, rules.host, [store]);
    expect(rules.requests).toHaveLength(0);
    const report = JSON.parse(json.printed) as Json;
    expect(report).toMatchObject({ dry: true, exitCode: 0, scenarios: [{ name: "asks twice", live: true, summary: "live from turn 1 (system prompt changed)" }] });
    expect(report.scenarios[0].runs).toEqual([{ run: 1, from: { turn: 1, role: "agent", changed: "system prompt changed" } }]);

    // Unchanged, nothing would go live.
    const same = await run(["--dry"], first, modelHost().host, [store]);
    expect(same.printed).toContain("Dry run, no model called: 0 of 1 scenario(s) would go live.");
    expect(same.printed).toContain("  asks twice (src/agent/asks.scenario.ts): stored");
  });

  it("--max-tokens starts no live request past the limit and exits 3", async () => {
    const root = project({ "src/agent/asks.scenario.ts": scenarioFile("Thanks, bye") });
    const limited = modelHost();
    const { code, printed } = await run(["--json", "--max-tokens", "1"], root, limited.host, [memoryStore()]);
    expect(code).toBe(3);
    expect(limited.requests).toHaveLength(1);
    const report = JSON.parse(printed) as Json;
    expect(report.outcome).toBe("limit");
    expect(report.limit).toMatchObject({ maxTokens: 1, liveTokens: 12 });
    expect(report.limit.refused).toBeGreaterThan(0);
    // The run that needed the model is an error, not a failure of the agent.
    expect(report.scenarios[0].runs[0].outcome).toBe("error");

    const text = await run(["--max-tokens", "1"], root, modelHost().host, [memoryStore()]);
    expect(text.code).toBe(3);
    expect(text.printed).toContain("Stopped at --max-tokens 1: the live requests used 12 tokens");
  });

  it("--live asks the model every time and leaves the store alone", async () => {
    const root = project({ "src/agent/asks.scenario.ts": scenarioFile("Thanks, bye") });
    const store = memoryStore();
    await run([], root, modelHost().host, [store]);
    const gets = store.gets;

    const live = modelHost();
    const { code, printed } = await run(["--json", "--live"], root, live.host, [store]);
    expect(code).toBe(0);
    expect(live.requests.length).toBeGreaterThan(0);
    expect(store.gets).toBe(gets);
    const report = JSON.parse(printed) as Json;
    expect(report).not.toHaveProperty("store");
    expect(report.scenarios[0]).not.toHaveProperty("replies");
  });

  it("runs the scenarios a change since the last commit can affect first", async () => {
    const root = project({
      "src/agent/a-first.scenario.ts": scenarioFile("Thanks, bye").replace("asks twice", "first"),
      "src/agent/b-second.scenario.ts": scenarioFile("Thanks, bye").replace("asks twice", "second"),
    });
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "scenarios");
    writeFileSync(join(root, "src/agent/b-second.scenario.ts"), scenarioFile("Bye then").replace("asks twice", "second"));

    const { printed } = await run(["--json"], root, modelHost().host, [memoryStore()]);
    expect((JSON.parse(printed) as Json).scenarios.map((entry: Json) => entry.name)).toEqual(["second", "first"]);
  });
});
