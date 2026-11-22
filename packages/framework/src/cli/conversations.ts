/**
 * `curb conversations`: the project's recorded conversations, to see what went wrong and
 * improve the agent. Every conversation `curb dev` runs (typed and voice) is mirrored into
 * `.data/conversations.jsonl` (server/conversation-store.ts), with every tool call, its input
 * and its result. `curb say` and `curb test` keep their own record and turn this off
 * (headless-project.ts). Reads only; nothing leaves the machine.
 *
 *   curb conversations                 the last 3, newest last
 *   curb conversations --last 10       the last 10
 *   curb conversations --id 42         one conversation
 *   curb conversations --json          the same as one JSON object, unclipped
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ConversationStore, DEFAULT_CONVERSATIONS_PATH, legacyHistoryNotice } from "../server/conversation-store.js";

export const CONVERSATIONS_USAGE = `Usage: curb conversations [--last <n> | --id <id>] [--json]

Prints the project's recorded conversations (curb dev) with every
message, tool call, tool input and tool result, newest last. Read them to see where the agent
went wrong before changing it.

  --last <n>   the last n conversations (default 3)
  --id <id>    one conversation by its id (the number after "conversation")
  --json       one JSON object {"conversations":[...]}, nothing clipped`;

type Options = { last: number; id: number | null; json: boolean };

/** The parsed flags, or an Error naming the one that is wrong. */
export function parseConversationsArgs(args: readonly string[]): Options | Error {
  const options: Options = { last: 3, id: null, json: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--json") {
      options.json = true;
      continue;
    }
    if (flag !== "--last" && flag !== "--id") return new Error(`Unknown argument ${flag}.\n\n${CONVERSATIONS_USAGE}`);
    const value = Number(args[++index]);
    if (!Number.isInteger(value) || value < 1) return new Error(`${flag} takes a whole number of 1 or more.`);
    if (flag === "--last") options.last = value;
    else options.id = value;
  }
  return options;
}

type Message = ReturnType<ConversationStore["listMessages"]>[number];
/** A recorded conversation as `--json` prints it. */
export type RecordedConversation = { id: number; agentId: string; startedAt: string; messages: Message[] };

/** The conversations the options select, oldest first. */
export function readConversations(store: ConversationStore, options: Options): RecordedConversation[] {
  const heads = options.id !== null
    ? store.listConversations(Number.MAX_SAFE_INTEGER).filter((head) => head.id === options.id)
    : store.listConversations(options.last).reverse();
  return heads.map((head) => ({
    id: head.id,
    agentId: head.agent_id,
    startedAt: head.started_at,
    messages: store.listMessages(head.id),
  }));
}

/** Where conversations are recorded, as configured: a path, relative to the project unless it
 * is absolute. Null when recording is off. */
export function conversationsFile(env: NodeJS.ProcessEnv): string | null {
  const configured = env.KUGEL_CONVERSATIONS_DB;
  return configured === "off" || configured === "0" ? null : (configured ?? DEFAULT_CONVERSATIONS_PATH);
}

/** The conversations of the store at `file` that the options select, oldest first; none when
 * the project never talked. */
export function recordedConversations(projectRoot: string, file: string, options: Options): RecordedConversation[] {
  const path = isAbsolute(file) ? file : join(projectRoot, file);
  // A project that never talked has no file yet, and reading must not create one.
  if (!existsSync(path)) return [];
  const store = new ConversationStore(path);
  try {
    return readConversations(store, options);
  } finally {
    store.close();
  }
}

/** The conversations as `curb conversations` prints them. */
export function formatConversations(conversations: readonly RecordedConversation[]): string[] {
  const lines: string[] = [];
  for (const conversation of conversations) {
    lines.push("", `=== conversation ${conversation.id}, agent ${conversation.agentId}, started ${conversation.startedAt} ===`);
    for (const message of conversation.messages) {
      const time = message.created_at.slice(11, 19);
      if (message.role === "tool") {
        lines.push(`  [${time}] tool ${message.tool_name} -> ${clip(message.tool_result ?? "", 400)}`);
        continue;
      }
      const label = message.role === "user" ? "caller" : "agent ";
      if (message.content) lines.push(`  [${time}] ${label} ${clip(message.content, 500)}`);
      if (message.tool_calls) {
        for (const call of JSON.parse(message.tool_calls) as Array<{ name: string; input: unknown }>) {
          lines.push(`  [${time}] call ${call.name} ${clip(JSON.stringify(call.input), 300)}`);
        }
      }
    }
  }
  return lines;
}

/** Runs the command; returns the exit code. */
export function conversationsCommand(
  args: readonly string[],
  projectRoot: string,
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  env: NodeJS.ProcessEnv = process.env,
): number {
  const options = parseConversationsArgs(args);
  if (options instanceof Error) {
    process.stderr.write(`${options.message}\n`);
    return 2;
  }
  const relative = conversationsFile(env);
  if (relative === null) {
    out("Conversations are not recorded here (KUGEL_CONVERSATIONS_DB is off).");
    return 0;
  }
  // On stderr, so --json stays one JSON object on stdout.
  const notice = legacyHistoryNotice(isAbsolute(relative) ? relative : join(projectRoot, relative));
  if (notice) process.stderr.write(`${notice}\n`);
  const conversations = recordedConversations(projectRoot, relative, options);
  if (options.json) {
    out(JSON.stringify({ conversations }));
    return 0;
  }
  if (conversations.length === 0) {
    out(options.id !== null
      ? `No conversation ${options.id} in ${relative}.`
      : `No conversations recorded yet in ${relative}: talk to the agent in the preview (npm run dev). curb say and curb test are not recorded.`);
    return options.id !== null ? 1 : 0;
  }
  for (const line of formatConversations(conversations)) out(line);
  return 0;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}... (${flat.length} chars)` : flat;
}
