import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadRun, type ConversationReplies, type ReplyRequest, type RunReplies, type TestRun } from "../../testing/index.js";
import type { SavedConversation } from "./types.js";

/**
 * What the reply store answered, as `curb test` reports it: per conversation the turn its first
 * live request came in and what about that request changed, and per scenario one line, "stored"
 * or "live from turn 2 (system prompt changed)". What changed is found by comparing the request,
 * part by part, with the same request (the same scenario, run, role and count) of the newest
 * saved run that recorded it. Every request before the first live one was answered from the
 * store, so both runs asked the same until there.
 */

/** Where `curb test` saves its runs, relative to the project. */
const RUNS_DIR = join(".curb", "test-runs");

/** The project's saved runs, newest first; a file that cannot be read is left out. */
export function savedRuns(projectRoot: string): TestRun[] {
  let ids: string[];
  try {
    ids = readdirSync(join(projectRoot, RUNS_DIR))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort()
      .reverse();
  } catch {
    // KEEP-JUSTIFIED: no directory IS the answer "no saved runs".
    return [];
  }
  return ids.flatMap((id) => {
    try {
      return [loadRun(id, { root: projectRoot })];
    } catch {
      // KEEP-JUSTIFIED: a file this version cannot read holds no requests to compare with.
      return [];
    }
  });
}

const runKey = (file: string, name: string, run: number) => `${file}\n${name}\n${run}`;

/** The requests each scenario run made the last time a saved run recorded them, by file, name
 * and run (from 1): what this run's requests are compared with. */
export type RepliesBaseline = { requestsOf(file: string, name: string, run: number): readonly ReplyRequest[] | undefined };

export function repliesBaseline(runs: readonly TestRun[]): RepliesBaseline {
  const newest = new Map<string, ReplyRequest[]>();
  for (const run of runs) {
    for (const conversation of run.conversations) {
      const requests = conversation.replies?.requests;
      const key = runKey(conversation.scenario.file, conversation.scenario.name, conversation.scenario.run);
      if (requests && !newest.has(key)) newest.set(key, requests);
    }
  }
  return { requestsOf: (file, name, run) => newest.get(runKey(file, name, run)) };
}

/** How many requests a run had made when one of its turns ended. */
export type TurnEnd = { turn: number; requests: number };

/** The turn request `index` came in: the first turn that ended after it; null after the last. */
function turnOf(index: number, ends: readonly TurnEnd[]): number | null {
  return ends.find((end) => end.requests > index)?.turn ?? null;
}

const PART_NAMES: ReadonlyArray<[keyof ReplyRequest["parts"], string]> = [
  ["model", "model"],
  ["settings", "model settings"],
  ["system", "system prompt"],
  ["tools", "tools"],
  ["context", "context"],
];

/** What a message of the conversation is, as the one who asks reads it. */
function messageName(role: ReplyRequest["role"], message: string): string {
  const kind = message.slice(0, message.indexOf(":"));
  if (role === "judge") return "transcript";
  if (kind === "tool") return "a tool result";
  if (role === "caller") return kind === "assistant" ? "an earlier caller line" : "the agent's words";
  return kind === "assistant" ? "an earlier reply" : "the caller's words";
}

/**
 * What about `now` differs from `before`, the same request of an earlier run, in a few words:
 * "system prompt changed", "context and tools changed", "the caller's words changed". A request
 * the earlier run did not make, or no earlier run to compare with, says so; one whose parts are
 * all the same was simply not in the store.
 */
export function changedPart(now: ReplyRequest, before: ReplyRequest | undefined, compared: boolean): string {
  if (!compared) return "no earlier run to compare with";
  if (!before) return "a request the earlier run did not make";
  const parts = PART_NAMES.filter(([part]) => now.parts[part] !== before.parts[part]).map(([, name]) => name);
  const at = now.messages.findIndex((message, index) => message !== before.messages[index]);
  if (at >= 0) parts.push(messageName(now.role, now.messages[at]!));
  else if (before.messages.length > now.messages.length) parts.push(now.role === "judge" ? "transcript" : "the conversation so far");
  if (parts.length === 0) return "not in the reply store";
  const listed = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `${now.role === "agent" || now.role === "judge" ? "" : `${now.role}: `}${listed} changed`;
}

/**
 * A conversation's `replies` from what the store answered in its run (`runReplies`) and when its
 * turns ended: each request with its turn, and the first live one with what changed since
 * `before`, the requests of the same run of the scenario in the newest saved run.
 */
export function conversationReplies(replies: RunReplies, ends: readonly TurnEnd[], before: readonly ReplyRequest[] | undefined): ConversationReplies {
  const requests = replies.requests.map((request, index) => ({ ...request, turn: turnOf(index, ends) }));
  const first = requests.findIndex((request) => request.live);
  const out: ConversationReplies = { stored: replies.stored, live: replies.live, requests };
  if (first < 0) return out;
  const request = requests[first]!;
  // The same request of the earlier run: the same role, asked as many times before.
  const ordinal = requests.slice(0, first).filter((earlier) => earlier.role === request.role).length;
  const earlier = before?.filter((candidate) => candidate.role === request.role)[ordinal];
  return { ...out, from: { turn: request.turn, role: request.role, changed: changedPart(request, earlier, before !== undefined) } };
}

/** Where a conversation went live, as its line says it: the agent's opening is turn 0. */
export function liveFrom(from: NonNullable<ConversationReplies["from"]>): string {
  const where = from.turn === 0 ? "the opening" : from.turn !== null ? `turn ${from.turn}` : from.role === "judge" ? "the judge" : "the end of the call";
  return `live from ${where} (${from.changed})`;
}

/** What the store answered for one scenario: requests answered and sent, and its line. */
export type ScenarioReplies = { stored: number; live: number; summary: string };

/**
 * One scenario's line: "stored" when the store answered every request of every run, else where
 * its first run that went live went live ("live from turn 2 (context changed)"), and in how many
 * of its runs that happened when it ran more than once. Undefined when no run was played with a
 * store.
 */
export function scenarioReplies(conversations: readonly SavedConversation[]): ScenarioReplies | undefined {
  const played = conversations.filter((conversation) => conversation.replies !== undefined);
  if (played.length === 0) return undefined;
  const stored = played.reduce((sum, conversation) => sum + conversation.replies!.stored, 0);
  const live = played.reduce((sum, conversation) => sum + conversation.replies!.live, 0);
  const wentLive = [...played].sort((a, b) => a.scenario.run - b.scenario.run).filter((conversation) => conversation.replies!.from);
  if (wentLive.length === 0) return { stored, live, summary: "stored" };
  const runs = played.length > 1 ? ` in ${wentLive.length} of ${played.length} runs` : "";
  return { stored, live, summary: `${liveFrom(wentLive[0]!.replies!.from!)}${runs}` };
}
