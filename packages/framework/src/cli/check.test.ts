import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { storeProjectKey } from "./cloud/credentials.js";
import { createTestProject, SEEDED_FAULT_FILES } from "./test-project.js";

/** `curb check` exactly as a project runs it: the bin shim, tsx, the project's own files.
 * `unset` names variables of this environment the check must not see. */
function curbCheck(cwd: string, unset: readonly string[] = [], extra: Record<string, string> = {}) {
  const env = { ...process.env, ...extra };
  for (const name of ["AGENT_PROJECT_DIR", "TSX_TSCONFIG_PATH", ...unset]) delete env[name];
  const bin = fileURLToPath(new URL("../../bin/curb.js", import.meta.url));
  return spawnSync(process.execPath, [bin, "check"], { cwd, env, encoding: "utf8", timeout: 120_000 });
}

describe("curb check", () => {
  const root = createTestProject({
    ...SEEDED_FAULT_FILES,
    "src/orchestration/session.ts": "export const leftover = true;\n",
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("fails on faults no render reaches, and warns on JSX prose and a leftover src/orchestration", () => {
    const result = curbCheck(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(1);
    expect(result.stderr).toContain(
      "[agent:agent] [AGENT_TYPE_ERROR] ERROR: Cannot find name 'finsh'. Did you mean 'finish'? (TS2552)\n" +
        "Location: src/agent/tasks/skill.tsx:13:9",
    );
    expect(result.stderr).toContain(
      "[agent:agent] [AGENT_TYPE_ERROR] ERROR: Cannot find name 'summary'. (TS2304)\nLocation: src/agent/tasks/skill.tsx:17:16",
    );
    expect(result.stderr).toContain(
      "[AGENT_ORCHESTRATION_IGNORED] WARNING: The framework runs the voice session on every route; these files are not used.\n" +
        "Location: src/orchestration/\n" +
        "Fix: Delete src/orchestration/ (voice settings go on <Agent>).",
    );
    expect(result.stderr).toContain("[AGENT_PROSE_JSX_TEXT] WARNING: <SystemPrompt> has prose on 2 lines");
    expect(result.stderr).toContain("Location: src/agent/agent.tsx:12");
    expect(result.stderr).toContain("<SystemPrompt>{`\n  You are a test agent.\n  Keep every reply short.\n`}</SystemPrompt>");
    // Errors inside the framework's own source are not the project's.
    expect(output).not.toContain("node_modules");
    expect(result.stdout).toContain("Type-checked 2 file(s) under src/");
    expect(result.stdout).toContain("2 error(s), 2 warning(s).");
  }, 120_000);

  it("passes a tool that reads its key from process.env", () => {
    const clean = createTestProject({
      "src/agent/agent.tsx": [
        'import { Agent, Skill, Skills, SystemPrompt, defineAgent } from "curb";',
        "",
        "export function App() {",
        "  return (",
        "    <Agent>",
        "      <SystemPrompt>{`",
        "        You look up orders.",
        "        Keep every reply short.",
        "      `}</SystemPrompt>",
        "      <Skills>",
        '        <Skill path="/orders" description="Use for looking up an order.">Orders</Skill>',
        "      </Skills>",
        "    </Agent>",
        "  );",
        "}",
        "",
        "export const agent = defineAgent({ app: App });",
        "",
      ].join("\n"),
      "src/agent/orders/skill.tsx": [
        'import { Tool, z, type SkillMeta } from "curb";',
        "",
        'export const meta: SkillMeta = { title: "Orders" };',
        "",
        'const lookupSchema = z.object({ order: z.string().min(1).describe("Order number.") });',
        "",
        "export default function Orders() {",
        "  return (",
        "    <Tool",
        '      name="lookup_order"',
        '      description="Look up an order."',
        "      schema={lookupSchema}",
        "      onSubmit={async ({ order }) => {",
        "        const apiKey = process.env.SOME_KEY;",
        '        if (!apiKey) return { ok: false, message: "The order system is not configured." };',
        "        return { ok: true, message: `Order ${order} is on its way.` };",
        "      }}",
        "    />",
        "  );",
        "}",
        "",
      ].join("\n"),
      ".env.example": "SOME_KEY=\n",
    });
    try {
      const result = curbCheck(clean, ["SOME_KEY"]);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status, output).toBe(0);
      expect(output).not.toContain("AGENT_TYPE_ERROR");
      expect(output).not.toContain("AGENT_NODE_TYPES_MISSING");
      expect(result.stdout).toContain("Type-checked 2 file(s) under src/");
      expect(result.stdout).toMatch(/^ {4}SOME_KEY +missing {2}src\/agent\/orders\/skill\.tsx:14$/m);
      expect(result.stdout).toContain("No authoring diagnostics — the agent is clean.");
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails a project from before the agent level with one error per leftover, each saying what to move", () => {
    // The shape every project had: a home skill at src/agent/skill.tsx, loaded first and
    // linked from the skills index. /notes is linked from the home skill only.
    const agentLines = [
      'import { Agent, Skill, Skills, SystemPrompt, createAgentStore, defineAgent } from "curb";',
      "",
      'export const useTasks = createAgentStore<{ tasks: string[]; add: (title: string) => void }>("old-tasks", (set) => ({',
      "  tasks: [],",
      "  add: (title) => set((state) => ({ tasks: [...state.tasks, title] })),",
      "}));",
      "",
      "export function App() {",
      "  return (",
      "    <Agent>",
      "      <SystemPrompt>{`You plan the caller's day.`}</SystemPrompt>",
      "      <Skills>",
      '        <Skill path="/">Today</Skill>',
      "      </Skills>",
      "    </Agent>",
      "  );",
      "}",
      "",
      'export const agent = defineAgent({ app: App, initialPath: "/" });',
      "",
    ];
    const old = createTestProject({
      "src/agent/agent.tsx": agentLines.join("\n"),
      "src/agent/skill.tsx": [
        'import { Instruction, Skill, Tool, type SkillMeta } from "curb";',
        'import { useTasks } from "./agent.js";',
        "",
        'export const meta: SkillMeta = { title: "Today", description: "Return to today." };',
        "",
        "export default function Today() {",
        "  const add = useTasks((state) => state.add);",
        "  return (",
        "    <>",
        "      <Instruction>{`Help the caller plan the day.`}</Instruction>",
        '      <Tool name="add_task" description="Add a task." onSubmit={() => {',
        '        add("milk");',
        "        return { ok: true };",
        "      }} />",
        '      <Skill path="/notes">Notes</Skill>',
        "    </>",
        "  );",
        "}",
        "",
      ].join("\n"),
      "src/agent/notes/skill.tsx": [
        'import { Text, type SkillMeta } from "curb";',
        "",
        'export const meta: SkillMeta = { title: "Notes", description: "Use for notes the caller wants kept." };',
        "",
        "export default function Notes() {",
        "  return <Text>No notes yet.</Text>;",
        "}",
        "",
      ].join("\n"),
    });
    /** Where `text` starts in agent.tsx, as `line:column`. */
    const at = (text: string) => {
      const index = agentLines.findIndex((line) => line.includes(text));
      return `${index + 1}:${agentLines[index]!.indexOf(text) + 1}`;
    };
    try {
      const result = curbCheck(old);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status, output).toBe(1);
      expect(result.stderr).toContain(
        "[agent:agent] [AGENT_HOME_SKILL_REMOVED] ERROR: src/agent/skill.tsx is no longer a skill, so nothing in it " +
          "reaches the model: a conversation starts at the agent level, src/agent/agent.tsx, and opens skills only when needed.\n" +
          "Location: src/agent/skill.tsx\n" +
          "Fix: Move its instructions into the <SystemPrompt> of src/agent/agent.tsx, its tools into <GlobalTools> (add_task), " +
          "and its <Skill> links into the agent's <Skills> list (/notes), then delete src/agent/skill.tsx.",
      );
      expect(result.stderr).toContain(
        '[agent:agent] [AGENT_HOME_SKILL_REMOVED] ERROR: defineAgent({ initialPath: "/" }) does nothing any more: ' +
          "every conversation starts at the agent level, with no skill loaded.\n" +
          `Location: src/agent/agent.tsx:${at("initialPath")}\n` +
          "Fix: Delete the initialPath line from defineAgent in src/agent/agent.tsx.",
      );
      expect(result.stderr).toContain(
        '[agent:agent] [AGENT_HOME_SKILL_REMOVED] ERROR: <Skill path="/"> links the home skill, which is gone: ' +
          "a conversation starts at the agent level, and the agent level is not a skill to read.\n" +
          `Location: src/agent/agent.tsx:${at('<Skill path="/">')}\n` +
          'Fix: Delete this <Skill path="/"> link.',
      );
      // One diagnostic per leftover: not the type error of the removed option, not an
      // unknown route for "/", not /notes as unreachable (its link moves with the rest).
      expect(output).not.toContain("AGENT_TYPE_ERROR");
      expect(output).not.toContain("AGENT_INVALID_ROUTE");
      expect(output).not.toContain("AGENT_UNREACHABLE_SKILL");
      expect(result.stdout).toContain("Type-checked 2 file(s) under src/");
      expect(result.stdout).toContain("3 error(s), 0 warning(s).");
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
  }, 120_000);

  it("lists every variable the agent needs, set or missing, never a value, and still passes", () => {
    const secrets = {
      KUGELAUDIO_API_KEY: "never-printed-kugel",
      ORDERS_API_URL: "https://orders.example/never-printed-url",
    };
    const project = createTestProject({
      "package.json": `${JSON.stringify({ name: "orders", private: true, type: "module", curb: { requiredRuntimeSecrets: ["WEBHOOK_SECRET"] } })}\n`,
      "src/agent/agent.tsx": [
        'import { Agent, Skill, Skills, SystemPrompt, defineAgent } from "curb";',
        'import { elevenlabs, kugelaudio } from "curb/providers";',
        "",
        "export function App() {",
        "  return (",
        "    <Agent stt={kugelaudio.stt()} tts={kugelaudio.tts()}>",
        "      <SystemPrompt>{`You look up orders.`}</SystemPrompt>",
        "      <Skills>",
        '        <Skill path="/orders" description="Use for looking up an order." tts={elevenlabs.tts()}>Orders</Skill>',
        "      </Skills>",
        "    </Agent>",
        "  );",
        "}",
        "",
        "export const agent = defineAgent({ app: App });",
        "",
      ].join("\n"),
      "src/agent/orders/skill.tsx": [
        'import { Tool, z, type SkillMeta } from "curb";',
        "",
        'export const meta: SkillMeta = { title: "Orders" };',
        "",
        "const { ORDERS_API_TOKEN } = process.env;",
        'const lookupSchema = z.object({ order: z.string().min(1).describe("Order number.") });',
        "",
        "export default function Orders() {",
        "  return (",
        '    <Tool name="lookup_order" description="Look up an order." schema={lookupSchema} onSubmit={async ({ order }) => {',
        "      const base = process.env.ORDERS_API_URL;",
        '      if (!base || !ORDERS_API_TOKEN) return { ok: false, message: "The order system is not configured." };',
        "      return { ok: true, message: `Order ${order} is on its way.` };",
        "    }} />",
        "  );",
        "}",
        "",
      ].join("\n"),
      ".env": Object.entries(secrets).map(([name, value]) => `${name}=${value}\n`).join(""),
      // A commented entry lists an optional variable as well as a plain one.
      ".env.example": "KUGELAUDIO_API_KEY=\n# ORDERS_API_TOKEN=\n",
    });
    try {
      const result = curbCheck(project, [
        ...Object.keys(secrets),
        "ELEVEN_API_KEY",
        "ELEVENLABS_API_KEY",
        "ORDERS_API_TOKEN",
        "WEBHOOK_SECRET",
      ]);
      const output = `${result.stdout}\n${result.stderr}`;

      // Missing values are information: a hosted agent gets them from curb secrets push.
      expect(result.status, output).toBe(0);
      expect(result.stderr).toContain(
        "[agent:agent] [AGENT_ENV_NOT_DECLARED] WARNING: The code reads ORDERS_API_URL from the environment, but .env.example does not list it.\n" +
          "Location: src/agent/orders/skill.tsx:11:20\n" +
          "Fix: Add ORDERS_API_URL= to .env.example, with no value, so whoever deploys the agent knows to set it.",
      );
      expect(result.stdout).toContain(
        [
          "Configuration (names only, never values; looked up in .env and the environment):",
          "  Providers:",
          "    KUGELAUDIO_API_KEY  set      llm kugelaudio, stt kugelaudio, tts kugelaudio",
          "    ELEVEN_API_KEY      missing  tts elevenlabs in /orders",
          "  Project code:",
          "    ORDERS_API_TOKEN    missing  src/agent/orders/skill.tsx:5",
          "    ORDERS_API_URL      set      src/agent/orders/skill.tsx:11",
          "    WEBHOOK_SECRET      missing  declared in package.json",
          "  A missing value does not fail the check: set it in .env to run locally.",
          "  A hosted agent gets ELEVEN_API_KEY, ORDERS_API_TOKEN and WEBHOOK_SECRET only from `npx curb secrets push` (which sends .env) or the agent's Variables page in the dashboard.",
        ].join("\n"),
      );
      expect(result.stdout).toContain("0 error(s), 1 warning(s).");
      expect(output).not.toMatch(/never-printed|orders\.example/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 120_000);

  // `curb login` keeps the project key in its own store: a project linked to that project runs
  // on it, and the check says so by who and which project; a KUGELAUDIO_API_KEY in .env wins.
  it("runs on the key curb login stored for the linked project, and a key in .env wins", () => {
    const config = mkdtempSync(join(tmpdir(), "curb-config-"));
    storeProjectKey(
      {
        apiKey: "never-printed-login-key",
        keyId: 100,
        orgId: "org_pub_acme",
        orgName: "Acme",
        projectId: "prj_pub_voice",
        projectName: "Voice",
        webUrl: "https://www.kugelaudio.com",
        email: "dev@example.com",
      },
      join(config, "curb", "project-keys.json"),
    );
    const project = createTestProject({
      "src/agent/agent.tsx": [
        'import { Agent, SystemPrompt, defineAgent } from "curb";',
        'import { kugelaudio } from "curb/providers";',
        "",
        "export function App() {",
        "  return (",
        "    <Agent stt={kugelaudio.stt()} tts={kugelaudio.tts()}>",
        "      <SystemPrompt>{`You help.`}</SystemPrompt>",
        "    </Agent>",
        "  );",
        "}",
        "",
        "export const agent = defineAgent({ app: App });",
        "",
      ].join("\n"),
      ".curb/link.json": JSON.stringify({ webUrl: "https://www.kugelaudio.com", orgId: "org_pub_acme", projectId: "prj_pub_voice" }),
      ".env.example": "# KUGELAUDIO_API_KEY=\n",
    });
    try {
      const fromLogin = curbCheck(project, ["KUGELAUDIO_API_KEY"], { XDG_CONFIG_HOME: config });
      expect(fromLogin.status, fromLogin.stderr).toBe(0);
      expect(fromLogin.stdout).toContain(
        "    KUGELAUDIO_API_KEY  from your login (dev@example.com, Acme / Voice)  llm kugelaudio, stt kugelaudio, tts kugelaudio",
      );
      expect(`${fromLogin.stdout}${fromLogin.stderr}`).not.toContain("never-printed");

      writeFileSync(join(project, ".env"), "KUGELAUDIO_API_KEY=never-printed-env-key\n");
      const fromEnv = curbCheck(project, ["KUGELAUDIO_API_KEY"], { XDG_CONFIG_HOME: config });
      expect(fromEnv.stdout).toContain("    KUGELAUDIO_API_KEY  set      llm kugelaudio, stt kugelaudio, tts kugelaudio");
      expect(`${fromEnv.stdout}${fromEnv.stderr}`).not.toContain("never-printed");
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(config, { recursive: true, force: true });
    }
  }, 120_000);
});
