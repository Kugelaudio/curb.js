import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectRoot } from "../project.node.js";
import { loadTestRun, savedTestRunIds, type TestRun } from "./record.js";

/**
 * Which scenarios a change can affect, from the files it changed and what saved runs recorded:
 * `curb test --changed` runs only those. A skill's folder affects the scenarios that sit in it and
 * those a saved run of which opened that skill (a skill's tools are offered only while it is
 * open, so that covers its tools too). Anything else of the agent (`agent.tsx`, a module outside
 * a skill's folder, `context/`, `package.json` and its lockfile) can change every conversation, so
 * it affects every scenario, and so does a skill's `meta`, which every conversation is offered the
 * skill by. A scenario no saved run played is affected by any change of the agent.
 */

/** Whether a change affects one scenario, and why, in a few words a report can show. */
export type AffectedScenario = { name: string; file: string; affected: boolean; why: string };

/** What one changed file is to the agent. */
type Change =
  | { kind: "scenario"; file: string }
  | { kind: "skill"; file: string; skill: string; folder: string }
  | { kind: "agent"; file: string };

const isTest = (file: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
/** Files outside src/ and context/ that change what the agent runs on: its providers and Curb. */
const AGENT_FILES = new Set(["package.json", "package-lock.json"]);

/** `src/agent/` or `src/agents/<id>/`: the folder a file's skills are named from, or null. */
function agentFolderOf(file: string): string | null {
  if (file.startsWith("src/agent/")) return "src/agent";
  const multi = /^src\/agents\/[^/]+(?=\/)/.exec(file);
  return multi ? multi[0] : null;
}

/** What `file` (relative to the project, forward slashes) is to the agent; null when it is no part
 * of what the agent runs: a test, a dot file, or anything outside src/, context/ and package.json. */
function changeOf(root: string, file: string, before: ((file: string) => string | null) | undefined): Change | null {
  const name = file.split("/").pop() ?? file;
  if (file.endsWith(".scenario.ts")) return { kind: "scenario", file };
  if (isTest(file) || name.startsWith(".")) return null;
  if (!file.startsWith("src/") && !file.startsWith("context/") && !AGENT_FILES.has(file)) return null;
  const agent = agentFolderOf(file);
  if (agent) {
    // The deepest folder above the file that holds a skill.tsx is the skill it belongs to.
    const parts = file.slice(agent.length + 1).split("/").slice(0, -1);
    for (let depth = parts.length; depth > 0; depth -= 1) {
      const skill = parts.slice(0, depth).join("/");
      const folder = `${agent}/${skill}`;
      if (!existsSync(join(root, folder, "skill.tsx"))) continue;
      // The skill's meta is how every conversation is offered it: a change of it is the agent's.
      if (file === `${folder}/skill.tsx` && offerChanged(join(root, file), file, before)) return { kind: "agent", file: `${file} (its meta)` };
      return { kind: "skill", file, skill, folder };
    }
  }
  return { kind: "agent", file };
}

/** A skill's `export const meta = { ... }`, without its spacing; null when the text holds none. */
function metaOf(text: string): string | null {
  const found = /export\s+const\s+meta\b[\s\S]*?(?:\}(?:\s*(?:as|satisfies)\s+[\w.<>]+)?\s*;|\n\})/.exec(text);
  return found ? found[0].replace(/\s+/g, " ") : null;
}

/** Whether the meta of the skill.tsx at `path` may differ from before the change: it does, it
 * cannot be read on either side, or nothing says what the file held before. */
function offerChanged(path: string, file: string, before: ((file: string) => string | null) | undefined): boolean {
  if (!before) return true;
  let now: string;
  try {
    now = readFileSync(path, "utf8");
  } catch {
    // KEEP-JUSTIFIED: a skill.tsx that cannot be read may offer anything; count it as changed.
    return true;
  }
  const was = before(file);
  const [old, current] = [was === null ? null : metaOf(was), metaOf(now)];
  return old === null || current === null || old !== current;
}

/** Every saved run of the project; a file that cannot be read is left out. */
function savedRuns(root: string): TestRun[] {
  return savedTestRunIds(root).flatMap((id) => {
    try {
      return [loadTestRun(root, id)];
    } catch {
      // KEEP-JUSTIFIED: an unreadable run says nothing about which skills a scenario opens; its scenarios count as never played.
      return [];
    }
  });
}

const normalized = (file: string) => file.trim().replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * For each of `scenarios`, whether the change that touched `changed` (paths relative to the
 * project) can affect it, and why. `runs` are the saved runs whose conversations say which skills
 * each scenario opened (default: every run saved in the project's `.curb/test-runs/`); `root` is
 * the project (default: the one this process runs), where a skill is a folder with a `skill.tsx`.
 * `before` reads a file as it was before the change (null when it did not exist): with it, a
 * changed `skill.tsx` whose `meta` is the same affects only its skill; without it, every scenario.
 */
export function affectedScenarios(
  changed: readonly string[],
  scenarios: ReadonlyArray<{ name: string; file: string }>,
  options: { root?: string; runs?: readonly TestRun[]; before?: (file: string) => string | null } = {},
): AffectedScenario[] {
  const root = options.root ?? resolveProjectRoot();
  const changes = [...new Set(changed.map(normalized).filter(Boolean))].flatMap((file) => changeOf(root, file, options.before) ?? []);
  const agentLevel = changes.find((change) => change.kind === "agent");
  const skills = changes.filter((change): change is Extract<Change, { kind: "skill" }> => change.kind === "skill");
  const scenarioFiles = new Set(changes.filter((change) => change.kind === "scenario").map((change) => change.file));

  // The skills each scenario opened, by file and name, over every saved run that played it.
  const opened = new Map<string, Set<string>>();
  for (const run of options.runs ?? savedRuns(root)) {
    for (const conversation of run.conversations) {
      const key = `${conversation.scenario.file}\n${conversation.scenario.name}`;
      const paths = opened.get(key) ?? new Set<string>();
      for (const turn of conversation.turns) if (turn.skillPath) paths.add(turn.skillPath);
      if (conversation.endState?.skillPath) paths.add(conversation.endState.skillPath);
      opened.set(key, paths);
    }
  }
  const within = (path: string, skill: string) => path === skill || path.startsWith(`${skill}/`);

  return scenarios.map(({ name, file }): AffectedScenario => {
    const verdict = (affected: boolean, why: string): AffectedScenario => ({ name, file, affected, why });
    if (scenarioFiles.has(normalized(file))) return verdict(true, "its file changed");
    if (agentLevel) return verdict(true, `${agentLevel.file} changed, which every conversation runs on`);
    if (skills.length === 0) return verdict(false, "nothing it runs on changed");
    const home = skills.find((change) => normalized(file).startsWith(`${change.folder}/`));
    if (home) return verdict(true, `it sits in ${home.folder}, which changed`);
    const paths = opened.get(`${file}\n${name}`);
    if (!paths) return verdict(true, "no saved run says which skills it opens");
    const hit = skills.find((change) => [...paths].some((path) => within(path, change.skill)));
    if (hit) return verdict(true, `a saved run of it opened ${hit.skill}, which changed`);
    const seen = [...paths].sort();
    return verdict(false, seen.length > 0 ? `its saved runs opened only ${seen.join(", ")}` : "its saved runs opened no skill");
  });
}
