// Scaffolds a project (no install, no git) and checks the
// generated tree. A hosted deploy refuses any symbolic link in the source, so the tree
// an unchanged project starts from must contain none.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bin = fileURLToPath(new URL("../bin/create-curb-app.js", import.meta.url));
const template = fileURLToPath(new URL("../templates/default", import.meta.url));

function scaffold(t, flags = []) {
  const root = mkdtempSync(join(tmpdir(), "create-curb-app-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "app");
  const result = run(root, [project, ...flags]);
  assert.equal(result.status, 0, result.stderr);
  return project;
}

/** create-curb-app with the test's flags, no install, no git, from `cwd`; its result. */
function run(cwd, args) {
  return spawnSync(
    process.execPath,
    [bin, ...args, "--skip-install", "--skip-git", "--framework", "file:/unused"],
    // No provider keys: the test must not write a developer's real keys to disk.
    { cwd, env: { PATH: process.env.PATH, HOME: cwd }, encoding: "utf8" },
  );
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

function* symlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) yield path;
    else if (entry.isDirectory()) yield* symlinks(path);
  }
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("the generated project contains no symbolic link", (t) => {
  const project = scaffold(t);
  const links = [...symlinks(project)].map((path) => relative(project, path));
  assert.deepEqual(links, []);
});

test("CLAUDE.md is a regular file that imports AGENTS.md", (t) => {
  const project = scaffold(t);
  assert.ok(lstatSync(join(project, "CLAUDE.md")).isFile());
  assert.equal(readFileSync(join(project, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.ok(lstatSync(join(project, "AGENTS.md")).isFile());
});

// Claude Code started in the project gets the KugelAudio account and docs MCP servers from
// .mcp.json, so AGENTS.md points there instead of asking for a `claude mcp add` command.
test(".mcp.json registers the KugelAudio MCP servers, and AGENTS.md points at it", (t) => {
  const project = scaffold(t);
  assert.deepEqual(readJson(join(project, ".mcp.json")), {
    mcpServers: {
      kugelaudio: { type: "http", url: "https://www.kugelaudio.com/mcp" },
      "kugelaudio-docs": { type: "http", url: "https://docs.kugelaudio.com/mcp" },
    },
  });
  const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
  assert.match(agents, /\.mcp\.json/);
  assert.doesNotMatch(agents, /claude mcp add/);
});

// a new project needs exactly one key, and a hosted agent none of its own.
test("the default agent runs on KugelAudio's LLM, Kugel Ear and Kugel TTS, all on the one KugelAudio key", (t) => {
  const project = scaffold(t);
  const agent = readFileSync(join(project, "src/agent/agent.tsx"), "utf8");
  assert.match(
    agent,
    /<Agent llm=\{kugelaudio\.llm\(\)\} stt=\{kugelaudio\.stt\(\{ language: "en" \}\)\} tts=\{kugelaudio\.tts\(\)\}>/,
  );
  assert.match(agent, /import \{ kugelaudio \} from "curb\/providers";/);
  const manifest = readJson(join(project, "package.json"));
  // Framework-native: no LiveKit plugin package, and no Azure key asked for.
  assert.ok(!Object.keys(manifest.dependencies).some((name) => name.startsWith("@livekit/agents-plugin-")));
  assert.deepEqual(manifest.curb.requiredRuntimeSecrets, ["KUGELAUDIO_API_KEY"]);
  for (const file of [".env.example", "README.md", "AGENTS.md"]) {
    assert.doesNotMatch(readFileSync(join(project, file), "utf8"), /ANTHROPIC/, file);
  }
});

// create-curb-app asks nothing: with no provider flags, in a terminal or not, it writes the
// KugelAudio defaults straight away and prints no question.
for (const stdin of ["closed", "tty-less pipe"]) {
  test(`no flags and a ${stdin} stdin writes the KugelAudio defaults without a question`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "create-curb-app-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "app");
    const result = spawnSync(process.execPath, [bin, project, "--skip-install", "--skip-git", "--framework", "file:/unused"], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root },
      encoding: "utf8",
      // "closed": stdin is /dev/null. "tty-less pipe": a pipe that stays open and never answers.
      stdio: [stdin === "closed" ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\?/);
    assert.match(result.stdout, /Uses KugelAudio for speech and the language model/);
    assert.match(result.stdout, /npx curb login/);
    const agent = readFileSync(join(project, "src/agent/agent.tsx"), "utf8");
    assert.match(
      agent,
      /<Agent llm=\{kugelaudio\.llm\(\)\} stt=\{kugelaudio\.stt\(\{ language: "en" \}\)\} tts=\{kugelaudio\.tts\(\)\}>/,
    );
  });
}

test("--yes is accepted and changes nothing", (t) => {
  const project = scaffold(t, ["--yes"]);
  assert.match(readFileSync(join(project, "src/agent/agent.tsx"), "utf8"), /llm=\{kugelaudio\.llm\(\)\}/);
});

test("--model picks the other KugelAudio model, and one KugelAudio does not serve is refused", (t) => {
  const project = scaffold(t, ["--model", "mistral-medium-3.5-128b"]);
  const agent = readFileSync(join(project, "src/agent/agent.tsx"), "utf8");
  assert.match(agent, /llm=\{kugelaudio\.llm\(\{ model: "mistral-medium-3\.5-128b" \}\)\}/);

  const root = mkdtempSync(join(tmpdir(), "create-curb-app-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const refused = run(root, [join(root, "app"), "--model", "claude-haiku-4-5"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Invalid --model "claude-haiku-4-5"\. Choose one of: qwen3\.8-27b, mistral-medium-3\.5-128b\./);
});

test("--llm anthropic still writes Claude and asks for its key", (t) => {
  const project = scaffold(t, ["--llm", "anthropic"]);
  const agent = readFileSync(join(project, "src/agent/agent.tsx"), "utf8");
  assert.match(agent, /<Agent llm=\{anthropic\("claude-haiku-4-5"\)\} stt=/);
  assert.match(agent, /import \{ anthropic, kugelaudio \} from "curb\/providers";/);
  assert.deepEqual(readJson(join(project, "package.json")).curb.requiredRuntimeSecrets, [
    "ANTHROPIC_API_KEY",
    "KUGELAUDIO_API_KEY",
  ]);
  assert.equal(readFileSync(join(project, ".env"), "utf8"), "ANTHROPIC_API_KEY=\n");
});

// A coding agent started in an empty folder scaffolds into it, so the .mcp.json, CLAUDE.md
// and AGENTS.md it reads at start are the project's.
test("scaffolds into the empty current folder with .", (t) => {
  const root = mkdtempSync(join(tmpdir(), "create-curb-app-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, "my-agent");
  mkdirSync(folder);
  const result = run(folder, ["."]);
  assert.equal(result.status, 0, result.stderr);
  for (const file of [".mcp.json", "CLAUDE.md", "AGENTS.md", "src/agent/agent.tsx"]) {
    assert.ok(existsSync(join(folder, file)), file);
  }
  assert.equal(readJson(join(folder, "package.json")).name, "my-agent");
  assert.doesNotMatch(result.stdout, /\bcd\b/);
});

test("--stt azure still writes Azure speech-to-text and asks for its key", (t) => {
  const project = scaffold(t, ["--stt", "azure"]);
  const agent = readFileSync(join(project, "src/agent/agent.tsx"), "utf8");
  assert.match(agent, /stt=\{azure\.stt\(\)\} tts=\{kugelaudio\.tts\(\)\}/);
  assert.match(agent, /import \{ azure, kugelaudio \} from "curb\/providers";/);
  assert.deepEqual(readJson(join(project, "package.json")).curb.requiredRuntimeSecrets, [
    "AZURE_SPEECH_KEY",
    "KUGELAUDIO_API_KEY",
  ]);
  assert.match(readFileSync(join(project, ".env"), "utf8"), /^AZURE_SPEECH_KEY=\nAZURE_SPEECH_REGION=eastus\n/m);
});

// The README tells the user to put the keys into .env, so the file exists even when the
// setup got no key: one empty line per key the selected providers need.
test(".env lists the keys to fill in, but not KUGELAUDIO_API_KEY: curb login provides it", (t) => {
  const project = scaffold(t);
  assert.equal(readFileSync(join(project, ".env"), "utf8"), "");
});

// The platform materializes its starter from the same template and refuses an unfilled
// placeholder, so the scaffold must fill every one too.
test("no generated file keeps a template placeholder", (t) => {
  const project = scaffold(t);
  const unfilled = [...files(project)].filter((path) => /\{\{[A-Z_]+\}\}/.test(readFileSync(path, "utf8")));
  assert.deepEqual(unfilled.map((path) => relative(project, path)), []);
  assert.match(readFileSync(join(project, "README.md"), "utf8"), /^# app\n/);
});

test("the generated project carries no voice session code of its own", (t) => {
  // The framework runs the voice session on every route, so a project carries no copy of
  // it: a src/orchestration/ would only be ignored (`curb check` warns AGENT_ORCHESTRATION_IGNORED).
  const project = scaffold(t);
  assert.ok(!existsSync(join(project, "src", "orchestration")));
  assert.deepEqual(readdirSync(join(project, "src")), ["agent"]);
});

// npm 12 skips every dependency install script that package.json "allowScripts" does not
// decide, and create-curb-app stops the setup for any it skipped. The conversation
// store is a plain file now, so the template approves no script for it.
test("the template decides every install script, with true or false", () => {
  const { allowScripts } = readJson(join(template, "package.json"));
  for (const [name, allowed] of Object.entries(allowScripts)) {
    assert.equal(typeof allowed, "boolean", `allowScripts["${name}"] must be true or false`);
  }
});

// @livekit/agents 1.9.4 (2026-10-24) depends on @livekit/blingfire, whose install script is a
// no-op (`node -e ""`; its native binding ships prebuilt). Left undecided, npm 12 skips it and
// create-curb-app stops the setup as if the agent could not run.
test("the template denies @livekit/blingfire's no-op install script", () => {
  const { allowScripts } = readJson(join(template, "package.json"));
  assert.equal(allowScripts["@livekit/blingfire"], false);
});

// JSX joins multi-line text into one line before Curb sees it (`curb check` warns
// AGENT_PROSE_JSX_TEXT), so the template's prose is one template literal per component.
test("template prose is written as template literals, never multi-line JSX text", () => {
  const prose = /<(SystemPrompt|Instruction|Text)>\s*\n\s*[^\s{<]/;
  const offenders = [...files(join(template, "src"))].filter((path) => prose.test(readFileSync(path, "utf8")));
  assert.deepEqual(offenders.map((path) => relative(template, path)), []);
});

// The framework tells the model today's date on every turn, so a date or a clock time in
// the template would be wrong on every other day.
test("the template hard-codes no date or clock time", () => {
  const dated =
    /\b(19|20)\d\d\b|\b\d{1,2}:\d\d\b|\b(January|February|March|April|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/;
  const offenders = [...files(join(template, "src")), ...files(join(template, "context"))].filter((path) =>
    dated.test(readFileSync(path, "utf8")),
  );
  assert.deepEqual(offenders.map((path) => relative(template, path)), []);
});

// A hosted build accepts public npm with package-lock.json only and refuses a project npm
// config ("project file \"npmrc\" is not supported"), so the scaffold must not write one.
test("the project has no npm config file, which hosted builds refuse", (t) => {
  const project = scaffold(t);
  for (const file of [".npmrc", "npmrc"]) assert.ok(!existsSync(join(project, file)), file);
  assert.ok(!existsSync(join(template, "npmrc")) && !existsSync(join(template, ".npmrc")));
});
