import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test helper: a project in a temp directory that imports "curb" the way a scaffold does,
 * through a node_modules that is the workspace's own (where `curb` links to this package).
 * Hermetic: nothing is installed, nothing leaves the machine.
 */
export function createTestProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "curb-project-"));
  symlinkSync(fileURLToPath(new URL("../../../../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
  for (const [path, content] of Object.entries({ ...BASE_FILES, ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** The scaffold's package.json and tsconfig.json. */
const BASE_FILES: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: "curb-test-project", private: true, type: "module" }, null, 2)}\n`,
  "tsconfig.json": `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["src"],
    },
    null,
    2,
  )}\n`,
};

/** An agent with two faults a render does not reach, in its tasks skill: a misspelled call
 * inside a tool's onSubmit (line 13) and an undefined name in a branch that renders only
 * later (line 17). */
export const SEEDED_FAULT_FILES: Record<string, string> = {
  "src/agent/agent.tsx": `import { Agent, Skill, Skills, SystemPrompt, createAgentStore, defineAgent } from "curb";

export const useFlags = createAgentStore<{ done: boolean; finish: () => void }>("seeded", (set) => ({
  done: false,
  finish: () => set({ done: true }),
}));

export function App() {
  return (
    <Agent>
      <SystemPrompt>
        You are a test agent.
        Keep every reply short.
      </SystemPrompt>
      <Skills>
        <Skill path="/tasks" description="Use for the task list.">Tasks</Skill>
      </Skills>
    </Agent>
  );
}

export const agent = defineAgent({ app: App });
`,
  "src/agent/tasks/skill.tsx": `import { Text, Tool, type SkillMeta } from "curb";
import { useFlags } from "../agent.js";

export const meta: SkillMeta = { title: "Tasks", description: "Use for the task list." };

export default function Tasks() {
  const done = useFlags((state) => state.done);
  const finish = useFlags((state) => state.finish);
  return (
    <>
      <Tool name="finish" description="Finish the task." onSubmit={() => {
        void finish;
        finsh();
        return { ok: true };
      }} />
      {done ? (
        <Text>{summary}</Text>
      ) : (
        <Text>Not done yet.</Text>
      )}
    </>
  );
}
`,
};
