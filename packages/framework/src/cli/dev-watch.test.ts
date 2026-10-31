import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changesAgent, debounceChanges, watchProject, type WatchFunction } from "./dev-watch.js";

describe("changesAgent", () => {
  it("takes every file under src/, the markdown under context/ and .env", () => {
    for (const path of [
      "src/agent/agent.tsx",
      "src/agent/claims/skill.tsx",
      "src/lib/helper.ts",
      "src/data/rates.json",
      "src/data/faq.jsonl",
      "context/faq.md",
      "context/policies/home.md",
      ".env",
    ]) {
      expect(changesAgent(path), path).toBe(true);
    }
  });

  it("leaves out editor scratch files, generated files, the conversation store and everything else", () => {
    for (const path of [
      "src/agent/.skill.tsx.swp",
      "src/agent/claims/skill.tsx~",
      "src/agent/4913",
      "src/agent/.#skill.tsx",
      "src/agent/#skill.tsx#",
      "src/agent/claims/skill.tsx___jb_tmp___",
      "src/agent/claims/skill.tsx.tmp.48211",
      "src/agent/.DS_Store",
      "src/node_modules/x/index.js",
      "src/.data/conversations.jsonl",
      "src/conversations.jsonl",
      "context/context.index.json",
      "context/notes.txt",
      ".env.local",
      ".curb/tsx.tsconfig.json",
      ".data/conversations.jsonl",
      "mcp.servers.json",
      "package.json",
      "src",
    ]) {
      expect(changesAgent(path), path).toBe(false);
    }
  });
});

describe("debounceChanges", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hands over five quick writes as one change naming all of them", () => {
    const flush = vi.fn();
    const debounce = debounceChanges(200, flush);
    for (const path of ["src/b.ts", "src/a.ts", "src/c.ts", "src/a.ts", "src/d.ts"]) {
      debounce.add(path);
      vi.advanceTimersByTime(150);
    }
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
  });

  it("hands over writes further apart than the wait as separate changes", () => {
    const flush = vi.fn();
    const debounce = debounceChanges(200, flush);
    debounce.add("src/a.ts");
    vi.advanceTimersByTime(250);
    debounce.add("src/b.ts");
    vi.advanceTimersByTime(250);
    expect(flush.mock.calls).toEqual([[["src/a.ts"]], [["src/b.ts"]]]);
  });

  it("drops what is pending when cancelled", () => {
    const flush = vi.fn();
    const debounce = debounceChanges(200, flush);
    debounce.add("src/a.ts");
    debounce.cancel();
    vi.advanceTimersByTime(1000);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe("watchProject", () => {
  let root: string;
  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), "curb-watch-"));
    mkdirSync(join(root, "src", "agent"), { recursive: true });
    mkdirSync(join(root, "context"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  /** A fake fs.watch: records each watcher, and lets the test fire its events. */
  function fakeWatch() {
    const watchers: Array<{
      directory: string;
      recursive: boolean;
      fire(filename: string | null): void;
      error(message: string): void;
      closed: boolean;
    }> = [];
    const watch: WatchFunction = (directory, options, listener) => {
      let onError: (error: Error) => void = () => {};
      const watcher = {
        directory,
        recursive: options.recursive,
        fire: (filename: string | null) => listener("change", filename),
        error: (message: string) => onError(new Error(message)),
        closed: false,
      };
      watchers.push(watcher);
      return {
        close: () => {
          watcher.closed = true;
        },
        on: (_event: "error", listener: (error: Error) => void) => {
          onError = listener;
        },
      };
    };
    const at = (directory: string) => {
      const found = watchers.find((watcher) => watcher.directory === directory);
      if (!found) throw new Error(`no watcher on ${directory}`);
      return found;
    };
    return { watch, watchers, at };
  }

  it("watches src/ and context/ recursively and the root for .env, never node_modules", () => {
    const { watch, watchers } = fakeWatch();
    watchProject(root, () => {}, { watch });
    expect(watchers.map(({ directory, recursive }) => [directory.slice(root.length), recursive])).toEqual([
      ["/src", true],
      ["/context", true],
      ["", false],
    ]);
  });

  it("turns what the watchers report into one debounced list of project paths", () => {
    const { watch, at } = fakeWatch();
    const onChange = vi.fn();
    watchProject(root, onChange, { watch });
    mkdirSync(join(root, "src", "agent", "claims"), { recursive: true });
    writeFileSync(join(root, "src", "agent", "claims", "skill.tsx"), "export default function Claims() {}\n");
    writeFileSync(join(root, "src", "agent", "claims", ".skill.tsx.swp"), "swap");
    writeFileSync(join(root, "context", "faq.md"), "# FAQ\n");
    writeFileSync(join(root, "context", "context.index.json"), "{}");
    writeFileSync(join(root, ".env"), "KEY=1\n");
    writeFileSync(join(root, "package.json"), "{}");

    at(join(root, "src")).fire("agent/claims/skill.tsx");
    at(join(root, "src")).fire("agent/claims/.skill.tsx.swp");
    at(join(root, "context")).fire("faq.md");
    at(join(root, "context")).fire("context.index.json");
    at(root).fire(".env");
    // The root watcher also names the directories under it; only .env counts there.
    at(root).fire("src");
    at(root).fire("package.json");
    at(join(root, "src")).fire(null);
    vi.advanceTimersByTime(200);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([".env", "context/faq.md", "src/agent/claims/skill.tsx"]);
  });

  it("reports no change for files written before it started, nor for directories", () => {
    // macOS replays the creation of files written just before a watch begins: the project a
    // test (or create-curb.js) wrote a moment ago. None of them changed since.
    writeFileSync(join(root, "src", "agent", "agent.tsx"), "export {};\n");
    mkdirSync(join(root, "src", "lib"));
    writeFileSync(join(root, "src", "lib", "greeting.ts"), "export const greeting = 1;\n");
    writeFileSync(join(root, ".env"), "KEY=1\n");
    const { watch, at } = fakeWatch();
    const onChange = vi.fn();
    watchProject(root, onChange, { watch });

    for (const name of ["agent", "agent/agent.tsx", "lib", "lib/greeting.ts", "src"]) at(join(root, "src")).fire(name);
    at(root).fire(".env");
    vi.advanceTimersByTime(200);
    expect(onChange).not.toHaveBeenCalled();

    // A real save is reported once, however many events it causes.
    writeFileSync(join(root, "src", "agent", "agent.tsx"), "export const changed = true;\n");
    at(join(root, "src")).fire("agent/agent.tsx");
    at(join(root, "src")).fire("agent/agent.tsx");
    vi.advanceTimersByTime(200);
    at(join(root, "src")).fire("agent/agent.tsx");
    vi.advanceTimersByTime(200);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(["src/agent/agent.tsx"]);
  });

  it("reports a file that was there and is gone, and nothing for one that never was", () => {
    writeFileSync(join(root, "src", "agent", "agent.tsx"), "export {};\n");
    const { watch, at } = fakeWatch();
    const onChange = vi.fn();
    watchProject(root, onChange, { watch });

    rmSync(join(root, "src", "agent", "agent.tsx"));
    at(join(root, "src")).fire("agent/agent.tsx");
    at(join(root, "src")).fire("agent/never-there.tsx");
    vi.advanceTimersByTime(200);
    expect(onChange).toHaveBeenCalledWith(["src/agent/agent.tsx"]);
  });

  it("says so when a watcher stops, and closes every watcher on close", () => {
    const { watch, watchers, at } = fakeWatch();
    const onError = vi.fn();
    const watcher = watchProject(root, () => {}, { watch, onError });
    at(join(root, "src")).error("EPERM");
    expect(onError).toHaveBeenCalledWith("stopped watching src: EPERM");
    watcher.close();
    expect(watchers.every((entry) => entry.closed)).toBe(true);
  });

  it("skips a context/ directory the project does not have", () => {
    rmSync(join(root, "context"), { recursive: true });
    const { watch, watchers } = fakeWatch();
    watchProject(root, () => {}, { watch });
    expect(watchers.map(({ directory }) => directory.slice(root.length))).toEqual(["/src", ""]);
  });

  it("starts watching a context/ created after it started, with the files already in it", () => {
    rmSync(join(root, "context"), { recursive: true });
    const { watch, watchers, at } = fakeWatch();
    const onChange = vi.fn();
    watchProject(root, onChange, { watch });

    // Created with a file in it before its watcher could see it, as git checkout does.
    mkdirSync(join(root, "context", "policies"), { recursive: true });
    writeFileSync(join(root, "context", "policies", "home.md"), "# Home\n");
    writeFileSync(join(root, "context", "context.index.json"), "{}");
    at(root).fire("context");
    expect(at(join(root, "context")).recursive).toBe(true);
    vi.advanceTimersByTime(200);
    expect(onChange).toHaveBeenLastCalledWith(["context/policies/home.md"]);

    // From then on its changes count; the root's further events about it add no watcher.
    writeFileSync(join(root, "context", "faq.md"), "# FAQ\n");
    at(join(root, "context")).fire("faq.md");
    at(root).fire("context");
    vi.advanceTimersByTime(200);
    expect(onChange).toHaveBeenLastCalledWith(["context/faq.md"]);
    expect(watchers.filter(({ directory }) => directory === join(root, "context"))).toHaveLength(1);
  });

  it("watches src/ again when it was deleted and created anew", () => {
    const { watch, watchers } = fakeWatch();
    const onChange = vi.fn();
    watchProject(root, onChange, { watch });
    const rootWatcher = watchers.find(({ directory }) => directory === root)!;

    rmSync(join(root, "src"), { recursive: true });
    rootWatcher.fire("src");
    const first = watchers.find(({ directory }) => directory === join(root, "src"))!;
    expect(first.closed).toBe(true);

    mkdirSync(join(root, "src", "agent"), { recursive: true });
    writeFileSync(join(root, "src", "agent", "agent.tsx"), "export {};\n");
    rootWatcher.fire("src");
    const again = watchers.filter(({ directory }) => directory === join(root, "src"));
    expect(again).toHaveLength(2);
    expect(again[1].closed).toBe(false);
    vi.advanceTimersByTime(200);
    expect(onChange).toHaveBeenLastCalledWith(["src/agent/agent.tsx"]);
  });
});
