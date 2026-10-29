import { llm, type voice } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import { Agent, AgentSiteRuntime, Skill, Skills, type AgentRoute } from "../../../index.js";
import { azure, deepgram, kugelaudio, type SttDescriptor, type TtsDescriptor } from "../../../providers.js";
import { agentAppElement } from "../../../routing.js";
import type { VoiceProviders } from "../providers.js";
import { CurbVoiceAgent } from "./curb-agent.js";
import { createProviderSwitch } from "./provider-swap.js";

/** A provider instance that remembers what it was built from and whether it was closed. */
type FakeProvider = { built: SttDescriptor | TtsDescriptor; close: ReturnType<typeof vi.fn> };
const fake = (built: SttDescriptor | TtsDescriptor): FakeProvider => ({ built, close: vi.fn(async () => {}) });

/** The `AgentSession` stand-in: records every agent it is handed. */
function fakeSession() {
  const agents: voice.Agent[] = [];
  return { agents, updateAgent: vi.fn((agent: voice.Agent) => void agents.push(agent)) };
}

function setup(initialStt = azure.stt(), initialTts = kugelaudio.tts({ voice: 42 })) {
  const session = fakeSession();
  const initial = {
    stt: fake(initialStt),
    tts: fake(initialTts),
    descriptors: { stt: initialStt, tts: initialTts },
  } as unknown as VoiceProviders;
  const history = new llm.ChatContext();
  history.addMessage({ role: "user", content: "Hello, my roof leaks." });
  // The same factory shape the host uses: one turn runner, new providers per agent.
  const runTurn = vi.fn();
  const initialAgent = new CurbVoiceAgent({ instructions: "curb agent", runTurn, id: "curb_agent_0", chatCtx: history });
  const build = {
    stt: vi.fn(async (descriptor: SttDescriptor) => fake(descriptor) as never),
    tts: vi.fn(async (descriptor: TtsDescriptor) => fake(descriptor) as never),
  };
  const onError = vi.fn();
  const providerSwitch = createProviderSwitch({
    session,
    initial,
    initialAgent,
    createAgent: (options) =>
      new CurbVoiceAgent({ instructions: "curb agent", runTurn, ...options }),
    build,
    log: () => {},
    onError,
  });
  return { session, initial, build, onError, providerSwitch, runTurn };
}

describe("mid-call provider swap", () => {
  it("does nothing when the descriptors are structurally unchanged", async () => {
    const { session, build, providerSwitch } = setup();
    // Fresh objects with equal values: what every re-render produces.
    await providerSwitch.apply({ stt: azure.stt(), tts: kugelaudio.tts({ voice: 42 }) });
    await providerSwitch.apply({ stt: azure.stt(), tts: kugelaudio.tts({ voice: 42 }) });
    expect(build.stt).not.toHaveBeenCalled();
    expect(build.tts).not.toHaveBeenCalled();
    expect(session.updateAgent).not.toHaveBeenCalled();
  });

  it("hands LiveKit exactly one new agent with the new tts, keeping the stt and the chat context", async () => {
    const { session, initial, build, providerSwitch } = setup();
    await providerSwitch.apply({ stt: azure.stt(), tts: kugelaudio.tts({ voice: 17 }) });

    expect(build.stt).not.toHaveBeenCalled();
    expect(build.tts).toHaveBeenCalledExactlyOnceWith(kugelaudio.tts({ voice: 17 }));
    expect(session.updateAgent).toHaveBeenCalledTimes(1);
    const next = session.agents[0]!;
    expect(next).toBeInstanceOf(CurbVoiceAgent);
    expect((next.tts as unknown as FakeProvider).built).toStrictEqual(kugelaudio.tts({ voice: 17 }));
    expect(next.stt).toBe(initial.stt);
    // The conversation continues: the old agent's history is in the new one.
    expect(next.chatCtx.items.map((item) => ("textContent" in item ? item.textContent : null))).toEqual([
      "Hello, my roof leaks.",
    ]);
    expect(providerSwitch.current().descriptors.tts).toStrictEqual(kugelaudio.tts({ voice: 17 }));
  });

  it("closes what a swap replaced only once LiveKit has handed over", async () => {
    const { session, initial, providerSwitch } = setup();
    await providerSwitch.apply({ stt: azure.stt(), tts: kugelaudio.tts({ voice: 17 }) });
    const oldTts = initial.tts as unknown as FakeProvider;
    expect(oldTts.close).not.toHaveBeenCalled();

    providerSwitch.handedOver(session.agents[0]!.id);
    await Promise.resolve();
    expect(oldTts.close).toHaveBeenCalledTimes(1);
    expect((initial.stt as unknown as FakeProvider).close).not.toHaveBeenCalled();
  });

  it("keeps the current providers and reports when the new one cannot be built", async () => {
    const { session, build, onError, providerSwitch, initial } = setup();
    build.tts.mockRejectedValueOnce(new Error("needs KUGELAUDIO_API_KEY"));
    await providerSwitch.apply({ stt: azure.stt(), tts: kugelaudio.tts({ voice: 17 }) });
    expect(session.updateAgent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "needs KUGELAUDIO_API_KEY" }));
    expect(providerSwitch.current()).toBe(initial);
  });

  it("coalesces changes that land while a swap is building onto the latest settings", async () => {
    const { session, build, providerSwitch } = setup();
    void providerSwitch.apply({ stt: azure.stt(), tts: kugelaudio.tts({ voice: 1 }) });
    void providerSwitch.apply({ stt: azure.stt(), tts: kugelaudio.tts({ voice: 2 }) });
    await providerSwitch.apply({ stt: azure.stt(), tts: kugelaudio.tts({ voice: 2 }) });
    // Both queued steps read the latest wanted settings: one build, one handoff.
    expect(build.tts).toHaveBeenCalledExactlyOnceWith(kugelaudio.tts({ voice: 2 }));
    expect(session.updateAgent).toHaveBeenCalledTimes(1);
  });

  it("closes everything it holds when the call ends", async () => {
    const { session, initial, providerSwitch } = setup();
    await providerSwitch.apply({ stt: deepgram.stt(), tts: kugelaudio.tts({ voice: 42 }) });
    await providerSwitch.close();
    const next = session.agents[0]!;
    expect((next.stt as unknown as FakeProvider).close).toHaveBeenCalledTimes(1);
    expect((initial.tts as unknown as FakeProvider).close).toHaveBeenCalledTimes(1);
    // The replaced stt was never handed over, so it closes here instead.
    expect((initial.stt as unknown as FakeProvider).close).toHaveBeenCalledTimes(1);
  });
});

describe("provider swap driven by the rendered tree", () => {
  const routes: AgentRoute[] = [
    { path: "/claims", Component: () => <>Claims.</> },
  ];

  it("re-renders with an unchanged prop swap nothing; a changed prop or active skill swaps once each", async () => {
    const props = { voice: 42 };
    function App() {
      return (
        <Agent tts={kugelaudio.tts({ voice: props.voice })}>
          <Skills>
            <Skill path="/claims" description="Claims." tts={kugelaudio.tts({ voice: 17 })}>Claims</Skill>
          </Skills>
        </Agent>
      );
    }
    const runtime = new AgentSiteRuntime(({ path, loadedPaths }) => agentAppElement(App, { path, loadedPaths, routes }));
    const { session, providerSwitch } = setup(azure.stt(), kugelaudio.tts({ voice: 42 }));
    const applied: Array<Promise<void>> = [];
    runtime.settings.subscribe((settings) => applied.push(providerSwitch.apply(settings)));
    const settle = () => Promise.all(applied);

    runtime.refreshExternal();
    await settle();
    expect(session.updateAgent).not.toHaveBeenCalled();

    props.voice = 7;
    runtime.refreshExternal();
    await settle();
    expect(session.updateAgent).toHaveBeenCalledTimes(1);
    expect((session.agents[0]!.tts as unknown as FakeProvider).built).toStrictEqual(kugelaudio.tts({ voice: 7 }));

    await runtime.callTool("read_skill", { skill: "/claims" });
    await settle();
    expect(session.updateAgent).toHaveBeenCalledTimes(2);
    expect((session.agents[1]!.tts as unknown as FakeProvider).built).toStrictEqual(kugelaudio.tts({ voice: 17 }));
  });
});
