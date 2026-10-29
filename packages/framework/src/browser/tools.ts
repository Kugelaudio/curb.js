/**
 * The tools a coding agent works on a browser project with: a hosting platform carries each
 * call from the agent to the open tab (`relay.ts`), and this module answers it from the
 * project the page keeps (the tool list is in `docs/browser.md`). Limits keep every answer
 * small enough for one tool result: 2,000 entries or lines, 60 KB of text, 200 matches.
 *
 * Everything that changes the project goes through `ToolHost.change`, which reloads the
 * agent as `curb dev` does after a save and answers how the reload went. Turns and
 * authoring checks run against the agent itself (`agent-turns.ts`).
 */

import type { AuthoringDiagnostic } from "../authoring.js";
import { parseRecord, type JournalRecord } from "../server/conversation-journal.js";
import type { AgentTurns } from "./agent-turns.js";
import { npmInstall, NpmInstallError, npmUninstall, type ProjectChange } from "./npm-install.js";
import { binaryFilesOf } from "./project-sync.js";

/** A refused or failed call: `code` is stable, `message` is for the coding agent. */
export class ToolError extends Error {
  override readonly name = "ToolError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ToolDiagnostic = Pick<AuthoringDiagnostic, "code" | "severity" | "message"> & { location?: string; fix?: string };

/**
 * How the agent took a change: it reloaded on it, failed to load it, the change did not touch
 * it, or it had not reloaded yet when the wait ended (a running reply or call holds a reload).
 */
export type Reload = {
  state: "reloaded" | "failed" | "unchanged" | "pending";
  ms?: number;
  message?: string;
  diagnostics?: ToolDiagnostic[];
};

export type AgentState = "serving" | "reloading" | "down";

/** What the page gives the tools. */
export interface ToolHost {
  /** The project, path -> text (`node_modules/` included). */
  readonly files: ReadonlyMap<string, string>;
  /** Write and delete, then wait for the agent to reload when the change touches it. */
  change(change: ProjectChange): Promise<Reload>;
  /** Restart the agent on the project as it is. */
  restart(): Promise<Reload>;
  /** The conversation journal the workers wrote (`conversations.jsonl`), or "" before any. */
  journal(): string;
  /** The agent's state and the last lines it logged, oldest first. */
  log(): { state: AgentState; lines: readonly string[]; lastError: string | null };
  /** Ask the person in the tab for a secret's value; it goes to `.env`, never to the caller. */
  requestSecret(name: string): void;
  /** Lines `npm install` and `npm uninstall` print. */
  npmLog(line: string): void;
}

const MAX_LIST = 2000;
const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 60_000;
const MAX_MATCHES = 200;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_LOG_LINES = 1000;
const MAX_CONVERSATION_BYTES = 60_000;

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

function isEnvFile(path: string): boolean {
  const name = path.split("/").at(-1)!;
  return (name === ".env" || name.startsWith(".env.")) && name !== ".env.example";
}

/** The path, checked: project-relative, no `..`, no `.env` file; for a write, nothing the page or npm owns. */
export function checkPath(path: unknown, access: "read" | "write"): string {
  if (typeof path !== "string" || path.trim() === "") throw new ToolError("path_invalid", "A path is required.");
  const clean = path.trim().replace(/^\.\//, "");
  if (clean.startsWith("/") || clean.includes("\\") || clean.split("/").some((part) => part === ".." || part === "")) {
    throw new ToolError("path_invalid", `"${path}" is not a project-relative path (no leading "/", no "..").`);
  }
  if (isEnvFile(clean)) {
    throw new ToolError("path_refused", `${clean} holds secrets and stays in the browser; ask for a value with agent_request_secret.`);
  }
  if (access === "write") {
    if (/^(node_modules|vendor|\.curb)\//.test(clean) || clean === "package-lock.json") {
      throw new ToolError("path_refused", `${clean} is managed by the page (packages: agent_add_dependency, agent_remove_dependency).`);
    }
  }
  return clean;
}

/** A project file the coding agent sees: no installed packages, no secrets. */
function visible(path: string): boolean {
  return !path.startsWith("node_modules/") && !path.includes("/node_modules/") && !isEnvFile(path);
}

function text(input: Record<string, unknown>, field: string, options: { empty?: boolean } = {}): string {
  const value = input[field];
  if (typeof value !== "string" || (!options.empty && value === "")) throw new ToolError("input_invalid", `"${field}" must be a non-empty string.`);
  return value;
}

function whole(input: Record<string, unknown>, field: string, fallback: number, max: number): number {
  const value = input[field];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new ToolError("input_invalid", `"${field}" must be a whole number.`);
  return Math.min(value, max);
}

/** `src/**\/*.tsx` as a regular expression over project paths. */
export function globPattern(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      source += glob[index + 2] === "/" ? "(?:.*/)?" : ".*";
      index += glob[index + 2] === "/" ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

type Conversation = {
  id: number;
  agentId: string;
  startedAt: string;
  messages: Map<number, { writtenAt: string; message: Extract<JournalRecord, { t: "message" }>["message"] }>;
};

/** The journal's conversations, as `ConversationStore` replays it (a later record wins). */
function conversations(journal: string): Map<number, Conversation> {
  const out = new Map<number, Conversation>();
  const lines = journal.split("\n").filter((line) => line.trim() !== "");
  lines.forEach((line, index) => {
    let record: JournalRecord;
    try {
      record = parseRecord(line);
    } catch (error) {
      // A torn last line is a write the tab did not finish; the store skips it too.
      if (index === lines.length - 1) return;
      throw new ToolError("journal_invalid", `The conversation journal is damaged at line ${index + 1}: ${(error as Error).message}`);
    }
    if (record.t === "conversation") {
      out.set(record.id, { id: record.id, agentId: record.agentId, startedAt: record.startedAt, messages: new Map() });
    } else if (record.t === "message") {
      out.get(record.conversation)?.messages.set(record.seq, { writtenAt: record.writtenAt, message: record.message });
    }
  });
  return out;
}

export type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

/** Every tool the tab answers, by its name in the contract. */
export function browserTools(host: ToolHost, turns: AgentTurns): Record<string, ToolHandler> {
  const files = () => host.files;
  /** The binary files this project has (the page ships them): those its package.json depends on. */
  const binaries = () => binaryFilesOf(files());

  return {
    async list_files(input) {
      const dir = input.dir === undefined ? "" : checkPath(input.dir, "read").replace(/\/$/, "");
      const prefix = dir === "" ? "" : `${dir}/`;
      const paths = [...files().keys(), ...binaries().map(([path]) => path)].filter((path) => visible(path) && path.startsWith(prefix)).sort();
      const dirs = new Set<string>();
      for (const path of paths) {
        const parts = path.slice(prefix.length).split("/");
        for (let depth = 1; depth < parts.length; depth++) dirs.add(prefix + parts.slice(0, depth).join("/"));
      }
      const entries = [
        ...[...dirs].map((path) => ({ path, type: "dir" as const })),
        ...paths.map((path) => ({ path, type: "file" as const, ...(files().has(path) ? { size: new TextEncoder().encode(files().get(path)!).length } : {}) })),
      ].sort((a, b) => (a.path < b.path ? -1 : 1));
      return { entries: entries.slice(0, MAX_LIST), truncated: entries.length > MAX_LIST };
    },

    async read_file(input) {
      const path = checkPath(input.path, "read");
      const content = files().get(path);
      if (content === undefined) throw new ToolError("file_not_found", `${path} does not exist.`);
      const all = content.split("\n");
      const offset = whole(input, "offset", 0, all.length);
      const limit = Math.max(1, whole(input, "limit", MAX_READ_LINES, MAX_READ_LINES));
      const out: string[] = [];
      let bytes = 0;
      for (let index = offset; index < Math.min(all.length, offset + limit); index++) {
        const line = `${String(index + 1).padStart(6)}\t${all[index]}`;
        bytes += line.length + 1;
        if (bytes > MAX_READ_BYTES && out.length > 0) break;
        out.push(line);
      }
      return { path, content: out.join("\n"), offset, lines: out.length, totalLines: all.length, truncated: offset + out.length < all.length };
    },

    async search(input) {
      const pattern = text(input, "pattern");
      let expression: RegExp;
      try {
        expression = new RegExp(pattern);
      } catch (error) {
        throw new ToolError("input_invalid", `"${pattern}" is not a regular expression: ${(error as Error).message}`);
      }
      const only = typeof input.glob === "string" && input.glob !== "" ? globPattern(input.glob) : null;
      const matches: Array<{ path: string; line: number; text: string }> = [];
      let truncated = false;
      for (const path of [...files().keys()].filter(visible).sort()) {
        if (only && !only.test(path)) continue;
        const lines = files().get(path)!.split("\n");
        for (let index = 0; index < lines.length; index++) {
          if (!expression.test(lines[index]!)) continue;
          if (matches.length === MAX_MATCHES) {
            truncated = true;
            break;
          }
          matches.push({ path, line: index + 1, text: lines[index]!.slice(0, 400) });
        }
        if (truncated) break;
      }
      return { matches, truncated };
    },

    async write_file(input) {
      const path = checkPath(input.path, "write");
      const content = text(input, "content", { empty: true });
      const bytes = new TextEncoder().encode(content).length;
      if (bytes > MAX_WRITE_BYTES) throw new ToolError("file_too_large", `${path} would be ${bytes} bytes; at most 1 MiB.`);
      const reload = await host.change({ writes: new Map([[path, content]]), deletes: [] });
      return { path, bytes, reload };
    },

    async edit_file(input) {
      const path = checkPath(input.path, "write");
      const oldText = text(input, "oldText");
      const newText = text(input, "newText", { empty: true });
      const content = files().get(path);
      if (content === undefined) throw new ToolError("file_not_found", `${path} does not exist.`);
      const at = content.indexOf(oldText);
      if (at === -1) throw new ToolError("edit_no_match", `oldText does not occur in ${path}; read the file and copy the text exactly.`);
      const count = content.split(oldText).length - 1;
      if (count > 1) throw new ToolError("edit_not_unique", `oldText occurs ${count} times in ${path}; include surrounding lines to make it unique.`);
      const next = content.slice(0, at) + newText + content.slice(at + oldText.length);
      const reload = await host.change({ writes: new Map([[path, next]]), deletes: [] });
      return { path, line: content.slice(0, at).split("\n").length, reload };
    },

    async delete_file(input) {
      const path = checkPath(input.path, "write");
      if (!files().has(path)) throw new ToolError("file_not_found", `${path} does not exist.`);
      const reload = await host.change({ writes: new Map(), deletes: [path] });
      return { path, deleted: true, reload };
    },

    async add_dependency(input) {
      const name = text(input, "name").trim();
      const version = typeof input.version === "string" && input.version.trim() !== "" ? input.version.trim() : null;
      let change: ProjectChange;
      try {
        change = await npmInstall([version ? `${name}@${version}` : name], files(), (line) => host.npmLog(line));
      } catch (error) {
        if (error instanceof NpmInstallError) throw new ToolError("dependency_failed", error.message);
        throw error;
      }
      const lock = JSON.parse(change.writes.get("package-lock.json")!) as { packages: Record<string, { version?: string }> };
      const added = `${name}@${lock.packages[`node_modules/${name}`]?.version ?? "?"}`;
      return { added: [added], reload: await host.change(change) };
    },

    async remove_dependency(input) {
      const name = text(input, "name").trim();
      let change: ProjectChange;
      try {
        change = npmUninstall(name, files(), (line) => host.npmLog(line));
      } catch (error) {
        if (error instanceof NpmInstallError) throw new ToolError("dependency_failed", error.message);
        throw error;
      }
      return { removed: name, reload: await host.change(change) };
    },

    check: () => turns.check(),

    async say(input) {
      return turns.say(text(input, "text"), input.new === true);
    },

    async get_log(input) {
      const { state, lines, lastError } = host.log();
      const grep = typeof input.grep === "string" && input.grep !== "" ? input.grep : null;
      const selected = grep ? lines.filter((line) => line.includes(grep)) : lines;
      const count = Math.max(1, whole(input, "lines", 200, MAX_LOG_LINES));
      return { state, log: selected.slice(-count).join("\n"), truncated: selected.length > count, lastError };
    },

    async restart() {
      return { reload: await host.restart() };
    },

    async list_conversations(input) {
      const limit = Math.max(1, whole(input, "limit", 20, 100));
      const recorded = [...conversations(host.journal()).values()].filter((conversation) => conversation.messages.size > 0);
      return {
        conversations: recorded
          .sort((a, b) => b.id - a.id)
          .slice(0, limit)
          .map((conversation) => {
            const messages = [...conversation.messages.values()];
            return {
              id: conversation.id,
              agentId: conversation.agentId,
              startedAt: conversation.startedAt,
              turns: messages.filter((entry) => entry.message.role === "user").length,
              toolCalls: messages.filter((entry) => entry.message.role === "tool").length,
              lastAt: messages.map((entry) => entry.writtenAt).sort().at(-1) ?? null,
            };
          }),
      };
    },

    async get_conversation(input) {
      const id = Number(input.id);
      const conversation = conversations(host.journal()).get(id);
      if (!Number.isInteger(id) || !conversation) throw new ToolError("conversation_not_found", `No conversation ${String(input.id)}.`);
      const messages = [...conversation.messages.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, { writtenAt, message }]) => ({
          role: message.role,
          content: message.content,
          ...(message.role === "assistant" && message.toolCalls ? { tool_calls: message.toolCalls } : {}),
          ...(message.role === "tool" ? { tool_name: message.toolName, tool_result: message.result } : {}),
          created_at: writtenAt,
        }));
      // Newest messages first out when the conversation is over the limit: the end is what went wrong.
      let kept = messages;
      while (kept.length > 1 && JSON.stringify(kept).length > MAX_CONVERSATION_BYTES) kept = kept.slice(1);
      return {
        conversations: [{ id: conversation.id, agentId: conversation.agentId, startedAt: conversation.startedAt, messages: kept }],
        truncated: kept.length < messages.length,
      };
    },

    async request_secret(input) {
      const name = text(input, "name").trim();
      if (!SECRET_NAME.test(name)) throw new ToolError("input_invalid", `"${name}" is not an environment variable name (A-Z, 0-9, _).`);
      host.requestSecret(name);
      return { requested: true, name };
    },
  };
}
