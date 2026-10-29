import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { parse } from "@babel/parser";
import type { DiscoveredAgent } from "../agent.node.js";
import { AUTHORING_DIAGNOSTIC_CODES, type AuthoringDiagnostic } from "../authoring.js";
import { bundleRequiredSecrets } from "../bundler/declarations.js";
import { LLM_KEYS, PLATFORM_PROVIDED, SPEECH_KEYS, type Env, type ProviderVariable } from "../provider-keys.js";
import { agentAppElement } from "../routing.js";
import { AgentSiteRuntime } from "../runtime.js";
import type { ProviderSettings } from "../session-settings.js";
import type { StoredProjectKey } from "./cloud/credentials.js";
import { runsOnHostKey } from "./cloud/host-model-key.js";
import { PLATFORM_TOKEN_FILE_ENV } from "./cloud/platform-token.js";

/**
 * The Configuration block of `curb check`: every environment variable the project needs and
 * whether it has a value, by name. A coding agent that may not read .env, or a builder who
 * keeps secrets away from it, learns here whether a key is set. No value, length or prefix
 * of one is ever kept in the result.
 */

/** One variable the project needs: whether it holds a non-empty value, what needs it, and
 * whether it runs without it. `from` says where a value came from that neither .env nor the
 * environment set: the key `curb login` stored, or the one a hosted workspace supplies.
 * `pending` says why a value nobody needs to set is not there yet. */
export type ConfigurationEntry = {
  name: string;
  set: boolean;
  neededBy: string;
  optional: boolean;
  from?: string;
  pending?: string;
};

export type Configuration = {
  /** The keys the agent's providers read; null when the agent did not load or render. */
  providers: ConfigurationEntry[] | null;
  /** What the project's own code reads under src/, and the runtime secrets package.json declares. */
  code: ConfigurationEntry[];
  /** Why package.json `curb.requiredRuntimeSecrets` could not be read, when it could not. */
  declarationError: string | null;
};

/** The providers a conversation runs on at one place in the agent: the agent level (`where`
 * is "") or a skill, while it is the active one. */
export type ProviderUse = { where: string; settings: ProviderSettings };

/** One place the project's code reads a variable from `process.env`. */
type EnvRead = { name: string; file: string; line: number; column: number };

/**
 * What the project needs from its environment, and an `AGENT_ENV_NOT_DECLARED` warning for
 * each variable its code reads that .env.example does not list. A missing value is never a
 * diagnostic: a hosted agent gets its values from `curb secrets push` and the platform, not
 * from this checkout.
 */
export async function checkConfiguration(options: {
  projectRoot: string;
  agent: DiscoveredAgent | null;
  agentId: string;
  env?: Env;
  /** The key `curb login` stored that this run uses (see `useLoginKey`), when it uses one. */
  loginKey?: StoredProjectKey | null;
}): Promise<{ configuration: Configuration; diagnostics: AuthoringDiagnostic[] }> {
  const { projectRoot, agent, agentId } = options;
  const env = projectEnvironment(projectRoot, options.env ?? process.env);

  let uses: ProviderUse[] | null = null;
  if (agent) {
    try {
      uses = agentProviderUses(agent);
    } catch {
      // KEEP-JUSTIFIED: the authoring diagnostics render the same agent and report why it
      // does not render; the block says the providers are not known until that is fixed.
    }
  }
  const hostFile = Boolean(env[PLATFORM_TOKEN_FILE_ENV]);
  const fromLogin = (entry: ConfigurationEntry): ConfigurationEntry => {
    if (entry.name !== "KUGELAUDIO_API_KEY") return entry;
    if (entry.set && options.loginKey) {
      return { ...entry, from: `your login (${options.loginKey.email}, ${options.loginKey.orgName} / ${options.loginKey.projectName})` };
    }
    if (entry.set && runsOnHostKey(env)) return { ...entry, from: "this workspace (it renews the key; nothing to set)" };
    if (!entry.set && hostFile) {
      return { ...entry, pending: "not issued yet: this workspace supplies it once it runs; nothing to set" };
    }
    return entry;
  };
  const providers = uses ? providerKeys(uses, env).map(fromLogin) : null;

  let declared: string[] = [];
  let declarationError: string | null = null;
  try {
    declared = (await bundleRequiredSecrets(projectRoot)).map((secret) => secret.name);
  } catch (error) {
    declarationError = error instanceof Error ? error.message : String(error);
  }

  const reads = findEnvReads(projectRoot);
  const providerNames = new Set(providers?.map((entry) => entry.name));
  return {
    configuration: { providers, code: codeEntries(reads, declared, env, providerNames).map(fromLogin), declarationError },
    diagnostics: undeclaredReads(reads, namesInEnvExample(projectRoot), agentId),
  };
}

/** The block as `curb check` prints it. */
export function formatConfiguration({ providers, code, declarationError }: Configuration): string[] {
  const entries = [...(providers ?? []), ...code];
  const width = Math.max(0, ...entries.map((entry) => entry.name.length));
  const row = (entry: ConfigurationEntry) =>
    `    ${entry.name.padEnd(width)}  ${entryState(entry)}  ${entry.neededBy}${entry.optional ? " (optional)" : ""}`;
  return [
    "Configuration (names only, never values; looked up in .env and the environment):",
    providers ? "  Providers:" : "  Providers: not known until the errors above are fixed.",
    ...(providers ?? []).map(row),
    code.length > 0 ? "  Project code:" : "  Project code: reads no variables.",
    ...code.map(row),
    ...(declarationError ? [`  ${declarationError}`] : []),
    ...missingValueAdvice(entries),
  ];
}

/** Where an entry's value comes from, or what to do when it has none. An unset
 * KUGELAUDIO_API_KEY means nobody signed in yet (a login supplies it), not a lost key. */
function entryState(entry: ConfigurationEntry): string {
  if (entry.from) return `from ${entry.from}`;
  if (entry.pending) return entry.pending;
  if (entry.set) return "set".padEnd("missing".length);
  return entry.name === "KUGELAUDIO_API_KEY" ? "not signed in: run npx curb login" : "missing";
}

/**
 * What to do about the values that are missing: .env to run locally, and for a hosted agent
 * the one source each value has there. The platform provides only `PLATFORM_PROVIDED`; every
 * other value reaches a hosted agent only through `curb secrets push` or its Variables page.
 */
function missingValueAdvice(entries: readonly ConfigurationEntry[]): string[] {
  const missing = [...new Set(entries.filter((entry) => !entry.set && !entry.optional && !entry.pending).map((entry) => entry.name))];
  if (missing.length === 0) return [];
  const fromPlatform = missing.filter((name) => PLATFORM_PROVIDED.has(name));
  const pushed = missing.filter((name) => !PLATFORM_PROVIDED.has(name));
  return [
    ...(missing.includes("KUGELAUDIO_API_KEY")
      ? ["  Run `npx curb login` to sign in, or set KUGELAUDIO_API_KEY (an API key from the dashboard)."]
      : []),
    "  A missing value does not fail the check: set it in .env to run locally.",
    ...(pushed.length > 0
      ? [
          `  A hosted agent gets ${listed(pushed)} only from \`npx curb secrets push\` (which sends .env) ` +
            "or the agent's Variables page in the dashboard.",
        ]
      : []),
    ...(fromPlatform.length > 0 ? [`  A hosted agent gets ${listed(fromPlatform)} from the platform.`] : []),
  ];
}

const listed = (names: readonly string[]) =>
  names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The variables the given providers read (`provider-keys.ts`), each with whether `env` holds
 * it, which providers read it, and whether they all run without it. A value is read the way
 * the provider reads it, so ELEVENLABS_API_KEY counts for ELEVEN_API_KEY.
 */
export function providerKeys(uses: readonly ProviderUse[], env: Env): ConfigurationEntry[] {
  const found = new Map<string, { set: boolean; optional: boolean; users: Map<string, Set<string>> }>();
  const read = (variable: ProviderVariable, user: string, where: string) => {
    const entry = found.get(variable.name) ?? { set: true, optional: true, users: new Map<string, Set<string>>() };
    entry.set &&= Boolean(variable.read(env));
    entry.optional &&= !variable.required;
    entry.users.set(user, (entry.users.get(user) ?? new Set<string>()).add(where));
    found.set(variable.name, entry);
  };
  for (const { where, settings } of uses) {
    for (const slot of ["llm", "stt", "tts"] as const) {
      const keys = slot === "llm" ? LLM_KEYS[settings.llm.provider] : SPEECH_KEYS[settings[slot].provider];
      // A provider no factory builds is a type error, which the type check reports.
      if (!keys) continue;
      for (const variable of [keys.key, ...(keys.also ?? [])]) read(variable, `${slot} ${settings[slot].provider}`, where);
    }
  }
  return [...found].map(([name, { set, optional, users }]) => ({
    name,
    set,
    neededBy: [...users]
      .map(([user, wheres]) => (wheres.has("") ? user : `${user} in ${[...wheres].join(", ")}`))
      .join(", "),
    optional,
  }));
}

/**
 * The providers a conversation can run on: the agent level's, then each skill's while it is
 * the active one (its `<Skill>` link may set its own), read by the runtime exactly as a
 * session reads them, with every skill loaded.
 */
function agentProviderUses(agent: DiscoveredAgent): ProviderUse[] {
  const paths = agent.routes.map((route) => route.path);
  const runtime = new AgentSiteRuntime(
    ({ path, loadedPaths }) => agentAppElement(agent.definition.app, { path, loadedPaths, routes: agent.routes }),
    { maxLoadedSkills: Math.max(paths.length, 1) },
  );
  const uses: ProviderUse[] = [{ where: "", settings: runtime.settings.current() }];
  for (const path of paths) {
    runtime.loadSkill(path);
    uses.push({ where: path, settings: runtime.settings.current() });
  }
  return uses;
}

/** What the project's code reads, then what package.json declares, each name once and not
 * again when a provider already needs it. */
function codeEntries(
  reads: readonly EnvRead[],
  declared: readonly string[],
  env: Env,
  providerNames: ReadonlySet<string>,
): ConfigurationEntry[] {
  const byName = new Map<string, EnvRead[]>();
  for (const read of reads) byName.set(read.name, [...(byName.get(read.name) ?? []), read]);
  return [...new Set([...byName.keys(), ...declared])]
    .filter((name) => !providerNames.has(name))
    .sort()
    .map((name) => {
      const at = byName.get(name);
      const neededBy = at
        ? `${at[0]!.file}:${at[0]!.line}${at.length > 1 ? ` (+${at.length - 1} more)` : ""}`
        : "declared in package.json";
      return { name, set: isSet(env, name), neededBy, optional: false };
    });
}

/** One warning per variable the code reads and .env.example does not list, at its first read. */
function undeclaredReads(reads: readonly EnvRead[], listed: ReadonlySet<string>, agentId: string): AuthoringDiagnostic[] {
  const first = new Map<string, EnvRead>();
  for (const read of reads) if (!listed.has(read.name) && !first.has(read.name)) first.set(read.name, read);
  return [...first.values()].map((read) => ({
    code: AUTHORING_DIAGNOSTIC_CODES.envNotDeclared,
    severity: "warning",
    message: `The code reads ${read.name} from the environment, but .env.example does not list it.`,
    location: { agentId, source: read.file, line: read.line, column: read.column },
    fix: `Add ${read.name}= to .env.example, with no value, so whoever deploys the agent knows to set it.`,
  }));
}

/** An empty value counts as unset, as it does for every key the framework reads. */
const isSet = (env: Env, name: string) => Boolean(env[name]?.trim());

/** The environment the agent runs with: the project's .env under the real environment, as
 * `curb dev` composes it. */
function projectEnvironment(projectRoot: string, env: Env): Env {
  const file = join(projectRoot, ".env");
  return { ...(existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {}), ...env };
}

/** `NAME=` lines of .env.example, commented ones included: a `# NAME=` line tells whoever
 * deploys the agent about an optional variable just as well. */
const EXAMPLE_ENTRY = /^\s*(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function namesInEnvExample(projectRoot: string): Set<string> {
  const file = join(projectRoot, ".env.example");
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .flatMap((line) => EXAMPLE_ENTRY.exec(line)?.[1] ?? []),
  );
}

// --- process.env reads in the project's source -------------------------------------------

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Every `process.env.NAME`, `process.env["NAME"]` and `const { NAME } = process.env` in the
 * project's own files under src/, from the parsed source, so a name in a comment or a string
 * is not a read. src/orchestration/ is left out: the framework never loads it.
 */
function findEnvReads(projectRoot: string): EnvRead[] {
  return sourceFiles(projectRoot).flatMap((file) => envReadsIn(readFileSync(join(projectRoot, file), "utf8"), file));
}

function sourceFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const visitDir = (dir: string) => {
    for (const entry of readdirSync(join(projectRoot, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules" && path !== "src/orchestration") visitDir(path);
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(path);
      }
    }
  };
  if (existsSync(join(projectRoot, "src"))) visitDir("src");
  return files.sort();
}

type AstNode = { type: string; loc?: { start: { line: number; column: number } } | null; [key: string]: unknown };

function envReadsIn(code: string, file: string): EnvRead[] {
  let ast: unknown;
  try {
    ast = parse(code, {
      sourceType: "module",
      errorRecovery: true,
      // JSX only in .tsx/.jsx: in a .ts file `<T>value` is a type assertion.
      plugins: file.endsWith("x") ? ["jsx", "typescript"] : ["typescript"],
    });
  } catch {
    // KEEP-JUSTIFIED: the type check reports why this file does not parse; its reads are
    // found once it does.
    return [];
  }
  const reads: EnvRead[] = [];
  const read = (name: string | undefined, at: AstNode) => {
    if (name && ENV_NAME.test(name) && at.loc) {
      reads.push({ name, file, line: at.loc.start.line, column: at.loc.start.column + 1 });
    }
  };
  walk(ast, (node) => {
    if ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && isProcessEnv(node.object)) {
      read(staticKey(node.property, node.computed), node);
    } else if (node.type === "VariableDeclarator" && isProcessEnv(node.init) && isNode(node.id) && node.id.type === "ObjectPattern") {
      for (const property of node.id.properties as unknown[]) {
        if (isNode(property) && property.type === "ObjectProperty" && isNode(property.key)) {
          read(staticKey(property.key, property.computed), property.key);
        }
      }
    }
  });
  return reads.sort((left, right) => left.line - right.line || left.column - right.column);
}

const isNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** `process.env` itself (also `process?.env`). */
function isProcessEnv(node: unknown): boolean {
  return (
    isNode(node) &&
    (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
    !node.computed &&
    isNode(node.object) &&
    node.object.type === "Identifier" &&
    node.object.name === "process" &&
    isNode(node.property) &&
    node.property.type === "Identifier" &&
    node.property.name === "env"
  );
}

/** The name a member or destructured key spells out: `.NAME`, `["NAME"]`, or a template
 * literal with no substitution. A computed name is no static read. */
function staticKey(key: unknown, computed: unknown): string | undefined {
  if (!isNode(key)) return undefined;
  if (key.type === "Identifier") return computed ? undefined : (key.name as string);
  if (key.type === "StringLiteral") return key.value as string;
  if (key.type === "TemplateLiteral" && (key.expressions as unknown[]).length === 0) {
    return ((key.quasis as AstNode[])[0]?.value as { cooked?: string } | undefined)?.cooked;
  }
  return undefined;
}

const METADATA_KEYS = new Set(["loc", "extra", "comments", "leadingComments", "trailingComments", "innerComments", "errors"]);

/** Every node under `node`, depth first. */
function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (!METADATA_KEYS.has(key) && typeof value === "object" && value !== null) walk(value, visit);
  }
}
