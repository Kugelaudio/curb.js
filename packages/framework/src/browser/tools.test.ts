import { describe, expect, it } from "vitest";
import type { AgentTurns } from "./agent-turns.js";
import type { ProjectChange } from "./npm-install.js";
import { browserTools, checkPath, globPattern, ToolError, type Reload, type ToolHost } from "./tools.js";

function host(initial: Record<string, string>, extra: Partial<ToolHost> = {}) {
  const files = new Map(Object.entries(initial));
  const changes: ProjectChange[] = [];
  const secrets: string[] = [];
  const value: ToolHost = {
    files,
    async change(change) {
      changes.push(change);
      for (const path of change.deletes) files.delete(path);
      for (const [path, text] of change.writes) files.set(path, text);
      return { state: "reloaded", ms: 12 } satisfies Reload;
    },
    restart: async () => ({ state: "reloaded", ms: 30 }),
    journal: () => "",
    log: () => ({ state: "serving", lines: ["a", "b error here", "c"], lastError: null }),
    requestSecret: (name) => void secrets.push(name),
    npmLog: () => {},
    ...extra,
  };
  const tools = browserTools(value, {} as AgentTurns);
  return { tools, files, changes, secrets };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ToolError);
  return (error as ToolError).code;
}

describe("browser tools: paths", () => {
  it("refuses paths outside the project, .env files, and what npm or the page owns", () => {
    expect(checkPath("src/agent/agent.tsx", "write")).toBe("src/agent/agent.tsx");
    expect(checkPath("./README.md", "read")).toBe("README.md");
    expect(checkPath(".env.example", "read")).toBe(".env.example");
    for (const bad of ["/etc/passwd", "../x", "src/../../x", "a//b", ""]) expect(() => checkPath(bad, "read")).toThrow(ToolError);
    expect(() => checkPath(".env", "read")).toThrow(/secrets/);
    expect(() => checkPath("src/.env.local", "read")).toThrow(/secrets/);
    expect(() => checkPath("package-lock.json", "write")).toThrow(/managed by the page/);
    expect(() => checkPath("node_modules/x/index.js", "write")).toThrow(/managed by the page/);
    expect(checkPath("package-lock.json", "read")).toBe("package-lock.json");
  });

  it("matches globs as a shell would", () => {
    expect(globPattern("src/**/*.tsx").test("src/agent/agent.tsx")).toBe(true);
    expect(globPattern("src/**/*.tsx").test("src/agent.tsx")).toBe(true);
    expect(globPattern("*.md").test("context/a.md")).toBe(false);
    expect(globPattern("context/*.md").test("context/a.md")).toBe(true);
  });
});

describe("browser tools: files", () => {
  const project = {
    "package.json": "{}",
    "src/agent/agent.tsx": "line one\nconst greeting = 'hi';\nline three",
    ".env": "SECRET=1",
    "node_modules/x/package.json": "{}",
  };

  it("lists project files and their directories, without packages or secrets", async () => {
    const { tools } = host(project);
    const listed = (await tools.list_files!({})) as { entries: Array<{ path: string; type: string; size?: number }> };
    expect(listed.entries.map((entry) => `${entry.type}:${entry.path}`)).toEqual([
      "file:package.json",
      "dir:src",
      "dir:src/agent",
      "file:src/agent/agent.tsx",
    ]);
    expect(listed.entries.find((entry) => entry.path === "package.json")?.size).toBe(2);
  });

  it("reads numbered lines after an offset", async () => {
    const { tools } = host(project);
    expect(await tools.read_file!({ path: "src/agent/agent.tsx", offset: 1, limit: 1 })).toEqual({
      path: "src/agent/agent.tsx",
      content: "     2\tconst greeting = 'hi';",
      offset: 1,
      lines: 1,
      totalLines: 3,
      truncated: true,
    });
    expect(await refusal(tools.read_file!({ path: ".env" }))).toBe("path_refused");
    expect(await refusal(tools.read_file!({ path: "src/missing.ts" }))).toBe("file_not_found");
  });

  it("searches project files by regular expression and glob", async () => {
    const { tools } = host(project);
    expect(await tools.search!({ pattern: "greet", glob: "src/**/*.tsx" })).toEqual({
      matches: [{ path: "src/agent/agent.tsx", line: 2, text: "const greeting = 'hi';" }],
      truncated: false,
    });
    expect(await tools.search!({ pattern: "SECRET" })).toEqual({ matches: [], truncated: false });
    expect(await refusal(tools.search!({ pattern: "(" }))).toBe("input_invalid");
  });

  it("writes, edits and deletes through one change each, answering the reload", async () => {
    const { tools, files, changes } = host(project);
    expect(await tools.write_file!({ path: "src/agent/new.ts", content: "export {};" })).toEqual({
      path: "src/agent/new.ts",
      bytes: 10,
      reload: { state: "reloaded", ms: 12 },
    });
    expect(await tools.edit_file!({ path: "src/agent/agent.tsx", oldText: "'hi'", newText: "'hello'" })).toMatchObject({ line: 2 });
    expect(files.get("src/agent/agent.tsx")).toContain("'hello'");
    expect(await refusal(tools.edit_file!({ path: "src/agent/agent.tsx", oldText: "nope", newText: "" }))).toBe("edit_no_match");
    expect(await refusal(tools.edit_file!({ path: "src/agent/agent.tsx", oldText: "line", newText: "" }))).toBe("edit_not_unique");
    expect(await tools.delete_file!({ path: "src/agent/new.ts" })).toMatchObject({ deleted: true });
    expect(changes).toHaveLength(3);
    expect(await refusal(tools.write_file!({ path: "package-lock.json", content: "{}" }))).toBe("path_refused");
  });
});

describe("browser tools: the rest", () => {
  it("filters and tails the log", async () => {
    const { tools } = host({});
    expect(await tools.get_log!({ grep: "error" })).toEqual({ state: "serving", log: "b error here", truncated: false, lastError: null });
    expect(await tools.get_log!({ lines: 1 })).toMatchObject({ log: "c", truncated: true });
  });

  it("reads conversations from the journal", async () => {
    const journal = [
      { t: "conversation", id: 1, agentId: "agent", startedAt: "2026-10-29T10:00:00.000Z" },
      { t: "message", conversation: 1, seq: 0, writtenAt: "2026-10-29T10:00:01.000Z", message: { role: "user", content: "hi" } },
      { t: "message", conversation: 1, seq: 1, writtenAt: "2026-10-29T10:00:02.000Z", message: { role: "assistant", content: "hello" } },
      { t: "conversation", id: 2, agentId: "agent", startedAt: "2026-10-29T11:00:00.000Z" },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const { tools } = host({}, { journal: () => `${journal}\n{"t":"mess` });
    expect(await tools.list_conversations!({})).toEqual({
      conversations: [{ id: 1, agentId: "agent", startedAt: "2026-10-29T10:00:00.000Z", turns: 1, toolCalls: 0, lastAt: "2026-10-29T10:00:02.000Z" }],
    });
    const one = (await tools.get_conversation!({ id: 1 })) as { conversations: Array<{ messages: Array<{ role: string; content: string }> }> };
    expect(one.conversations[0]!.messages.map((message) => `${message.role}:${message.content}`)).toEqual(["user:hi", "assistant:hello"]);
    expect(await refusal(tools.get_conversation!({ id: 9 }))).toBe("conversation_not_found");
  });

  it("asks the page for a secret by name, never taking a value", async () => {
    const { tools, secrets } = host({});
    expect(await tools.request_secret!({ name: "OPENAI_API_KEY" })).toEqual({ requested: true, name: "OPENAI_API_KEY" });
    expect(secrets).toEqual(["OPENAI_API_KEY"]);
    expect(await refusal(tools.request_secret!({ name: "not a name" }))).toBe("input_invalid");
  });
});
