import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgent } from "../agent.node.js";
import { formatAuthoringDiagnostic } from "../authoring.js";
import { anthropic, azure, elevenlabs, kugelaudio, openai, openaiCompatible } from "../providers.js";
import { checkConfiguration, formatConfiguration, providerKeys } from "./check-env.js";
import { createTestProject } from "./test-project.js";

const FIXTURE = fileURLToPath(new URL("../test-fixtures/project/", import.meta.url));

const projects: string[] = [];
const project = (files: Record<string, string>) => {
  const root = createTestProject(files);
  projects.push(root);
  return root;
};
afterEach(() => {
  for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The project's environment checked without an agent: only what its files say. */
const configurationOf = (root: string, env: Record<string, string | undefined> = {}) =>
  checkConfiguration({ projectRoot: root, agent: null, agentId: "agent", env });

const ORDERS_SKILL = [
  'import { Tool } from "curb";',
  "",
  'const { ORDERS_TOKEN, ORDERS_REGION: region = "eu" } = process.env;',
  "// process.env.IN_A_COMMENT is a mention, not a read",
  "export default function Orders() {",
  '  const note = "process.env.IN_A_STRING";',
  '  return <Tool name="lookup" description="Look up an order." onSubmit={() => {',
  '    const base = process.env.ORDERS_URL ?? process.env["ORDERS_FALLBACK_URL"];',
  "    return { ok: Boolean(base && ORDERS_TOKEN && region && note) };",
  "  }} />;",
  "}",
  "",
].join("\n");

describe("what the project's code reads", () => {
  it("finds process.env.NAME, process.env[\"NAME\"] and const { NAME } = process.env with file and line", async () => {
    const root = project({
      "src/agent/orders/skill.tsx": ORDERS_SKILL,
      "src/lib/client.ts": "export const timeout = Number(process.env.ORDERS_URL);\n",
      // Never loaded by the framework (AGENT_ORCHESTRATION_IGNORED), so not something it needs.
      "src/orchestration/session.ts": "export const url = process.env.LEFTOVER_URL;\n",
    });

    const { configuration } = await configurationOf(root);

    expect(configuration.code).toEqual([
      { name: "ORDERS_FALLBACK_URL", set: false, neededBy: "src/agent/orders/skill.tsx:8", optional: false },
      { name: "ORDERS_REGION", set: false, neededBy: "src/agent/orders/skill.tsx:3", optional: false },
      { name: "ORDERS_TOKEN", set: false, neededBy: "src/agent/orders/skill.tsx:3", optional: false },
      { name: "ORDERS_URL", set: false, neededBy: "src/agent/orders/skill.tsx:8 (+1 more)", optional: false },
    ]);
  });

  it("counts a value from .env or the environment as set, and an empty one as missing", async () => {
    const root = project({
      "src/agent/orders/skill.tsx": ORDERS_SKILL,
      ".env": "ORDERS_URL=https://orders.example\nORDERS_TOKEN=\n",
      "package.json": JSON.stringify({ name: "p", private: true, type: "module", curb: { requiredRuntimeSecrets: ["WEBHOOK_KEY"] } }),
    });

    const { configuration } = await configurationOf(root, { ORDERS_REGION: "eu", ORDERS_FALLBACK_URL: "  " });

    expect(configuration.code.map(({ name, set }) => [name, set])).toEqual([
      ["ORDERS_FALLBACK_URL", false],
      ["ORDERS_REGION", true],
      ["ORDERS_TOKEN", false],
      ["ORDERS_URL", true],
      ["WEBHOOK_KEY", false],
    ]);
    expect(configuration.code.at(-1)).toEqual({
      name: "WEBHOOK_KEY",
      set: false,
      neededBy: "declared in package.json",
      optional: false,
    });
  });
});

describe("AGENT_ENV_NOT_DECLARED", () => {
  it("warns once per variable .env.example does not list, at its first read", async () => {
    const root = project({
      "src/agent/orders/skill.tsx": ORDERS_SKILL,
      "src/lib/client.ts": "export const timeout = Number(process.env.ORDERS_URL);\n",
      ".env.example": "ORDERS_TOKEN=\n# ORDERS_REGION=eu\n",
    });

    const { diagnostics } = await configurationOf(root);

    /** Where `text` starts on line 8 of the skill, as `8:column`. */
    const onLine8 = (text: string) => `8:${ORDERS_SKILL.split("\n")[7]!.indexOf(text) + 1}`;
    expect(diagnostics.map(formatAuthoringDiagnostic)).toEqual([
      "[AGENT_ENV_NOT_DECLARED] WARNING: The code reads ORDERS_URL from the environment, but .env.example does not list it.\n" +
        `Location: src/agent/orders/skill.tsx:${onLine8("process.env.ORDERS_URL")}\n` +
        "Fix: Add ORDERS_URL= to .env.example, with no value, so whoever deploys the agent knows to set it.",
      "[AGENT_ENV_NOT_DECLARED] WARNING: The code reads ORDERS_FALLBACK_URL from the environment, but .env.example does not list it.\n" +
        `Location: src/agent/orders/skill.tsx:${onLine8('process.env["ORDERS_FALLBACK_URL"]')}\n` +
        "Fix: Add ORDERS_FALLBACK_URL= to .env.example, with no value, so whoever deploys the agent knows to set it.",
    ]);
    expect(diagnostics.every((diagnostic) => diagnostic.location.agentId === "agent")).toBe(true);
  });

  it("is not raised for a variable .env.example lists", async () => {
    const root = project({
      "src/agent/orders/skill.tsx": ORDERS_SKILL,
      ".env.example": "ORDERS_TOKEN=\nORDERS_REGION=\nexport ORDERS_URL=\n# ORDERS_FALLBACK_URL=\n",
    });

    const { diagnostics } = await configurationOf(root);

    expect(diagnostics).toEqual([]);
  });
});

describe("what the agent's providers need", () => {
  const agentLevel = { llm: anthropic("claude-haiku-4-5"), stt: azure.stt(), tts: kugelaudio.tts() };

  it("names each key with the providers that read it, set or missing, skill overrides included", () => {
    const uses = [
      { where: "", settings: agentLevel },
      { where: "/billing", settings: { ...agentLevel, tts: elevenlabs.tts() } },
      { where: "/orders", settings: agentLevel },
    ];

    expect(providerKeys(uses, { ANTHROPIC_API_KEY: "a", KUGELAUDIO_API_KEY: "k", AZURE_SPEECH_KEY: " " })).toEqual([
      { name: "ANTHROPIC_API_KEY", set: true, neededBy: "llm anthropic", optional: false },
      { name: "AZURE_SPEECH_KEY", set: false, neededBy: "stt azure", optional: false },
      { name: "AZURE_SPEECH_REGION", set: false, neededBy: "stt azure", optional: true },
      { name: "KUGELAUDIO_API_KEY", set: true, neededBy: "tts kugelaudio", optional: false },
      { name: "ELEVEN_API_KEY", set: false, neededBy: "tts elevenlabs in /billing", optional: false },
    ]);
    // The ElevenLabs plugin takes ELEVENLABS_API_KEY for ELEVEN_API_KEY, and so does the block.
    expect(providerKeys(uses, { ELEVENLABS_API_KEY: "e" }).find((key) => key.name === "ELEVEN_API_KEY")?.set).toBe(true);
  });

  it("lists one key once for every provider that reads it, and openaiCompatible's as optional", () => {
    const onOpenai = [{ where: "", settings: { llm: openai("gpt-5"), stt: kugelaudio.stt(), tts: openai.tts() } }];

    expect(providerKeys(onOpenai, {})).toEqual([
      { name: "OPENAI_API_KEY", set: false, neededBy: "llm openai, tts openai", optional: false },
      { name: "KUGELAUDIO_API_KEY", set: false, neededBy: "stt kugelaudio", optional: false },
    ]);
    expect(providerKeys(onOpenai, { OPENAI_API_KEY: "k" })[0]?.set).toBe(true);

    const local = { llm: openaiCompatible({ baseURL: "http://127.0.0.1:11434/v1", model: "llama3.3" }), stt: kugelaudio.stt(), tts: kugelaudio.tts() };
    expect(providerKeys([{ where: "", settings: local }], {})[0]).toEqual({
      name: "AGENT_LLM_API_KEY",
      set: false,
      neededBy: "llm openai-compatible",
      optional: true,
    });
    // An endpoint that needs a key takes AGENT_LLM_API_KEY, else OPENAI_API_KEY.
    expect(providerKeys([{ where: "", settings: local }], { OPENAI_API_KEY: "k" })[0]?.set).toBe(true);
  });

  it("reads the providers from the rendered agent", async () => {
    const agent = await discoverAgent(join(FIXTURE, "src", "agent"));

    const { configuration } = await checkConfiguration({
      projectRoot: FIXTURE,
      agent,
      agentId: "agent",
      env: { KUGELAUDIO_API_KEY: "k" },
    });

    // <Agent stt={azure.stt(...)} tts={kugelaudio.tts(...)}> and the default llm, kugelaudio.llm().
    expect(configuration.providers).toEqual([
      { name: "KUGELAUDIO_API_KEY", set: true, neededBy: "llm kugelaudio, tts kugelaudio", optional: false },
      { name: "AZURE_SPEECH_KEY", set: false, neededBy: "stt azure", optional: false },
      { name: "AZURE_SPEECH_REGION", set: false, neededBy: "stt azure", optional: true },
    ]);
    expect(configuration.code).toEqual([]);
  });
});

describe("the Configuration block", () => {
  it("prints names, set or missing and what needs them, never a value", async () => {
    const root = project({
      "src/agent/orders/skill.tsx": ORDERS_SKILL,
      ".env": [
        "KUGELAUDIO_API_KEY=never-printed-kugel",
        "ORDERS_URL=https://orders.example/never-printed-path?token=never-printed-query",
        "ORDERS_TOKEN=never-printed-token",
        "",
      ].join("\n"),
      ".env.example": "ORDERS_TOKEN=\nORDERS_REGION=\nORDERS_FALLBACK_URL=\n",
    });
    const agent = await discoverAgent(join(FIXTURE, "src", "agent"));

    const { configuration, diagnostics } = await checkConfiguration({ projectRoot: root, agent, agentId: "agent", env: {} });
    const lines = formatConfiguration(configuration);

    expect(lines).toEqual([
      "Configuration (names only, never values; looked up in .env and the environment):",
      "  Providers:",
      "    KUGELAUDIO_API_KEY   set      llm kugelaudio, tts kugelaudio",
      "    AZURE_SPEECH_KEY     missing  stt azure",
      "    AZURE_SPEECH_REGION  missing  stt azure (optional)",
      "  Project code:",
      "    ORDERS_FALLBACK_URL  missing  src/agent/orders/skill.tsx:8",
      "    ORDERS_REGION        missing  src/agent/orders/skill.tsx:3",
      "    ORDERS_TOKEN         set      src/agent/orders/skill.tsx:3",
      "    ORDERS_URL           set      src/agent/orders/skill.tsx:8",
      "  A missing value does not fail the check: set it in .env to run locally.",
      "  A hosted agent gets AZURE_SPEECH_KEY, ORDERS_FALLBACK_URL and ORDERS_REGION only from `npx curb secrets push` (which sends .env) or the agent's Variables page in the dashboard.",
    ]);
    const output = [...lines, ...diagnostics.map(formatAuthoringDiagnostic)].join("\n");
    expect(output).not.toMatch(/never-printed|orders\.example/);
  });

  // Onboarding sweep 2026-10-25: a fresh scaffold with an empty .env was told that a hosted
  // agent gets every missing value from the platform, ANTHROPIC_API_KEY included.
  it("says the platform provides only KUGELAUDIO_* and every other key needs curb secrets push", () => {
    const providers = [
      { name: "ANTHROPIC_API_KEY", set: false, neededBy: "llm anthropic", optional: false },
      { name: "KUGELAUDIO_API_KEY", set: false, neededBy: "stt kugelaudio, tts kugelaudio", optional: false },
    ];
    const code = [{ name: "TERMIN_WEBHOOK_URL", set: false, neededBy: "src/agent/termin/skill.tsx:4", optional: false }];

    expect(formatConfiguration({ providers, code, declarationError: null }).slice(-3)).toEqual([
      "  A missing value does not fail the check: set it in .env to run locally.",
      "  A hosted agent gets ANTHROPIC_API_KEY and TERMIN_WEBHOOK_URL only from `npx curb secrets push` (which sends .env) or the agent's Variables page in the dashboard.",
      "  A hosted agent gets KUGELAUDIO_API_KEY from the platform.",
    ]);
  });

  // a new project runs on kugelaudio.llm(), stt and tts, so the one key it needs is
  // the KugelAudio key, which runs it locally from .env and comes from the platform when hosted.
  it("asks a KugelAudio-only agent to sign in with curb login, and the platform when hosted", () => {
    const uses = [{ where: "", settings: { llm: kugelaudio.llm(), stt: kugelaudio.stt(), tts: kugelaudio.tts() } }];

    expect(formatConfiguration({ providers: providerKeys(uses, {}), code: [], declarationError: null })).toEqual([
      "Configuration (names only, never values; looked up in .env and the environment):",
      "  Providers:",
      "    KUGELAUDIO_API_KEY  not signed in: run npx curb login  llm kugelaudio, stt kugelaudio, tts kugelaudio",
      "  Project code: reads no variables.",
      "  Run `npx curb login` to sign in, or set KUGELAUDIO_API_KEY (an API key from the dashboard).",
      "  A missing value does not fail the check: set it in .env to run locally.",
      "  A hosted agent gets KUGELAUDIO_API_KEY from the platform.",
    ]);
    expect(formatConfiguration({ providers: providerKeys(uses, { KUGELAUDIO_API_KEY: "k" }), code: [], declarationError: null })).toEqual([
      "Configuration (names only, never values; looked up in .env and the environment):",
      "  Providers:",
      "    KUGELAUDIO_API_KEY  set      llm kugelaudio, stt kugelaudio, tts kugelaudio",
      "  Project code: reads no variables.",
    ]);
  });

  // A key `curb login` stored reads as coming from the login, by who and which project, never by value.
  it("says a key came from curb login, and \"set\" for one from .env or the environment", async () => {
    const agent = await discoverAgent(join(FIXTURE, "src", "agent"));
    const loginKey = {
      apiKey: "never-printed-login-key",
      keyId: 100,
      orgId: "org_pub_acme",
      orgName: "Acme",
      projectId: "prj_pub_voice",
      projectName: "Voice",
      webUrl: "https://www.kugelaudio.com",
      email: "dev@example.com",
    };
    const env = { KUGELAUDIO_API_KEY: loginKey.apiKey };

    const fromLogin = await checkConfiguration({ projectRoot: FIXTURE, agent, agentId: "agent", env, loginKey });
    const lines = formatConfiguration(fromLogin.configuration);
    expect(lines[2]).toBe(
      "    KUGELAUDIO_API_KEY   from your login (dev@example.com, Acme / Voice)  llm kugelaudio, tts kugelaudio",
    );
    expect(lines.join("\n")).not.toContain("never-printed");

    const fromEnv = await checkConfiguration({ projectRoot: FIXTURE, agent, agentId: "agent", env, loginKey: null });
    expect(formatConfiguration(fromEnv.configuration)[2]).toBe("    KUGELAUDIO_API_KEY   set      llm kugelaudio, tts kugelaudio");
  });

  // A hosted workspace supplies the key itself: curb check never sends anyone to set one there.
  it("says a key comes from the hosted workspace, and that a missing one is not issued yet", async () => {
    const agent = await discoverAgent(join(FIXTURE, "src", "agent"));
    const host = { CURB_PLATFORM_TOKEN_FILE: "/var/run/curb/platform/token.json" };

    const supplied = await checkConfiguration({
      projectRoot: FIXTURE, agent, agentId: "agent", loginKey: null,
      env: { ...host, KUGELAUDIO_API_KEY: "never-printed-host-key", CURB_HOST_MODEL_KEY: "1" },
    });
    const lines = formatConfiguration(supplied.configuration);
    expect(lines[2]).toContain("KUGELAUDIO_API_KEY   from this workspace (it renews the key; nothing to set)");
    expect(lines.join("\n")).not.toContain("never-printed");

    const pending = formatConfiguration(
      (await checkConfiguration({ projectRoot: FIXTURE, agent, agentId: "agent", loginKey: null, env: host })).configuration,
    );
    expect(pending[2]).toContain("not issued yet: this workspace supplies it once it runs; nothing to set");
    expect(pending.join("\n")).not.toContain("curb login");
  });

  it("says when the providers are not known, and when the code reads nothing", () => {
    expect(formatConfiguration({ providers: null, code: [], declarationError: null })).toEqual([
      "Configuration (names only, never values; looked up in .env and the environment):",
      "  Providers: not known until the errors above are fixed.",
      "  Project code: reads no variables.",
    ]);
  });

  it("does not ask for an optional variable that is not set", () => {
    const providers = [
      { name: "KUGELAUDIO_API_KEY", set: true, neededBy: "stt kugelaudio, tts kugelaudio", optional: false },
      { name: "AGENT_LLM_API_KEY", set: false, neededBy: "llm openai-compatible", optional: true },
    ];

    expect(formatConfiguration({ providers, code: [], declarationError: null })).toEqual([
      "Configuration (names only, never values; looked up in .env and the environment):",
      "  Providers:",
      "    KUGELAUDIO_API_KEY  set      stt kugelaudio, tts kugelaudio",
      "    AGENT_LLM_API_KEY   missing  llm openai-compatible (optional)",
      "  Project code: reads no variables.",
    ]);
  });

  it("shows why package.json curb.requiredRuntimeSecrets could not be read", async () => {
    const root = project({
      "package.json": JSON.stringify({ name: "p", private: true, type: "module", curb: { requiredRuntimeSecrets: "WEBHOOK_KEY" } }),
    });

    const { configuration } = await configurationOf(root);

    expect(configuration.declarationError).toMatch(/curb\.requiredRuntimeSecrets must be an array/);
    expect(formatConfiguration(configuration).at(-1)).toBe(`  ${configuration.declarationError}`);
  });
});
