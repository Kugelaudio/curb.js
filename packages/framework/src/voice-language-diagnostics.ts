/**
 * AGENT_VOICE_LANGUAGE_MISMATCH: an agent that listens in one language and speaks with the
 * rules of another.
 *
 * The TTS `language` decides how the voice reads text (dates, numbers, amounts) and, for a
 * `kugelaudio.tts()` without `voice`, which voice reads it; unset, it is English. An agent
 * told to listen in German (`stt={kugelaudio.stt({ language: "de" })}`) that keeps a bare
 * `kugelaudio.tts()` answers in German read by English rules, and nothing fails until someone
 * listens to a call.
 *
 * Checked for every speech setup a call can run on: the agent's own (`<Agent stt tts>` over
 * the framework defaults) and each skill whose `<Skill>` link overrides a slot while it is the
 * active skill. The props are read the way the runtime reads them (`providerPropsFromTree`).
 */

import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES, type AuthoringDiagnostic } from "./authoring.js";
import { DEFAULT_VOICE_LANGUAGE, type SttDescriptor, type TtsDescriptor } from "./providers.js";
import { defaultProviderSettings, providerPropsFromTree, sameDescriptor } from "./session-settings.js";
import type { SemanticNode } from "./types.js";

/** TTS providers whose descriptor takes a `language`. The others read text as it comes. */
const TTS_WITH_LANGUAGE = new Set<TtsDescriptor["provider"]>(["kugelaudio", "cartesia"]);

type Speech = { stt: SttDescriptor; tts: TtsDescriptor };

/**
 * One warning per speech setup whose languages disagree. A `<Skill>` link whose provider prop
 * is no descriptor at all is reported as the runtime would refuse it once that skill is active
 * (`AGENT_INVALID_AUTHORING_PROP`), never thrown: the check goes on with the other setups.
 */
export function diagnoseVoiceLanguage(options: {
  agentId: string;
  /** The agent rendered with every skill loaded. */
  tree: SemanticNode;
  /** Every skill path; each is checked as the active skill. */
  skillPaths: readonly string[];
  /** The project-relative file `<Agent>` is written in. */
  agentSource: string;
}): AuthoringDiagnostic[] {
  const { agentId, tree, skillPaths, agentSource } = options;
  const diagnostics: AuthoringDiagnostic[] = [];
  /** The speech a call runs on while `path` is the active skill (null: no skill), or undefined
   * when a prop is refused (its diagnostic is pushed). */
  const speechAt = (path: string | null): Speech | undefined => {
    try {
      const props = providerPropsFromTree(tree, path ?? "");
      const defaults = defaultProviderSettings();
      return { stt: props.stt ?? defaults.stt, tts: props.tts ?? defaults.tts };
    } catch (error) {
      if (!(error instanceof AgentAuthoringError)) throw error;
      const own = error.diagnostic;
      diagnostics.push({
        ...own,
        location: { agentId, ...(path === null ? {} : { skillPath: path }), ...own.location },
      });
      return undefined;
    }
  };

  const atAgent = speechAt(null);
  const check = (path: string | null, speech: Speech) => {
    const finding = mismatch(path, speech);
    if (!finding) return;
    diagnostics.push({
      code: AUTHORING_DIAGNOSTIC_CODES.voiceLanguageMismatch,
      severity: "warning",
      message: finding.message,
      location:
        path === null
          ? { agentId, source: agentSource, component: "Agent" }
          : { agentId, skillPath: path, component: `Skill path=${JSON.stringify(path)}` },
      fix:
        `Give the voice the language the agent listens in: tts={${finding.tts}} ` +
        (path === null ? "on <Agent>." : `on the <Skill path=${JSON.stringify(path)}> link.`),
    });
  };
  if (atAgent) check(null, atAgent);
  for (const path of skillPaths) {
    const speech = speechAt(path);
    // A skill whose link sets no speech provider of its own speaks as the agent does.
    if (speech && !(atAgent && sameDescriptor(speech, atAgent))) check(path, speech);
  }
  return diagnostics;
}

/** The message and the corrected TTS source, or undefined when the languages agree. */
function mismatch(path: string | null, speech: Speech): { message: string; tts: string } | undefined {
  const listens = listeningLanguage(speech.stt);
  const reads = readingLanguage(speech.tts);
  if (listens === undefined || reads === undefined || listens === reads.language) return undefined;
  const factory = `${speech.tts.provider}.tts`;
  const who = path === null ? "The agent" : `While skill ${JSON.stringify(path)} is active, the agent`;
  return {
    message:
      `${who} listens in ${listens} but its voice reads text with ${reads.language} rules` +
      (reads.set ? "" : `, the default of ${factory}() without a language`) +
      `, so it reads the dates, numbers and amounts in its replies as ${reads.language}.`,
    tts: `${factory}(${optionsSource({ ...speech.tts.options, language: listens })})`,
  };
}

/**
 * The one language an STT listens in. Undefined when it sets none or lists several to detect
 * among ("de,en"): no single voice language is then the wrong one.
 */
function listeningLanguage(stt: SttDescriptor): string | undefined {
  const language = (stt.options as { language?: string }).language;
  const codes = (language ?? "").split(",").map((code) => code.trim()).filter(Boolean);
  return codes.length === 1 ? baseLanguage(codes[0]!) : undefined;
}

/**
 * The language a TTS reads text with, and whether its descriptor sets it. Undefined for a
 * provider that takes no language, and for an empty one, which names no rules to compare.
 */
function readingLanguage(tts: TtsDescriptor): { language: string; set: boolean } | undefined {
  if (!TTS_WITH_LANGUAGE.has(tts.provider)) return undefined;
  const language = (tts.options as { language?: string }).language;
  const base = baseLanguage((language ?? DEFAULT_VOICE_LANGUAGE).split(",")[0]!);
  return base === "" ? undefined : { language: base, set: language !== undefined };
}

/** "de" of "de", "de-DE", "de_AT" or "DE". */
function baseLanguage(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0]!;
}

/** Factory options as source, e.g. `{ voice: 42, language: "de" }`. */
function optionsSource(options: object): string {
  const value = (item: unknown): string =>
    Array.isArray(item) ? `[${item.map(value).join(", ")}]` : JSON.stringify(item);
  const entries = Object.entries(options).filter(([, item]) => item !== undefined);
  return `{ ${entries.map(([key, item]) => `${key}: ${value(item)}`).join(", ")} }`;
}
