import { AUTHORING_DIAGNOSTIC_CODES, type AuthoringDiagnostic } from "../authoring.js";
import { kugelaudioSpeechBase, type Env } from "../provider-keys.js";
import type { TtsDescriptor } from "../providers.js";
import { flagValue, rejectUnknownArguments } from "./args.js";
import { CloudError, requestJson } from "./cloud/http.js";
import { PROJECT_KEY_VARIABLE } from "./cloud/project-key.js";

/**
 * The KugelAudio voices this project can speak with: `curb voices` lists them, and `curb check`
 * looks up every voice id the agent sets. Both run on the key the project runs on (the
 * `curb login` key, or KUGELAUDIO_API_KEY), so a coding agent picks a voice without a key in
 * hand, and a voice id that does not exist fails the check instead of a call going silent.
 */

export const VOICES_USAGE = `Usage: curb voices [--language <code>] [--json]

Lists the KugelAudio voices this project can use, with the id kugelaudio.tts({ voice }) takes,
on your \`npx curb login\` or KUGELAUDIO_API_KEY.
  --language <code>  only voices that speak it, e.g. en or de (en also lists en-US and en-GB)
  --json             one JSON array on stdout`;

/** One voice as the speech API lists it; only the fields a choice needs. */
export type Voice = {
  id: number;
  name: string;
  sex?: string | null;
  age?: string | null;
  category?: string | null;
  supported_languages?: string[] | null;
  description?: string | null;
};

/** What the speech API answers on `/v1/voices`. */
type VoicePage = { voices: Voice[]; total: number };

/** The most `/v1/voices` returns in one page; it refuses a larger `limit`. */
const PAGE_SIZE = 100;

/** The speech API's base and the key to call it with. */
type VoiceApi = { apiBase: string; apiKey: string };

function voiceApi(env: Env): VoiceApi | null {
  const apiKey = env[PROJECT_KEY_VARIABLE]?.trim();
  return apiKey ? { apiBase: kugelaudioSpeechBase(env), apiKey } : null;
}

const NO_KEY =
  "Listing voices needs KugelAudio access. Run `npx curb login` in the project to sign in in the browser, " +
  "or set KUGELAUDIO_API_KEY (an API key from the dashboard).";

/** Every voice the key can use, page by page, optionally only those that speak `language`. */
export async function listVoices(api: VoiceApi, language?: string): Promise<Voice[]> {
  const voices: Voice[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (language) query.set("language", language);
    const { body } = await requestJson<VoicePage>({
      method: "GET",
      url: `${api.apiBase}/v1/voices?${query}`,
      accessToken: api.apiKey,
      unauthorized: unauthorized(),
    });
    voices.push(...body.voices);
    if (body.voices.length < PAGE_SIZE || voices.length >= body.total) return voices;
  }
}

/** The voice with this id, or null when the speech API knows none for this key. */
export async function findVoice(api: VoiceApi, id: number): Promise<Voice | null> {
  try {
    const { body } = await requestJson<Voice>({
      method: "GET",
      url: `${api.apiBase}/v1/voices/${id}`,
      accessToken: api.apiKey,
      unauthorized: unauthorized(),
    });
    return body;
  } catch (error) {
    if (error instanceof CloudError && error.status === 404) return null;
    throw error;
  }
}

function unauthorized(): string {
  return (
    "KugelAudio refused the key this project runs on (HTTP 401). Run `npx curb login` again, " +
    "or replace KUGELAUDIO_API_KEY with a current API key from the dashboard."
  );
}

/** One line per voice: id, name, then what tells voices apart, then the start of its description. */
export function formatVoices(voices: readonly Voice[]): string[] {
  if (voices.length === 0) return ["No voices found."];
  const width = Math.max(...voices.map((voice) => String(voice.id).length));
  const lines = voices.map((voice) => {
    const traits = [voice.sex, voice.age, voice.category, (voice.supported_languages ?? []).join(",")]
      .filter((trait) => trait)
      .join(", ");
    const about = (voice.description ?? "").replace(/\s+/g, " ").trim();
    const short = about.length > 90 ? `${about.slice(0, 89)}…` : about;
    return [String(voice.id).padStart(width), voice.name, traits ? `(${traits})` : "", short].filter(Boolean).join("  ");
  });
  return [
    ...lines,
    `${voices.length} voice(s). Use one with tts={kugelaudio.tts({ voice: <id>, language: "<code>" })}.`,
  ];
}

export async function voicesCommand(args: readonly string[], env: Env = process.env): Promise<number> {
  rejectUnknownArguments(args, "voices", { flags: ["--json"], values: { "--language": "<code>" } });
  const api = voiceApi(env);
  if (!api) {
    console.error(NO_KEY);
    return 1;
  }
  const voices = await listVoices(api, flagValue(args, "--language"));
  if (args.includes("--json")) console.log(JSON.stringify(voices));
  else for (const line of formatVoices(voices)) console.log(line);
  return 0;
}

/** Where a call speaks with a KugelAudio voice id the agent set: the agent level ("") or a skill. */
export type VoiceUse = { where: string; tts?: Pick<TtsDescriptor, "provider"> };

/**
 * An `AGENT_VOICE_NOT_FOUND` error for each voice id the agent sets that the speech API does
 * not know for this key. Runs only with KugelAudio access; without it the Configuration block
 * already says so. A lookup that fails another way (offline, the API down) is returned as a
 * note to print, never as a diagnostic: the agent is not wrong because the network is.
 */
export async function diagnoseVoices(options: {
  uses: readonly VoiceUse[];
  env: Env;
  agentId: string;
  agentSource: string;
  find?: typeof findVoice;
}): Promise<{ diagnostics: AuthoringDiagnostic[]; notes: string[] }> {
  const api = voiceApi(options.env);
  const byVoice = new Map<number, string[]>();
  for (const use of options.uses) {
    const tts = use.tts as TtsDescriptor | undefined;
    if (tts?.provider !== "kugelaudio" || typeof tts.options?.voice !== "number") continue;
    byVoice.set(tts.options.voice, [...(byVoice.get(tts.options.voice) ?? []), use.where]);
  }
  if (!api || byVoice.size === 0) return { diagnostics: [], notes: [] };

  const find = options.find ?? findVoice;
  const diagnostics: AuthoringDiagnostic[] = [];
  const notes: string[] = [];
  for (const [voice, wheres] of byVoice) {
    let found: Voice | null;
    try {
      found = await find(api, voice);
    } catch (error) {
      notes.push(`Voice ${voice} not checked: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (found) continue;
    const where = wheres.map((path) => (path === "" ? "the agent" : `skill ${path}`)).join(", ");
    diagnostics.push({
      code: AUTHORING_DIAGNOSTIC_CODES.voiceNotFound,
      severity: "error",
      message: `kugelaudio.tts({ voice: ${voice} }) (${where}) names a voice KugelAudio does not have for this project, so every reply would be silent.`,
      location: { agentId: options.agentId, source: options.agentSource },
      fix: 'Run `npx curb voices --language <code>` and set one of the ids it lists, or remove `voice` to use the default voice of `language`.',
    });
  }
  return { diagnostics, notes };
}
