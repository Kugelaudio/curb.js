import { describe, expect, it, vi } from "vitest";
import { Agent, AgentSiteRuntime, Skill, Skills, type AgentRoute } from "./index.js";
import { AgentAuthoringError } from "./authoring.js";
import { anthropic, azure, deepgram, kugelaudio, type TtsDescriptor } from "./providers.js";
import { agentAppElement } from "./routing.js";
import { sameDescriptor, SessionSettings } from "./session-settings.js";

const routes: AgentRoute[] = [
  { path: "/claims", Component: () => <>Claims.</> },
  { path: "/billing", Component: () => <>Billing.</> },
];

/** An agent whose props are read from `props` at every render, so a test can re-render
 * it with other values the way a component reading state would. */
function agentWith(props: { agentTts?: TtsDescriptor; claimsTts?: TtsDescriptor; llmModel?: string }) {
  function App() {
    return (
      <Agent
        llm={props.llmModel ? anthropic(props.llmModel) : undefined}
        tts={props.agentTts}
      >
        <Skills>
          {/* Factories run on every render: equal values are new objects each time. */}
          <Skill path="/claims" description="Claims." tts={props.claimsTts} stt={deepgram.stt({ language: "de" })}>
            Claims
          </Skill>
          <Skill path="/billing" description="Billing.">Billing</Skill>
        </Skills>
      </Agent>
    );
  }
  return new AgentSiteRuntime(({ path, loadedPaths }) => agentAppElement(App, { path, loadedPaths, routes }));
}

describe("session settings from the rendered tree", () => {
  it("defaults to today's providers when the tree sets none", () => {
    const runtime = agentWith({});
    expect(runtime.settings.current()).toStrictEqual({
      llm: kugelaudio.llm(),
      stt: kugelaudio.stt(),
      tts: kugelaudio.tts(),
    });
  });

  it("reads the Agent's props", () => {
    const runtime = agentWith({ agentTts: kugelaudio.tts({ voice: 42 }), llmModel: "claude-sonnet-5" });
    expect(runtime.settings.current()).toMatchObject({
      llm: anthropic("claude-sonnet-5"),
      tts: kugelaudio.tts({ voice: 42 }),
    });
  });

  it("lets the ACTIVE skill's prop override the agent's, per slot, and only while it is active", async () => {
    const runtime = agentWith({
      agentTts: kugelaudio.tts({ voice: 42 }),
      claimsTts: kugelaudio.tts({ voice: 17 }),
      llmModel: "claude-sonnet-5",
    });
    // Not active yet: the link being rendered does not apply.
    expect(runtime.settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 42 }));

    await runtime.callTool("read_skill", { skill: "/claims" });
    expect(runtime.settings.current()).toStrictEqual({
      // The skill sets no llm: the agent's stays.
      llm: anthropic("claude-sonnet-5"),
      stt: deepgram.stt({ language: "de" }),
      tts: kugelaudio.tts({ voice: 17 }),
    });

    // A skill with no props of its own: the agent's apply again.
    await runtime.callTool("read_skill", { skill: "/billing" });
    expect(runtime.settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 42 }));
    expect(runtime.settings.current().stt).toStrictEqual(kugelaudio.stt());
  });

  it("does not notify on a re-render whose props are structurally unchanged", () => {
    const runtime = agentWith({ agentTts: kugelaudio.tts({ voice: 42 }) });
    const listener = vi.fn();
    runtime.settings.subscribe(listener);
    const before = runtime.settings.current();

    runtime.refreshExternal();
    runtime.refreshExternal();

    expect(listener).not.toHaveBeenCalled();
    expect(runtime.settings.current()).toBe(before);
  });

  it("notifies once, naming the slot, when a prop really changes", () => {
    const props: { agentTts?: TtsDescriptor } = { agentTts: kugelaudio.tts({ voice: 42 }) };
    const runtime = agentWith(props);
    const listener = vi.fn();
    runtime.settings.subscribe(listener);

    props.agentTts = kugelaudio.tts({ voice: 7 });
    runtime.refreshExternal();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ tts: kugelaudio.tts({ voice: 7 }) }),
      ["tts"],
    );
  });

  it("refuses a value of the wrong kind with an authoring error", () => {
    expect(() =>
      agentWith({ agentTts: azure.stt() as unknown as TtsDescriptor }),
    ).toThrow(AgentAuthoringError);
    // The fix's example names no voice: the voice follows the language.
    expect(() =>
      agentWith({ agentTts: azure.stt() as unknown as TtsDescriptor }),
    ).toThrow('e.g. kugelaudio.tts({ language: "en" }).');
  });
});

describe("SessionSettings", () => {
  it("puts an outside change above the props, until the next change of the same path", () => {
    const settings = new SessionSettings();
    settings.setAdjustable({ host: ["tts.voice"] });
    settings.setProps({ tts: kugelaudio.tts({ voice: 42 }) });
    expect(settings.update("host", { tts: { voice: 9 } })).toMatchObject({ tts: { provider: "kugelaudio", voice: 9 } });
    expect(settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 9 }));
    // A prop change underneath keeps the override; the options it does not set follow the props.
    expect(settings.setProps({ tts: kugelaudio.tts({ voice: 43, language: "de" }) })).toEqual(["tts"]);
    expect(settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 9, language: "de" }));
    // The next change of the same path replaces it; a numeric string is a KugelAudio voice id.
    settings.update("host", { tts: { voice: "17" } });
    expect(settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 17, language: "de" }));
  });

  it("stops notifying after unsubscribe", () => {
    const settings = new SessionSettings();
    const listener = vi.fn();
    const unsubscribe = settings.subscribe(listener);
    settings.setProps({ stt: deepgram.stt() });
    unsubscribe();
    settings.setProps({ stt: azure.stt() });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("sameDescriptor", () => {
  it("compares structurally, ignoring key order", () => {
    expect(sameDescriptor(kugelaudio.tts({ voice: 1, language: "de" }), { kind: "tts", provider: "kugelaudio", options: { language: "de", voice: 1 } })).toBe(true);
    expect(sameDescriptor(kugelaudio.tts({ voice: 1 }), kugelaudio.tts({ voice: 2 }))).toBe(false);
    expect(sameDescriptor(kugelaudio.tts({ dictionaryIds: [1, 2] }), kugelaudio.tts({ dictionaryIds: [2, 1] }))).toBe(false);
    expect(sameDescriptor(kugelaudio.tts(), kugelaudio.tts({ voice: 1072 }))).toBe(false);
  });
});
