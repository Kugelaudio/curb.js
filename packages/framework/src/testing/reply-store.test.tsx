import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient, type AgentLlmStreamStep } from "../agent-session.js";
import { Agent, AgentSiteRuntime, Text } from "../index.js";
import { serializeLlmInput } from "../llm/serialize-input.js";
import type { AgentRunRequest, AgentRunResponse } from "../llm/types.js";
import { createAgentSession } from "../server/bootstrap.js";
import { addTask, calls, says } from "../test-fixtures/tasks.js";
import type { CallBundle, TestHost } from "./host.js";
import { asRun, localReplyStore, remoteReplyStore, startCall, withReplyStore, type ReplyStore, type StoredReply } from "./index.js";
import { canonicalJson, DEFAULT_TEST_NOW, defaultReplyStoreDir, replyKey, replyStoreStats, runReplies, testNow } from "./reply-store.js";
import { Throttle } from "./resilience.js";

/** A store in memory that counts what it is asked. */
function memoryStore() {
  const replies = new Map<string, StoredReply>();
  const store: ReplyStore & { replies: typeof replies; gets: number; puts: number } = {
    replies,
    gets: 0,
    puts: 0,
    async get(key) {
      store.gets += 1;
      return replies.get(key) ?? null;
    },
    async put(key, reply) {
      store.puts += 1;
      if (!replies.has(key)) replies.set(key, reply);
    },
  };
  return store;
}

/** A host whose agent is `element` on a model that answers `answer`, counting every request the
 * model got; its caller and judge answer `think`. */
function countingHost(options: {
  element?: () => React.ReactElement;
  answer?: (request: AgentRunRequest, index: number) => AgentRunResponse;
  stream?: boolean;
  think?: (request: AgentRunRequest) => string;
}) {
  const seen = { agent: [] as AgentRunRequest[], simulator: [] as AgentRunRequest[] };
  const answer = options.answer ?? (() => says("Okay."));
  const host: TestHost = {
    async createBundle(): Promise<CallBundle> {
      const llm: AgentLlmClient = async (request) => answer(request, seen.agent.push(request) - 1);
      const streamLlm: AgentLlmStreamStep = async function* (request) {
        const response = answer(request, seen.agent.push(request) - 1);
        if (response.text) yield { delta: response.text, text: response.text };
        return response;
      };
      const runtime = new AgentSiteRuntime(options.element?.() ?? <Agent><Text>Help with the order.</Text></Agent>);
      const session = new AgentSession(runtime, llm, options.stream ? { streamLlm } : {});
      return { runtime, session, tokens: () => ({ inputTokens: 10 * seen.agent.length, outputTokens: 2 * seen.agent.length, cacheReadTokens: 0, cacheWriteTokens: 0 }) };
    },
    simulator(_llm, _role, onUsage) {
      return async (request) => {
        seen.simulator.push(request);
        onUsage({ inputTokens: 3, outputTokens: 1, cacheReadTokens: undefined, cacheWriteTokens: undefined });
        return says(options.think?.(request) ?? "yes");
      };
    },
    throttle: new Throttle(),
  };
  return { host, seen };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("two identical runs send identical requests", () => {
  /** Plays the same two turns on the fixture project's agent and returns each request as the
   * provider would receive it. */
  async function playFixture(host: (bundle: () => Promise<CallBundle>) => TestHost) {
    const sent: unknown[] = [];
    const llm: AgentLlmClient = async (request) => {
      sent.push(serializeLlmInput(request));
      return says("Gladly.");
    };
    const base = host(async () => {
      const { runtime, session } = await createAgentSession(llm);
      return { runtime, session };
    });
    const call = await startCall({ host: base });
    await call.say("Hello, I have a question about my policy.");
    await call.say("Thanks.");
    return sent;
  }
  const plain = (createBundle: () => Promise<CallBundle>): TestHost => ({ createBundle, simulator: () => async () => says("") });

  it("differ an hour apart on the real clock: the date line is the one part that moves", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T09:00:00Z"));
    const first = await playFixture(plain);
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    const second = await playFixture(plain);
    expect(first).toHaveLength(second.length);
    const differing = first.map((request, index) => [canonicalJson(request), canonicalJson(second[index])]).filter(([a, b]) => a !== b);
    expect(differing.length).toBeGreaterThan(0);
    // Take the date line out and nothing else differs: no ids, no timestamps, no tool order.
    const undated = (text: string) => text.replace(/Today is [^"\\]*/g, "Today is …");
    expect(differing.every(([a, b]) => undated(a!) === undated(b!))).toBe(true);
  });

  it("are the same on a reply store's fixed clock, a month apart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const stored = (createBundle: () => Promise<CallBundle>) => withReplyStore(plain(createBundle), memoryStore());
    vi.setSystemTime(new Date("2026-11-02T09:00:00Z"));
    const first = await playFixture(stored);
    vi.setSystemTime(new Date("2026-12-02T10:31:00Z"));
    const second = await playFixture(stored);
    expect(second.map((request) => canonicalJson(request))).toEqual(first.map((request) => canonicalJson(request)));
    expect(JSON.stringify(first)).toContain("Today is Wednesday, June 3, 2026, 15:00 (UTC)");
  });
});

describe("withReplyStore", () => {
  it("answers a second run of the same call from the store, with no model request", async () => {
    const store = memoryStore();
    const { host, seen } = countingHost({ answer: (_request, index) => (index === 0 ? calls(addTask("milk")) : says("Milk is on the list.")) });
    const play = async () => {
      const call = await startCall({ host: withReplyStore(host, store) });
      return (await call.say("Put milk on my list.")).reply;
    };
    expect(await play()).toBe("Milk is on the list.");
    const live = seen.agent.length;
    expect(live).toBe(2);
    expect(store.replies.size).toBe(2);
    expect(await play()).toBe("Milk is on the list.");
    expect(seen.agent.length).toBe(live);
  });

  it("plays a stored reply on the streaming transport, words and tool calls alike", async () => {
    const store = memoryStore();
    const { host, seen } = countingHost({ stream: true, answer: () => says("Your order ships today.") });
    const replyOf = async () => (await (await startCall({ host: withReplyStore(host, store) })).say("Where is my order?")).reply;
    expect(await replyOf()).toBe("Your order ships today.");
    expect(await replyOf()).toBe("Your order ships today.");
    expect(seen.agent).toHaveLength(1);
  });

  it("goes live from the first request that changed, and only for the calls that see the change", async () => {
    const store = memoryStore();
    const agent = (refunds: string) => () => (
      <Agent>
        <Text>Help with billing.</Text>
        <Text>{refunds}</Text>
      </Agent>
    );
    const before = countingHost({ element: agent("Refunds take five days.") });
    const play = (host: TestHost) => startCall({ host: withReplyStore(host, store) }).then((call) => call.say("When do I get my refund?"));
    await play(before.host);
    expect(before.seen.agent).toHaveLength(1);
    await play(before.host);
    expect(before.seen.agent).toHaveLength(1);
    const after = countingHost({ element: agent("Refunds take three days.") });
    await play(after.host);
    expect(after.seen.agent).toHaveLength(1);
  });

  it("sends the rest of a call to the model once one request of it was not stored", async () => {
    const store = memoryStore();
    const { host, seen } = countingHost({});
    const wrapped = withReplyStore(host, store);
    await asRun(0, async () => {
      const call = await startCall({ host: wrapped });
      await call.say("First question.");
      await call.say("Second question.");
    });
    // Forget the first reply: the second request is still stored, yet the call goes live.
    const [firstKey] = [...store.replies.keys()];
    store.replies.delete(firstKey!);
    const gets = store.gets;
    const replies = await asRun(0, async () => {
      const call = await startCall({ host: withReplyStore(host, store) });
      await call.say("First question.");
      await call.say("Second question.");
      return runReplies();
    });
    expect(seen.agent).toHaveLength(4);
    expect(store.gets - gets).toBe(1);
    expect(replies).toMatchObject({ stored: 0, live: 2 });
    // Each request, in order, with who asked, whether it went live, and a digest of each part.
    expect(replies!.requests.map((request) => [request.role, request.live, request.messages.length])).toEqual([
      ["agent", true, 1],
      ["agent", true, 3],
    ]);
    expect(Object.keys(replies!.requests[0]!.parts)).toEqual(["model", "settings", "system", "tools", "context"]);
    expect(replies!.requests[0]!.parts.system).toMatch(/^[0-9a-f]{12}$/);
  });

  it("keeps one sample per run: each run of a test has replies of its own", async () => {
    const store = memoryStore();
    const { host, seen } = countingHost({ answer: (_request, index) => says(`Answer ${index}.`) });
    const wrapped = withReplyStore(host, store);
    const replyIn = (run: number) => asRun(run, async () => (await (await startCall({ host: wrapped })).say("Hi.")).reply);
    expect(await Promise.all([replyIn(0), replyIn(1), replyIn(2)])).toEqual(expect.arrayContaining(["Answer 0.", "Answer 1.", "Answer 2."]));
    expect(seen.agent).toHaveLength(3);
    const again = await Promise.all([replyIn(0), replyIn(1), replyIn(2)]);
    expect(new Set(again).size).toBe(3);
    expect(seen.agent).toHaveLength(3);
    expect(() => asRun(-1, async () => {})).toThrow("asRun: run must be a whole number from 0, not -1.");
  });

  it("sends two identical requests at once to the model once", async () => {
    const store = memoryStore();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = vi.fn(async () => {
      await gate;
      return says("Shared.");
    });
    const host: TestHost = { createBundle: () => Promise.reject(new Error("unused")), simulator: () => inner };
    const wrapped = withReplyStore(host, store);
    const client = wrapped.simulator({ provider: "openai", kind: "llm", options: { model: "gpt-5.2" } }, "judge", () => {});
    const request = { systemPrompt: "Judge.", skillTitle: "", stateSnapshot: ["Was the refund issued?"], tools: [], messages: [] };
    const both = Promise.all([client(request), client(request)]);
    release();
    expect((await both).map((response) => response.text)).toEqual(["Shared.", "Shared."]);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(store.replies.size).toBe(1);
  });

  it("keeps no error and no cut-off reply, and still keeps the reply of a test that then fails", async () => {
    const store = memoryStore();
    const answers: Array<AgentRunResponse | Error> = [new Error("overloaded"), { text: "Your refund is", toolCalls: [], cutOff: true }, says("Done.")];
    const host: TestHost = {
      createBundle: () => Promise.reject(new Error("unused")),
      simulator: () => async () => {
        const next = answers.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
    };
    const client = withReplyStore(host, store).simulator({ provider: "openai", kind: "llm", options: { model: "gpt-5.2" } }, "caller", () => {});
    const request = { systemPrompt: "Caller.", skillTitle: "", stateSnapshot: ["Say your next line."], tools: [], messages: [] };
    await expect(client(request)).rejects.toThrow("overloaded");
    expect(store.puts).toBe(0);
    expect((await client(request)).cutOff).toBe(true);
    expect(store.puts).toBe(0);
    expect((await client(request)).text).toBe("Done.");
    const [kept] = [...store.replies.values()];
    // The caller plays on the provider's small model, and the key and the record name it.
    expect(kept).toMatchObject({ v: 1, model: "openai:gpt-5.4-mini", usage: null, response: { text: "Done.", toolCalls: [] } });
    expect(kept!.key).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(kept!.createdAt))).toBe(false);
  });

  it("answers the caller and the judge from the store too, and counts what it saved", async () => {
    const store = memoryStore();
    const { host, seen } = countingHost({});
    const ask = async () => {
      const wrapped = withReplyStore(host, store);
      await startCall({ host: wrapped });
      const caller = wrapped.simulator({ provider: "openai", kind: "llm", options: { model: "gpt-5.2" } }, "caller", () => {});
      await caller({ systemPrompt: "Caller.", skillTitle: "", stateSnapshot: ["Your line."], tools: [], messages: [] });
      return replyStoreStats(wrapped);
    };
    expect(await ask()).toEqual({ hits: 0, misses: 1, liveTokens: 4, savedTokens: 0 });
    expect(await ask()).toEqual({ hits: 1, misses: 0, liveTokens: 0, savedTokens: 4 });
    expect(seen.simulator).toHaveLength(1);
    expect(replyStoreStats(host)).toBeNull();
  });

  it("keys a request by its model and by who asks", () => {
    const parts = { role: "agent" as const, model: "openai:gpt-5.2", settings: {}, system: "S", messages: [], tools: [], run: 0 };
    const key = replyKey(parts);
    expect(replyKey({ ...parts })).toBe(key);
    expect(replyKey({ ...parts, role: "judge" })).not.toBe(key);
    expect(replyKey({ ...parts, model: "openai:gpt-5.4-mini" })).not.toBe(key);
    expect(replyKey({ ...parts, settings: { temperature: 0 } })).not.toBe(key);
    expect(replyKey({ ...parts, run: 1 })).not.toBe(key);
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
  });

  it("goes on with the model when every store fails, and says so once", async () => {
    const broken: ReplyStore = { get: () => Promise.reject(new Error("disk gone")), put: () => Promise.reject(new Error("disk gone")) };
    const notes = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host, seen } = countingHost({});
    const call = await startCall({ host: withReplyStore(host, broken) });
    await call.say("One.");
    await call.say("Two.");
    expect(seen.agent).toHaveLength(2);
    expect(notes.mock.calls.filter(([line]) => String(line).includes("reply store failed"))).toEqual([
      ["note: the reply store failed (disk gone); the test goes on with the other stores, else with the model."],
    ]);
    notes.mockRestore();
  });
});

describe("the clock", () => {
  it("is the scenario's now, else CURB_TEST_NOW, else the fixed instant", () => {
    expect(testNow().toISOString()).toBe(DEFAULT_TEST_NOW);
    expect(testNow(undefined, { CURB_TEST_NOW: "2026-10-30T15:00:00Z" }).toISOString()).toBe("2026-10-30T15:00:00.000Z");
    expect(testNow("2027-01-04T08:00:00Z", { CURB_TEST_NOW: "2026-10-30T15:00:00Z" }).toISOString()).toBe("2027-01-04T08:00:00.000Z");
    expect(() => testNow(undefined, { CURB_TEST_NOW: "soon" })).toThrow('CURB_TEST_NOW: "soon" is not a date-time.');
  });

  it("shows startCall's now in the agent's date line, with the store and without it", async () => {
    const { host, seen } = countingHost({});
    const call = await startCall({ host, now: "2026-10-30T15:00:00Z" });
    await call.say("What day is it?");
    expect(serializeLlmInput(seen.agent[0]!).messages.at(-1)!.content).toContain("Today is Friday, October 30, 2026, 15:00 (UTC)");
    await expect(startCall({ host, now: "tomorrow" })).rejects.toThrow('startCall: now: "tomorrow" is not a date-time.');
  });

  it("is the real one without a reply store", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T09:00:00Z"));
    const { host, seen } = countingHost({});
    await (await startCall({ host })).say("Hi.");
    expect(serializeLlmInput(seen.agent[0]!).messages.at(-1)!.content).toContain("Monday, November 2, 2026, 09:00");
  });
});

describe("localReplyStore", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "curb-replies-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const key = "ab".padEnd(64, "0");
  const reply = (text: string): StoredReply => ({ v: 1, key, model: "openai:gpt-5.2", createdAt: "2026-11-02T09:00:00.000Z", usage: { inputTokens: 5 }, response: says(text) });

  it("keeps each reply as an immutable gzip file under v1/<aa>/<key>.json.gz", async () => {
    const store = localReplyStore({ dir });
    expect(await store.get(key)).toBeNull();
    await store.put(key, reply("First."));
    await store.put(key, reply("Second."));
    const file = join(dir, "v1", "ab", `${key}.json.gz`);
    expect(JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"))).toEqual(reply("First."));
    expect(await store.get(key)).toEqual(reply("First."));
    expect(readdirSync(join(dir, "v1", "ab"))).toEqual([`${key}.json.gz`]);
  });

  it("answers nothing for a damaged file and replaces it, and refuses what is not a key", async () => {
    const store = localReplyStore({ dir });
    await store.put(key, reply("First."));
    writeFileSync(join(dir, "v1", "ab", `${key}.json.gz`), gzipSync("{"));
    expect(await store.get(key)).toBeNull();
    await store.put(key, reply("Again."));
    expect(await store.get(key)).toEqual(reply("Again."));
    await expect(store.get("../../etc/passwd")).rejects.toThrow("is not a reply key");
  });

  it("lives in CURB_REPLY_STORE_DIR, else the XDG cache, else ~/.cache", () => {
    expect(defaultReplyStoreDir({ CURB_REPLY_STORE_DIR: "/srv/replies", XDG_CACHE_HOME: "/xdg" })).toBe("/srv/replies");
    expect(defaultReplyStoreDir({ XDG_CACHE_HOME: "/xdg" })).toBe(join("/xdg", "curb", "replies"));
    expect(defaultReplyStoreDir({})).toMatch(/\.cache[/\\]curb[/\\]replies$/);
  });
});

describe("remoteReplyStore", () => {
  let server: Server;
  let base: string;
  const held = new Map<string, Buffer>();
  const requests: Array<{ method: string; url: string; auth: string | undefined }> = [];
  let refusePuts = false;
  let conflicting = false;
  let down = false;
  const body = (request: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks)));
    });
  beforeEach(async () => {
    held.clear();
    requests.length = 0;
    refusePuts = false;
    conflicting = false;
    down = false;
    server = createServer(async (request, response) => {
      requests.push({ method: request.method!, url: request.url!, auth: request.headers.authorization });
      const key = request.url!.replace(/^\/base\/replies\//, "");
      if (down) return void response.writeHead(503).end();
      if (request.method === "GET") {
        const found = held.get(key);
        return found ? void response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }).end(found) : void response.writeHead(404).end();
      }
      const sent = await body(request);
      if (refusePuts) return void response.writeHead(403).end();
      if (conflicting) return void response.writeHead(409).end();
      if (held.has(key)) return void response.writeHead(200).end();
      held.set(key, sent);
      response.writeHead(201).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/base`;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const key = "cd".padEnd(64, "1");
  const reply: StoredReply = { v: 1, key, model: "openai:gpt-5.2", createdAt: "2026-11-02T09:00:00.000Z", usage: null, response: says("Remote.") };

  it("speaks the protocol: GET 404 or gzip JSON, PUT with a bearer token", async () => {
    const store = remoteReplyStore({ url: `${base}/`, token: "t0ken" });
    expect(await store.get(key)).toBeNull();
    await store.put(key, reply);
    expect(await store.get(key)).toEqual(reply);
    expect(JSON.parse(gunzipSync(held.get(key)!).toString("utf8"))).toEqual(reply);
    expect(requests.map((request) => `${request.method} ${request.url} ${request.auth}`)).toEqual([
      `GET /base/replies/${key} Bearer t0ken`,
      `PUT /base/replies/${key} Bearer t0ken`,
      `GET /base/replies/${key} Bearer t0ken`,
    ]);
  });

  it("stops putting once the server says it is read-only", async () => {
    refusePuts = true;
    const store = remoteReplyStore({ url: base });
    await store.put(key, reply);
    await store.put(key, reply);
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  it("takes a 409 (the same key is being written) as done: no error, no retry, still writable", async () => {
    conflicting = true;
    const store = remoteReplyStore({ url: base });
    await expect(store.put(key, reply)).resolves.toBeUndefined();
    const other = "ef".padEnd(64, "2");
    await store.put(other, { ...reply, key: other });
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([`PUT /base/replies/${key}`, `PUT /base/replies/${other}`]);

    const notes = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host, seen } = countingHost({});
    const turn = await (await startCall({ host: withReplyStore(host, [store]) })).say("Hi.");
    expect(turn.errors).toEqual([]);
    expect(seen.agent).toHaveLength(1);
    await vi.waitFor(() => expect(requests.filter((request) => request.method === "PUT")).toHaveLength(3));
    expect(notes).not.toHaveBeenCalled();
    notes.mockRestore();
  });

  it("reads CURB_REPLY_STORE_URL and CURB_REPLY_STORE_TOKEN, and needs a url", async () => {
    vi.stubEnv("CURB_REPLY_STORE_URL", base);
    vi.stubEnv("CURB_REPLY_STORE_TOKEN", "from-env");
    await remoteReplyStore().get(key);
    expect(requests[0]!.auth).toBe("Bearer from-env");
    vi.stubEnv("CURB_REPLY_STORE_URL", "");
    expect(() => remoteReplyStore()).toThrow("remoteReplyStore: no url.");
  });

  it("copies a remote hit to the local store, and a remote that fails costs a note, not the test", async () => {
    const dir = mkdtempSync(join(tmpdir(), "curb-replies-"));
    try {
      const local = localReplyStore({ dir });
      const remote = remoteReplyStore({ url: base });
      const { host, seen } = countingHost({});
      const play = async () => (await startCall({ host: withReplyStore(host, [local, remote]) })).say("Hi.");
      await play();
      expect(held.size).toBe(1);
      rmSync(join(dir, "v1"), { recursive: true });
      await play();
      expect(seen.agent).toHaveLength(1);
      await vi.waitFor(async () => expect(readdirSync(join(dir, "v1"))).toHaveLength(1));
      down = true;
      held.clear();
      rmSync(join(dir, "v1"), { recursive: true });
      const notes = vi.spyOn(console, "error").mockImplementation(() => {});
      await play();
      expect(seen.agent).toHaveLength(2);
      expect(notes.mock.calls.map(([line]) => String(line))).toEqual([
        "note: reply store 2 of 2 failed (GET http://127.0.0.1:" + new URL(base).port + "/base/replies/… answered 503); the test goes on with the other stores, else with the model.",
      ]);
      notes.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

