import { existsSync, readFileSync } from "node:fs";
import { PLATFORM_PROVIDED } from "../../provider-keys.js";
import { type CloudClient, seg } from "./client.js";
import type { Link } from "./link.js";

/**
 * `curb secrets push`: every variable in the project's `.env`, set on the linked agent's
 * production environment through the platform's write-only variables API
 * (`POST /v1/agents/environments/{id}/secrets {name, value}`; 201 created, 200 replaced).
 * Values are never printed, logged or returned.
 */

/** Reserved by the platform: hosted runners get a scoped room grant instead. Local `curb dev` uses them. */
const RESERVED = new Set(["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]);
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface DotenvEntry {
  name: string;
  value: string;
  line: number;
}

/**
 * Parses `.env` text the way dotenv and `node --env-file` read it: `#` comments, an
 * optional `export ` prefix, single quotes literal, double quotes with `\n` escapes and
 * multi-line values, unquoted values trimmed with a trailing ` #comment` removed. A later
 * assignment of the same name wins.
 */
export function parseDotenv(text: string): DotenvEntry[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const entries = new Map<string, DotenvEntry>();
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`.env line ${lineNumber} is not NAME=value.`);
    const [, name, rest] = match;
    let value: string;
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      let body = rest.slice(1);
      let close = findClosingQuote(body, quote);
      while (close < 0 && index + 1 < lines.length) {
        index += 1;
        body += `\n${lines[index]}`;
        close = findClosingQuote(body, quote);
      }
      if (close < 0) throw new Error(`.env line ${lineNumber}: the ${quote}-quoted value of ${name} is never closed.`);
      value = body.slice(0, close);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"');
    } else {
      value = rest.replace(/\s+#.*$/, "").trim();
    }
    entries.delete(name);
    entries.set(name, { name, value, line: lineNumber });
  }
  return [...entries.values()];
}

function findClosingQuote(body: string, quote: string): number {
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "\\" && quote === '"') {
      index += 1;
      continue;
    }
    if (body[index] === quote) return index;
  }
  return -1;
}

export interface PushOptions {
  client: CloudClient;
  link: Link;
  file: string;
  log: (line: string) => void;
}

export interface PushResult {
  set: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export async function pushSecrets(options: PushOptions): Promise<PushResult> {
  const { client, link, file, log } = options;
  if (!existsSync(file)) {
    throw new Error(`${file} does not exist. Put your provider keys there (NAME=value per line), or pass --file <path>.`);
  }
  const entries = parseDotenv(readFileSync(file, "utf8"));
  const invalid = entries.filter((entry) => !VALID_NAME.test(entry.name));
  if (invalid.length > 0) {
    throw new Error(
      `${file}: ${invalid.map((entry) => `${entry.name} (line ${entry.line})`).join(", ")} ` +
        "is not a valid variable name (letters, digits and _, not starting with a digit, at most 64). Nothing was pushed.",
    );
  }

  const skipped: PushResult["skipped"] = [];
  const toSet: DotenvEntry[] = [];
  for (const entry of entries) {
    if (PLATFORM_PROVIDED.has(entry.name)) skipped.push({ name: entry.name, reason: "provided by the platform" });
    else if (RESERVED.has(entry.name)) skipped.push({ name: entry.name, reason: "reserved: hosted calls get their own LiveKit grant" });
    else if (entry.value === "") skipped.push({ name: entry.name, reason: "empty" });
    else toSet.push(entry);
  }

  const set: string[] = [];
  const path = `/v1/agents/environments/${seg(link.environmentId)}/secrets`;
  for (const entry of toSet) {
    let status: number;
    try {
      ({ status } = await client.platform("POST", path, link.orgId, { name: entry.name, value: entry.value }));
    } catch (error) {
      const done = set.length > 0 ? ` Already pushed: ${set.join(", ")}.` : "";
      throw new Error(`Could not set ${entry.name}: ${error instanceof Error ? error.message : String(error)}${done}`);
    }
    set.push(entry.name);
    log(`  ${entry.name} ${status === 201 ? "set" : "replaced"}`);
  }
  for (const { name, reason } of skipped) log(`  ${name} skipped (${reason})`);
  log(
    set.length > 0
      ? `${set.length} variable(s) pushed to production. New calls use them; no redeploy needed.`
      : `Nothing to push from ${file}.`,
  );
  return { set, skipped };
}
