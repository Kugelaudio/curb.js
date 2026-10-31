import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { curbVersion } from "../version.js";
import { dependencySpec, infoReport, readProviders } from "./info.js";
import { createTestProject } from "./test-project.js";

const BIN = fileURLToPath(new URL("../../bin/curb.js", import.meta.url));

const directories: string[] = [];
const project = (files: Record<string, string>) => {
  const root = createTestProject(files);
  directories.push(root);
  return root;
};
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agentWith = (props: string, imports = "kugelaudio, openai, anthropic, azure, openaiCompatible") =>
  [
    'import { Agent, defineAgent } from "curb";',
    `import { ${imports} } from "curb/providers";`,
    `export const agent = defineAgent({ app: () => <Agent ${props}><></></Agent> });`,
    "",
  ].join("\n");

describe("the providers curb info reads from the source", () => {
  it("names the props that call a provider factory, under any local name", () => {
    const root = project({
      "src/agent/agent.tsx": agentWith(
        'llm={claude("some-model")} stt={azure.stt({ language: "en" })} tts={kugelaudio.tts({ voice: 1 })}',
        "anthropic as claude, azure, kugelaudio",
      ),
    });
    expect(readProviders(root).agent).toEqual({ llm: "anthropic", stt: "azure", tts: "kugelaudio" });
  });

  it("calls an unset slot the default, and a prop it cannot read set in code", async () => {
    const root = project({ "src/agent/agent.tsx": agentWith("tts={voices.main}") });
    const report = await infoReport(root, {});
    expect(report).toContain("LLM  kugelaudio (default)");
    expect(report).toContain("STT  azure (default)");
    expect(report).toContain("TTS  set in code");
  });

  it("does not assume the defaults under a spread or with no <Agent> in the source", async () => {
    const spread = project({ "src/agent/agent.tsx": agentWith("{...providers}") });
    expect(await infoReport(spread, {})).toContain("LLM  set in code");
    const none = project({ "src/agent/agent.tsx": "export const agent = makeAgent();\n" });
    expect(await infoReport(none, {})).toContain("STT  set in code");
  });

  it("lists a skill's own provider and the variables it needs", async () => {
    const root = project({
      "src/agent/agent.tsx": agentWith("tts={kugelaudio.tts()}"),
      "src/agent/report/skill.tsx": [
        'import { Skill } from "curb";',
        'import { openai } from "curb/providers";',
        'export default () => <Skill path="/report" description="Reports." llm={openai("some-model")} />;',
        "",
      ].join("\n"),
    });
    const report = await infoReport(root, {});
    expect(report).toContain("LLM  kugelaudio (default), openai in /report");
    expect(report).toMatch(/OPENAI_API_KEY +not set/);
  });

  it("does not run the project's code", async () => {
    const root = project({
      "src/agent/agent.tsx": `throw new Error("ran");\n${agentWith("stt={azure.stt()}")}`,
    });
    expect(await infoReport(root, {})).toContain("STT  azure");
  });
});

describe("the variables curb info reports", () => {
  it("says which expected variables are set, from .env and the environment, with no value", async () => {
    const root = project({
      "src/agent/agent.tsx": agentWith("stt={azure.stt()}"),
      "src/agent/lookup.ts": "export const url = process.env.ORDERS_URL;\n",
      ".env": "AZURE_SPEECH_KEY=value-in-dot-env\n",
    });
    const report = await infoReport(root, { ORDERS_URL: "https://user:value-in-env@orders.test/" });
    expect(report).toMatch(/AZURE_SPEECH_KEY +set/);
    expect(report).toMatch(/AZURE_SPEECH_REGION +not set \(optional\)/);
    expect(report).toMatch(/KUGELAUDIO_API_KEY +not set/);
    expect(report).toMatch(/ORDERS_URL +set/);
    expect(report).not.toContain("value-in");
  });
});

describe("dependencySpec", () => {
  it("prints the spec, without the credentials or query a URL can carry", () => {
    const spec = (curb: string) => dependencySpec(project({ "package.json": JSON.stringify({ devDependencies: { curb } }) }));
    expect(spec("npm:curb.js@preview")).toBe("npm:curb.js@preview");
    expect(spec("git+https://user:hunter2@example.com/curb.git#main")).toBe("git+https://example.com/curb.git#main");
    expect(spec("https://example.com/curb.tgz?token=hunter2")).toBe("https://example.com/curb.tgz");
  });
});

/** `curb info` as a user runs it. */
function curbInfo(cwd: string, env: Record<string, string> = {}) {
  const { AGENT_PROJECT_DIR: _, ...inherited } = process.env;
  return spawnSync(process.execPath, [BIN, "info"], { cwd, encoding: "utf8", env: { ...inherited, ...env } });
}

describe("curb info", () => {
  it("never prints a set secret's value, from .env, the environment or the source", () => {
    const secrets = ["sk-secret-in-dot-env", "sk-secret-in-environment", "sk-secret-in-source"];
    const root = project({
      "package.json": JSON.stringify({ dependencies: { curb: "*" } }),
      "src/agent/agent.tsx": agentWith(
        `llm={openaiCompatible({ baseURL: "http://127.0.0.1/v1", model: "m", apiKey: "${secrets[2]}" })}`,
      ),
      ".env": `KUGELAUDIO_API_KEY=${secrets[0]}\nAZURE_SPEECH_KEY=${secrets[1]}\n`,
    });
    const result = curbInfo(root, { AZURE_SPEECH_KEY: secrets[1]!, OPENAI_API_KEY: secrets[1]! });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LLM  openai-compatible");
    expect(result.stdout).toMatch(/KUGELAUDIO_API_KEY +set/);
    expect(result.stdout).toMatch(/AZURE_SPEECH_KEY +set/);
    for (const secret of secrets) expect(result.stdout + result.stderr).not.toContain(secret);
  }, 60_000);

  it("works outside a project and says so", () => {
    const empty = mkdtempSync(join(tmpdir(), "curb-info-"));
    directories.push(empty);
    writeFileSync(join(empty, "notes.txt"), "not a project\n");
    const result = curbInfo(empty);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`version  ${curbVersion()}`);
    expect(result.stdout).toContain(`Node     ${process.version}`);
    expect(result.stdout).toContain("Project: none.");
    expect(result.stderr).toBe("");
  }, 60_000);
});
