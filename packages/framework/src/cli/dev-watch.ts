import { readdirSync, statSync, watch as fsWatch, type Dirent } from "node:fs";
import { join } from "node:path";

/**
 * Whether a change at `path` (from the project root, forward slashes) changes the agent
 * `curb dev` runs: anything under `src/` (a skill, a helper it imports, a JSON file it
 * reads), the markdown under `context/` the agent reads at import, and `.env`, which the
 * providers read at boot. Not editor scratch files, not `.curb/`, `node_modules/` or the
 * conversation store, and not `context/context.index.json`, which the preview writes itself.
 */
export function changesAgent(path: string): boolean {
  if (path === ".env") return true;
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  if (name === "" || isEditorScratch(name) || CONVERSATION_STORE_FILE.test(name)) return false;
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) return false;
  if (segments[0] === "src") return segments.length > 1;
  if (segments[0] === "context") return name.endsWith(".md");
  return false;
}

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".curb", ".data"]);

/** The conversation store's file by its default name (`.data/conversations.jsonl`): written on
 * every message, so a store kept under `src/` would otherwise reload the agent after each one.
 * By name rather than by `.jsonl`, which an agent may well read as data. */
const CONVERSATION_STORE_FILE = /^conversations\.jsonl$/i;

/** Swap, backup and atomic-save files editors and coding agents write next to the real one. */
function isEditorScratch(name: string): boolean {
  return (
    name === ".DS_Store" ||
    name === "4913" || // vim's write probe
    name.startsWith(".#") || // emacs lock
    (name.startsWith("#") && name.endsWith("#")) || // emacs autosave
    name.endsWith("~") ||
    name.includes("___jb_") || // JetBrains safe write
    /\.(swp|swx|swo|tmp|temp|bak|orig|crswap)$/i.test(name) ||
    /\.tmp[.-]\w+$/i.test(name) // atomic writes: skill.tsx.tmp.1234, skill.tsx.tmp-ab12
  );
}

/**
 * Collects changed paths and hands them over once nothing changed for `ms`: a coding agent
 * writing five files in a row causes one reload, which names all five.
 */
export function debounceChanges(
  ms: number,
  flush: (paths: string[]) => void,
): { add(path: string): void; cancel(): void } {
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    add(path) {
      pending.add(path);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const paths = [...pending].sort();
        pending = new Set();
        flush(paths);
      }, ms);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = new Set();
    },
  };
}

/** `fs.watch`'s shape, injectable for tests. */
export type WatchFunction = (
  directory: string,
  options: { recursive: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
) => { close(): void; on(event: "error", listener: (error: Error) => void): unknown };

/** The directories whose files make up the agent, each watched recursively. */
const AGENT_DIRECTORIES = ["src", "context"] as const;
type AgentDirectory = (typeof AGENT_DIRECTORIES)[number];

/**
 * Watch the project for changes to its agent and call `onChange` with the changed paths
 * (project-relative), debounced. Three watchers, so a large `node_modules` is never walked:
 * `src/` and `context/` recursively, the root itself for `.env`. The root watcher also sees
 * `src/` or `context/` appear after the start (or come back after a delete): from then on it
 * is watched, and the files already in it count as changed.
 *
 * An event is a change only when a file's size or modification time differs from what it was
 * at the start or at its last change, or a file that was there is gone. macOS reports the
 * creation of files written just before the watch began, and events about directories, and
 * those must not reload an agent nobody edited (`npm run dev` right after `create-curb.js`).
 */
export function watchProject(
  projectRoot: string,
  onChange: (paths: string[]) => void,
  options: { watch?: WatchFunction; debounceMs?: number; onError?: (message: string) => void } = {},
): { close(): void } {
  const watch = options.watch ?? (fsWatch as unknown as WatchFunction);
  const debounce = debounceChanges(options.debounceMs ?? 200, onChange);
  /** Each agent file as last seen: its size and modification time. */
  const seen = new Map<string, string>();
  const remember = (path: string) => {
    const signature = fileSignature(join(projectRoot, path));
    if (signature !== null) seen.set(path, signature);
  };
  /** Whether `path` really changed since it was last seen; remembers what it is now. */
  const changed = (path: string): boolean => {
    const signature = fileSignature(join(projectRoot, path));
    if (signature === null) {
      // Gone, or a directory: only the removal of a file that was there changes the agent.
      if (!seen.has(path) || isDirectory(join(projectRoot, path))) return false;
      seen.delete(path);
      return true;
    }
    if (seen.get(path) === signature) return false;
    seen.set(path, signature);
    return true;
  };
  for (const directory of AGENT_DIRECTORIES) {
    for (const path of filesUnder(projectRoot, directory)) if (changesAgent(path)) remember(path);
  }
  remember(".env");
  /** Each watched directory's watcher, and the directory it watches (its inode). */
  const watchers = new Map<AgentDirectory | "", { watcher: { close(): void }; inode: number }>();
  const add = (directory: AgentDirectory | "", recursive: boolean, accept: (path: string) => boolean): boolean => {
    const absolute = join(projectRoot, directory);
    const inode = inodeOf(absolute);
    if (inode === null) return false;
    const watcher = watch(absolute, { recursive }, (_event, filename) => {
      if (filename === null) return;
      const name = filename.toString().split("\\").join("/");
      const path = directory === "" ? name : `${directory}/${name}`;
      if (accept(path) && changed(path)) debounce.add(path);
    });
    // A watched directory that is deleted or renamed ends its watcher; a save under it
    // then reloads nothing, which has to be said rather than happen quietly.
    watcher.on("error", (error) => {
      options.onError?.(`stopped watching ${directory || "the project root"}: ${error.message}`);
    });
    watchers.set(directory, { watcher, inode });
    return true;
  };
  /** `src/` or `context/` changed in the root: watch it if it is new (or new again). */
  const appeared = (directory: AgentDirectory) => {
    const watched = watchers.get(directory);
    const inode = inodeOf(join(projectRoot, directory));
    if (watched && watched.inode === inode) return;
    watched?.watcher.close();
    watchers.delete(directory);
    // Created with files already in it, as `git checkout` and coding agents do: the new
    // watcher never sees those, so they count as changed now.
    if (add(directory, true, changesAgent)) {
      for (const path of filesUnder(projectRoot, directory)) {
        if (!changesAgent(path)) continue;
        remember(path);
        debounce.add(path);
      }
    }
  };
  for (const directory of AGENT_DIRECTORIES) add(directory, true, changesAgent);
  add("", false, (path) => {
    if ((AGENT_DIRECTORIES as readonly string[]).includes(path)) appeared(path as AgentDirectory);
    return path === ".env";
  });
  return {
    close() {
      debounce.cancel();
      for (const { watcher } of watchers.values()) watcher.close();
    },
  };
}

/** A file's size and modification time, or null when `path` is no file (gone, or a directory). */
function fileSignature(path: string): string | null {
  try {
    const stats = statSync(path);
    return stats.isFile() ? `${stats.size}:${stats.mtimeMs}` : null;
  } catch {
    // KEEP-JUSTIFIED: nothing there is an answer (a deleted file), not a failure.
    return null;
  }
}

function isDirectory(path: string): boolean {
  return inodeOf(path) !== null;
}

/** The inode of the directory at `path`, or null when there is none. */
function inodeOf(path: string): number | null {
  try {
    const stats = statSync(path);
    return stats.isDirectory() ? stats.ino : null;
  } catch {
    // KEEP-JUSTIFIED: no directory there (yet) is an answer, not a failure.
    return null;
  }
}

/** Every file under `directory` (project-relative paths), skipping the directories no change
 * of the agent comes from. */
function filesUnder(projectRoot: string, directory: string): string[] {
  const files: string[] = [];
  const walk = (relative: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(projectRoot, relative), { withFileTypes: true });
    } catch {
      // KEEP-JUSTIFIED: removed again while it was read; its watcher reports what follows.
      return;
    }
    for (const entry of entries) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) walk(path);
      } else {
        files.push(path);
      }
    }
  };
  walk(directory);
  return files;
}
