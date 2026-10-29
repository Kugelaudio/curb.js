import { describe, expect, it } from "vitest";
import { AUTHORING_DIAGNOSTIC_CODES, type AuthoringDiagnostic } from "./authoring.js";
import { diagnoseAgentAuthoring } from "./authoring-diagnostics.js";
import { Agent, Skill, Skills } from "./components.js";
import { defineAgent } from "./config.js";
import {
  azure,
  cartesia,
  deepgram,
  elevenlabs,
  kugelaudio,
  openai,
  type ProviderProps,
  type TtsDescriptor,
} from "./providers.js";
import type { AgentRoute } from "./routing.js";

/**
 * AGENT_VOICE_LANGUAGE_MISMATCH through the whole analyzer (`curb check`), so the agent is
 * rendered and its providers are read the way a call reads them. Messages are written out by
 * hand: they are what a coding agent acts on.
 */

const routes: AgentRoute[] = [
  { path: "/claims", Component: () => <>Claims.</>, meta: { title: "Claims", description: "Claims." } },
  { path: "/billing", Component: () => <>Billing.</>, meta: { title: "Billing", description: "Billing." } },
];

/** The findings of `code` for an agent with these speech props, and these on its /claims link. */
function findings(
  agentProps: ProviderProps,
  claimsProps: ProviderProps = {},
  code: string = AUTHORING_DIAGNOSTIC_CODES.voiceLanguageMismatch,
): AuthoringDiagnostic[] {
  function App() {
    return (
      <Agent stt={agentProps.stt} tts={agentProps.tts}>
        <Skills>
          <Skill path="/claims" description="Claims." stt={claimsProps.stt} tts={claimsProps.tts}>
            Claims
          </Skill>
          <Skill path="/billing" description="Billing.">Billing</Skill>
        </Skills>
      </Agent>
    );
  }
  return diagnoseAgentAuthoring({ id: "agent", definition: defineAgent({ app: App }), routes }).filter(
    (diagnostic) => diagnostic.code === code,
  );
}

describe("AGENT_VOICE_LANGUAGE_MISMATCH", () => {
  it("warns when the agent listens in one language and its voice reads text with the default en", () => {
    // Every skill speaks as the agent does, so the agent level is reported once.
    expect(findings({ stt: kugelaudio.stt({ language: "de" }) })).toEqual([
      {
        code: "AGENT_VOICE_LANGUAGE_MISMATCH",
        severity: "warning",
        message:
          "The agent listens in de but its voice reads text with en rules, the default of kugelaudio.tts() " +
          "without a language, so it reads the dates, numbers and amounts in its replies as en.",
        location: { agentId: "agent", source: "src/agent/agent.tsx", component: "Agent" },
        fix: 'Give the voice the language the agent listens in: tts={kugelaudio.tts({ language: "de" })} on <Agent>.',
      },
    ]);
  });

  it("names a language the voice sets, and keeps the voice's other options in the fix", () => {
    const [finding, ...rest] = findings({
      stt: azure.stt({ language: "de-DE" }),
      tts: kugelaudio.tts({ voice: 42, language: "en", dictionaryIds: [1, 2], projectId: 9 }),
    });
    expect(rest).toEqual([]);
    expect(finding?.message).toBe(
      "The agent listens in de but its voice reads text with en rules, so it reads the dates, numbers and amounts in its replies as en.",
    );
    expect(finding?.fix).toBe(
      "Give the voice the language the agent listens in: " +
        'tts={kugelaudio.tts({ voice: 42, language: "de", dictionaryIds: [1, 2], projectId: 9 })} on <Agent>.',
    );
    // The provider in use, counting its own default language.
    expect(findings({ stt: deepgram.stt({ language: "fr" }), tts: cartesia.tts({ voice: "c" }) })[0]?.fix).toBe(
      'Give the voice the language the agent listens in: tts={cartesia.tts({ voice: "c", language: "fr" })} on <Agent>.',
    );
  });

  it("stays quiet when the languages agree, the STT lists several or sets none, or the TTS takes none", () => {
    const quiet: ProviderProps[] = [
      { stt: kugelaudio.stt({ language: "de" }), tts: kugelaudio.tts({ language: "de" }) },
      { stt: azure.stt({ language: "de-DE" }), tts: kugelaudio.tts({ language: "de" }) },
      { stt: azure.stt({ language: "en" }) },
      // Several languages to detect among: no single voice language is wrong.
      { stt: kugelaudio.stt({ language: "de,en" }) },
      { stt: azure.stt({ language: "de, fr" }), tts: kugelaudio.tts({ language: "fr" }) },
      // No language: the recognizer's own default or detection.
      { stt: kugelaudio.stt() },
      {},
      // A voice that takes no language reads the text as it comes.
      { stt: kugelaudio.stt({ language: "de" }), tts: elevenlabs.tts() },
      { stt: kugelaudio.stt({ language: "de" }), tts: openai.tts({ voice: "nova" }) },
    ];
    for (const props of quiet) expect(findings(props)).toEqual([]);
  });

  it("checks the speech an active skill switches to, and puts the fix on its link", () => {
    // An English agent whose /claims skill listens in German but keeps the English voice.
    expect(
      findings(
        { stt: azure.stt({ language: "en" }), tts: kugelaudio.tts({ language: "en" }) },
        { stt: kugelaudio.stt({ language: "de" }) },
      ),
    ).toEqual([
      {
        code: "AGENT_VOICE_LANGUAGE_MISMATCH",
        severity: "warning",
        message:
          'While skill "/claims" is active, the agent listens in de but its voice reads text with en rules, ' +
          "so it reads the dates, numbers and amounts in its replies as en.",
        location: { agentId: "agent", skillPath: "/claims", component: 'Skill path="/claims"' },
        fix:
          'Give the voice the language the agent listens in: tts={kugelaudio.tts({ language: "de" })} ' +
          'on the <Skill path="/claims"> link.',
      },
    ]);
    // A skill that gives the voice its language is fine; the agent level still is not.
    const agentOnly = findings({ stt: azure.stt({ language: "de" }) }, { tts: kugelaudio.tts({ language: "de" }) });
    expect(agentOnly.map((finding) => finding.location)).toEqual([
      { agentId: "agent", source: "src/agent/agent.tsx", component: "Agent" },
    ]);
  });

  it("reports a link's provider prop that is no descriptor instead of failing the check", () => {
    // /billing links back to /claims with a bogus tts. Only that link sets one, and it renders
    // only once /billing is loaded, so no render the analyzer ran made /claims active with it.
    function Billing() {
      return (
        <Skill path="/claims" tts={"bogus" as unknown as TtsDescriptor}>
          Back to claims
        </Skill>
      );
    }
    const linked: AgentRoute[] = [routes[0]!, { ...routes[1]!, Component: Billing }];
    function App() {
      return (
        <Agent>
          <Skills>
            <Skill path="/claims" description="Claims.">Claims</Skill>
            <Skill path="/billing" description="Billing.">Billing</Skill>
          </Skills>
        </Agent>
      );
    }
    const diagnostics = diagnoseAgentAuthoring({ id: "agent", definition: defineAgent({ app: App }), routes: linked });
    expect(diagnostics.filter((diagnostic) => diagnostic.code === AUTHORING_DIAGNOSTIC_CODES.invalidProp)).toEqual([
      expect.objectContaining({
        severity: "error",
        message: '<Skill path="/claims"> got tts="bogus", which is not a tts provider.',
        location: { agentId: "agent", skillPath: "/claims", component: 'Skill path="/claims"' },
      }),
    ]);
  });
});
