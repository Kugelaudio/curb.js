import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AgentLlmClient, AgentLlmStreamStep } from "../agent-session.js";
import type { AgentModelUsage } from "../llm/ai-sdk.js";
import { serializeLlmInput } from "../llm/serialize-input.js";
import type { AgentRunRequest, AgentRunResponse, AgentStreamPart } from "../llm/types.js";
import type { LlmDescriptor } from "../providers.js";
import { modelFor, modelLabel, type CallBundle, type SimulatorRole, type TestHost } from "./host.js";
import type { TokenUsage } from "./usage.js";

/**
 * The reply store: model replies a test has had before, looked up by the exact request.
 *
 * A host wrapped by {@link withReplyStore} answers each model request (the agent's, the simulated
 * caller's and the judge's) from the store when it holds a reply to exactly that request, and
 * calls the model only on a miss, storing what it answered. Nothing else in Curb knows about the
 * store. The remote protocol is on the guide's `reply-store.md` page.
 *
 *   import { localReplyStore, projectHost, withReplyStore } from "curb/testing";
 *   const host = withReplyStore(projectHost(), localReplyStore());
 */

/** One stored model reply. Only the reply is kept, never the request it answered. */
export type StoredReply = {
  /** The format of this record: 1. */
  v: 1;
  /** The request's key: the sha256 of its canonical JSON, hex. */
  key: string;
  /** The model that answered, as `provider:model`. */
  model: string;
  /** When the reply was stored, as an ISO date-time. */
  createdAt: string;
  /** The tokens the request used when it went to the model; null where the provider said none. */
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } | null;
  /** The reply as the model client received it, as JSON. */
  response: unknown;
};

/** Where stored replies live. `get` answers null for a key it does not hold; `put` of a key it
 * already holds keeps the reply it has. Either may throw: a store that fails is skipped, and a
 * test never fails because of it. */
export type ReplyStore = {
  get(key: string): Promise<StoredReply | null>;
  put(key: string, reply: StoredReply): Promise<void>;
};

/** The format of a key's request and of a stored reply. Raised when either changes, so no reply
 * stored under the old one is read as an answer to a request of the new one. */
const FORMAT = 1;

/**
 * The instant the agent's date line shows in a test with the reply store on, unless the
 * scenario's `now` or `CURB_TEST_NOW` names another: a Wednesday afternoon, far from any year's
 * end. Fixed, so a request is the same today and next month.
 */
export const DEFAULT_TEST_NOW = "2026-06-03T15:00:00.000Z";

/** The instant a test's agent sees: `now`, else `CURB_TEST_NOW`, else {@link DEFAULT_TEST_NOW}.
 * Throws, naming the value, when the one given is not a date-time. */
export function testNow(now?: string, env: Readonly<Record<string, string | undefined>> = process.env): Date {
  const [named, from] = now !== undefined ? [now, "now"] : env.CURB_TEST_NOW ? [env.CURB_TEST_NOW, "CURB_TEST_NOW"] : [DEFAULT_TEST_NOW, ""];
  const at = new Date(named);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`${from}: "${named}" is not a date-time. Fix: give an ISO date-time such as "2026-10-30T15:00:00Z".`);
  }
  return at;
}

/** JSON with every object's keys in order and `undefined` left out, so equal values are equal
 * text whichever order their keys were written in. Arrays keep their order: it is part of what
 * the model reads. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : sorted(item)));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined && typeof item !== "function") out[key] = sorted(item);
  }
  return out;
}

/** What a key is made of: who asks, which model with which settings, what it reads, and which
 * run of the test it belongs to. */
export type ReplyKeyParts = {
  role: "agent" | SimulatorRole;
  model: string;
  settings: unknown;
  system: string;
  messages: unknown;
  tools: unknown;
  run: number;
};

/** The key of a request: the sha256 of the canonical JSON of its parts, hex. */
export function replyKey(parts: ReplyKeyParts): string {
  return createHash("sha256").update(canonicalJson({ v: FORMAT, ...parts })).digest("hex");
}

/** The parts of a request as the provider receives it: the system prompt with the context
 * protocol, the messages with the current context last, and the tools in the order offered.
 * Nothing the session keeps for itself (timestamps, the signal) is in it. */
export function requestParts(request: AgentRunRequest): Pick<ReplyKeyParts, "system" | "messages" | "tools"> {
  const input = serializeLlmInput(request);
  return {
    system: input.system,
    messages: input.messages,
    tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
  };
}

/** The model of a key: its label and its settings (the endpoint, sampling, reasoning). */
function modelParts(llm: LlmDescriptor): Pick<ReplyKeyParts, "model" | "settings"> {
  const { model: _model, ...settings } = llm.options as Record<string, unknown>;
  return { model: modelLabel(llm), settings: { provider: llm.provider, ...settings } };
}

// ---------------------------------------------------------------------------------------------
// Runs and calls.

/** One call of a test: which run it is, whether it went live, and what the store answered. */
type CallScope = { run: number; live: boolean; stored: number; liveRequests: number };

const scopes = new AsyncLocalStorage<CallScope>();

/**
 * Plays `play` as run `run` (from 0) of a test: every model request inside it, the agent's, the
 * caller's and the judge's, is keyed by that run, so `runs: 3` keeps three samples of each
 * request and run 2 answers from run 2's replies. Inside it the requests are one call: the first
 * that is not stored makes the rest go to the model, as each later request holds a reply no run
 * had before. `curb test` plays each run of a scenario in one. Outside any, the run is 0 and each
 * agent and each model is a call of its own.
 */
export function asRun<T>(run: number, play: () => Promise<T>): Promise<T> {
  if (!Number.isInteger(run) || run < 0) throw new Error(`asRun: run must be a whole number from 0, not ${run}.`);
  return scopes.run({ run, live: false, stored: 0, liveRequests: 0 }, play);
}

/** How many of the current run's model requests the store answered and how many went to a
 * model; null outside {@link asRun}. */
export function runReplies(): { stored: number; live: number } | null {
  const scope = scopes.getStore();
  return scope ? { stored: scope.stored, live: scope.liveRequests } : null;
}

// ---------------------------------------------------------------------------------------------
// The wrapped host.

/** What a host wrapped by {@link withReplyStore} saw so far: requests answered from the store
 * and the tokens they would have cost, and requests that went to a model and what they cost. */
export type ReplyStoreStats = { hits: number; misses: number; liveTokens: number; savedTokens: number };

const statsOf = new WeakMap<TestHost, ReplyStoreStats>();

/** What `host` answered from its reply store so far; null for a host without one. */
export function replyStoreStats(host: TestHost): ReplyStoreStats | null {
  const stats = statsOf.get(host);
  return stats ? { ...stats } : null;
}

const tokensIn = (usage: StoredReply["usage"]): number =>
  usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : 0;

/** The reply a model gave, as a store keeps it: a copy that shares nothing with what the session
 * holds, without the fields that say how it ended. */
function asJson(response: AgentRunResponse): unknown {
  const { cutOff: _cutOff, ...kept } = response;
  return JSON.parse(JSON.stringify(kept));
}

function isResponse(value: unknown): value is AgentRunResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AgentRunResponse).text === "string" &&
    Array.isArray((value as AgentRunResponse).toolCalls)
  );
}

/** A stored reply as the model client returns it: a fresh copy each time. */
const responseOf = (stored: StoredReply): AgentRunResponse => structuredClone(stored.response) as AgentRunResponse;

/** A reply played back on the streaming transport: its words in one piece, then each tool
 * call's start, as a provider streams them. */
async function* replay(response: AgentRunResponse): AsyncGenerator<AgentStreamPart, AgentRunResponse> {
  if (response.text) yield { delta: response.text, text: response.text };
  for (const call of response.toolCalls) yield { type: "tool-input-start", toolName: call.name };
  return response;
}

const usageOf = (usage: AgentModelUsage | TokenUsage | null | undefined): StoredReply["usage"] => {
  if (!usage) return null;
  const out: NonNullable<StoredReply["usage"]> = {};
  for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    if (typeof usage[field] === "number") out[field] = usage[field];
  }
  return Object.keys(out).length > 0 ? out : null;
};

/** The difference of two token counts, as the tokens of the request between them. */
const usageBetween = (before: TokenUsage | null, after: TokenUsage | null): StoredReply["usage"] => {
  if (!after) return null;
  return usageOf({
    inputTokens: after.inputTokens - (before?.inputTokens ?? 0),
    outputTokens: after.outputTokens - (before?.outputTokens ?? 0),
    cacheReadTokens: after.cacheReadTokens - (before?.cacheReadTokens ?? 0),
    cacheWriteTokens: after.cacheWriteTokens - (before?.cacheWriteTokens ?? 0),
  });
};

/**
 * A host that answers each model request from `stores` when one holds its reply, and otherwise
 * asks `host`'s model and stores the reply. Given several stores, the first that holds a reply
 * answers, and a reply found in a later one is copied to the earlier ones (local first, then
 * remote).
 */
export function withReplyStore(host: TestHost, stores: ReplyStore | readonly ReplyStore[]): TestHost {
  const layers: readonly ReplyStore[] = Array.isArray(stores) ? stores : [stores as ReplyStore];
  const stats: ReplyStoreStats = { hits: 0, misses: 0, liveTokens: 0, savedTokens: 0 };
  /** Replies of this process by key: what a store that failed to keep one still answers. */
  const answered = new Map<string, StoredReply>();
  /** Requests on their way to a model, by key: an identical one waits for the same reply. */
  const inFlight = new Map<string, Promise<StoredReply | null>>();
  const failedStores = new Set<ReplyStore>();
  const failed = (store: ReplyStore, error: unknown) => {
    if (failedStores.has(store)) return;
    failedStores.add(store);
    const reason = error instanceof Error ? error.message : String(error);
    const which = layers.length > 1 ? `reply store ${layers.indexOf(store) + 1} of ${layers.length}` : "the reply store";
    console.error(`note: ${which} failed (${reason}); the test goes on with the other stores, else with the model.`);
  };

  const lookup = async (key: string): Promise<StoredReply | null> => {
    const kept = answered.get(key);
    if (kept) return kept;
    for (const [index, store] of layers.entries()) {
      if (failedStores.has(store)) continue;
      let found: StoredReply | null;
      try {
        found = await store.get(key);
      } catch (error) {
        failed(store, error);
        continue;
      }
      if (!found || found.key !== key || !isResponse(found.response)) continue;
      // A reply found further down is copied up, so the next lookup ends at the first store.
      for (const earlier of layers.slice(0, index)) {
        if (!failedStores.has(earlier)) earlier.put(key, found).catch((error: unknown) => failed(earlier, error));
      }
      answered.set(key, found);
      return found;
    }
    return null;
  };

  const save = async (reply: StoredReply): Promise<void> => {
    answered.set(reply.key, reply);
    await Promise.all(
      layers.map(async (store) => {
        if (failedStores.has(store)) return;
        try {
          await store.put(reply.key, reply);
        } catch (error) {
          failed(store, error);
        }
      }),
    );
  };

  const record = (key: string, model: string, response: AgentRunResponse, usage: StoredReply["usage"]): StoredReply | null => {
    stats.misses += 1;
    stats.liveTokens += tokensIn(usage);
    // A reply cut off at the output limit is not the model's answer: it is never kept.
    if (response.cutOff) return null;
    return { v: FORMAT, key, model, createdAt: new Date().toISOString(), usage, response: asJson(response) };
  };

  /**
   * The start of a request: a stored reply to `key`, or the right to ask the model for it. The
   * key is claimed before the store is read, so an identical request meanwhile waits for this
   * one's reply instead of asking too; when this one fails, the next asks. Once the call went
   * live, no store is read.
   */
  const begin = async (key: string, call: CallScope): Promise<{ found: StoredReply } | { settle: (reply: StoredReply | null) => void }> => {
    for (let waiting = inFlight.get(key); waiting; waiting = inFlight.get(key)) {
      const shared = await waiting.catch(() => null);
      if (shared) return { found: shared };
    }
    let resolve: (reply: StoredReply | null) => void = () => {};
    const pending = new Promise<StoredReply | null>((done) => (resolve = done));
    inFlight.set(key, pending);
    const settle = (reply: StoredReply | null) => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
      resolve(reply);
    };
    const found = call.live ? (answered.get(key) ?? null) : await lookup(key).catch(() => null);
    if (found) {
      settle(found);
      return { found };
    }
    call.live = true;
    call.liveRequests += 1;
    return { settle };
  };

  const hit = (found: StoredReply, call: CallScope) => {
    stats.hits += 1;
    stats.savedTokens += tokensIn(found.usage);
    call.stored += 1;
  };

  type Keyed = { key: string; model: string; call: CallScope };

  /** The non-streaming client of one call, keyed by `keyOf`. `usage` starts measuring a request
   * and answers what it used once it is over. */
  const client =
    (inner: AgentLlmClient, keyOf: (request: AgentRunRequest) => Keyed, usage: () => () => StoredReply["usage"]): AgentLlmClient =>
    async (request) => {
      const { key, model, call } = keyOf(request);
      const started = await begin(key, call);
      if ("found" in started) {
        hit(started.found, call);
        return responseOf(started.found);
      }
      let reply: StoredReply | null = null;
      try {
        const measure = usage();
        const response = await inner(request);
        reply = record(key, model, response, measure());
        if (reply) await save(reply);
        return response;
      } finally {
        started.settle(reply);
      }
    };

  /** The streaming client of one call, keyed by `keyOf`. */
  const streamClient =
    (inner: AgentLlmStreamStep, keyOf: (request: AgentRunRequest) => Keyed, usage: () => () => StoredReply["usage"]): AgentLlmStreamStep =>
    async function* (request) {
      const { key, model, call } = keyOf(request);
      const started = await begin(key, call);
      if ("found" in started) {
        hit(started.found, call);
        return yield* replay(responseOf(started.found));
      }
      let reply: StoredReply | null = null;
      try {
        const measure = usage();
        // A stream the session stops early (a barge-in) ends here without a reply to keep.
        const response = yield* inner(request);
        reply = record(key, model, response, measure());
        if (reply) await save(reply);
        return response;
      } finally {
        started.settle(reply);
      }
    };

  const wrapped: TestHost = {
    ...host,
    async createBundle(): Promise<CallBundle> {
      const bundle = await host.createBundle();
      bundle.session.useClock(() => testNow());
      const own: CallScope = { run: 0, live: false, stored: 0, liveRequests: 0 };
      const keyOf = (request: AgentRunRequest): Keyed => {
        const call = scopes.getStore() ?? own;
        const llm = bundle.runtime.settings.current().llm;
        const model = modelParts(llm);
        return { key: replyKey({ role: "agent", ...model, ...requestParts(request), run: call.run }), model: model.model, call };
      };
      // The bundle counts its own tokens: a request's are what the count grew by meanwhile.
      const measure = () => {
        const before = bundle.tokens?.() ?? null;
        return () => usageBetween(before, bundle.tokens?.() ?? null);
      };
      bundle.session.wrapLlm({
        llm: (llm) => client(llm, keyOf, measure),
        streamLlm: (streamLlm) => streamClient(streamLlm, keyOf, measure),
      });
      return bundle;
    },
    simulator(llm, role, onUsage, spec) {
      let last: StoredReply["usage"] = null;
      const inner = host.simulator(llm, role, (usage) => {
        last = usageOf(usage);
        onUsage(usage);
      }, spec);
      const model = modelParts(modelFor(spec, llm));
      const own: CallScope = { run: 0, live: false, stored: 0, liveRequests: 0 };
      const keyOf = (request: AgentRunRequest): Keyed => {
        const call = scopes.getStore() ?? own;
        return { key: replyKey({ role, ...model, ...requestParts(request), run: call.run }), model: model.model, call };
      };
      return client(inner, keyOf, () => {
        last = null;
        return () => last;
      });
    },
  };
  statsOf.set(wrapped, stats);
  return wrapped;
}

// ---------------------------------------------------------------------------------------------
// Stores.

/** Where the local store keeps its files when none is named: `CURB_REPLY_STORE_DIR`, else
 * `$XDG_CACHE_HOME/curb/replies`, else `~/.cache/curb/replies`. */
export function defaultReplyStoreDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (env.CURB_REPLY_STORE_DIR) return env.CURB_REPLY_STORE_DIR;
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "curb", "replies");
}

const KEY = /^[0-9a-f]{64}$/;

function checkedKey(key: string): string {
  if (!KEY.test(key)) throw new Error(`"${key}" is not a reply key (64 hex characters).`);
  return key;
}

/** A stored reply read back from its JSON, or null when it is not one. */
function parsedReply(text: string, key: string): StoredReply | null {
  const value = JSON.parse(text) as StoredReply;
  return value && value.v === FORMAT && value.key === key && isResponse(value.response) ? value : null;
}

/**
 * Stored replies as files under `dir`, one immutable gzip JSON file per key
 * (`<dir>/v1/<first two characters of the key>/<key>.json.gz`). Default dir:
 * `CURB_REPLY_STORE_DIR`, else `$XDG_CACHE_HOME/curb/replies`, else `~/.cache/curb/replies`,
 * outside the checkout so every worktree shares it.
 */
export function localReplyStore(options: { dir?: string } = {}): ReplyStore {
  const dir = options.dir ?? defaultReplyStoreDir();
  const fileOf = (key: string) => join(dir, `v${FORMAT}`, checkedKey(key).slice(0, 2), `${key}.json.gz`);
  return {
    async get(key) {
      let bytes: Buffer;
      try {
        bytes = await readFile(fileOf(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      try {
        return parsedReply(gunzipSync(bytes).toString("utf8"), key);
      } catch {
        // A file cut short (a full disk, a killed process) answers nothing; the next put replaces it.
        return null;
      }
    },
    async put(key, reply) {
      const file = fileOf(key);
      if ((await this.get(key)) !== null) return;
      await mkdir(dirname(file), { recursive: true });
      // Written beside it, then renamed: a reader sees the whole file or none.
      const partial = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.partial`;
      await writeFile(partial, gzipSync(JSON.stringify(reply)));
      await rename(partial, file);
    },
  };
}

/** Largest reply the remote protocol takes, in bytes of gzip JSON. */
const REMOTE_LIMIT = 1024 * 1024;

/**
 * Stored replies on a server that speaks the reply store protocol (`reply-store.md`). Default:
 * `CURB_REPLY_STORE_URL` and `CURB_REPLY_STORE_TOKEN`.
 */
export function remoteReplyStore(options: { url?: string; token?: string } = {}): ReplyStore {
  const base = (options.url ?? process.env.CURB_REPLY_STORE_URL ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("remoteReplyStore: no url. Fix: pass { url } or set CURB_REPLY_STORE_URL.");
  const token = options.token ?? process.env.CURB_REPLY_STORE_TOKEN;
  const headers = (extra: Record<string, string> = {}) => ({ ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra });
  const urlOf = (key: string) => `${base}/replies/${checkedKey(key)}`;
  /** Read-only once the server said so: no more puts are sent. */
  let readOnly = false;
  return {
    async get(key) {
      const response = await fetch(urlOf(key), { headers: headers({ accept: "application/json", "accept-encoding": "gzip" }), signal: AbortSignal.timeout(10_000) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GET ${base}/replies/… answered ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      // A server or proxy may have taken the gzip off already.
      const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
      return parsedReply(text, key);
    },
    async put(key, reply) {
      if (readOnly) return;
      const body = gzipSync(JSON.stringify(reply));
      if (body.length > REMOTE_LIMIT) return;
      const response = await fetch(urlOf(key), {
        method: "PUT",
        headers: headers({ "content-type": "application/json", "content-encoding": "gzip" }),
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 403) {
        readOnly = true;
        return;
      }
      // 409: another writer is storing this key right now, and the reply it stores is the same
      // one. 413: over the server's size limit. Neither is retried, and neither fails the test.
      if (response.status === 409 || response.status === 413) return;
      if (!response.ok) throw new Error(`PUT ${base}/replies/… answered ${response.status}`);
    },
  };
}
