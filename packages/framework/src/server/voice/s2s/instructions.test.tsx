import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgentStore } from "../../../agent-state.js";
import { Agent, GlobalTools, Skill, Skills, SystemPrompt, Tool } from "../../../components.js";
import { openai, type S2sDescriptor } from "../../../providers.js";
import { agentAppElement, type AgentRoute } from "../../../routing.js";
import { AgentSiteRuntime } from "../../../runtime.js";
import { voiceInstructions } from "./instructions.js";

/**
 * What a speech-to-speech model is told before the call's first turn: every skill and tool the
 * back office has, a skill linked only later included, in the agent's language.
 */

const useCaller = createAgentStore<{ verified: boolean }>("s2s-instructions-caller", () => ({ verified: false }));

const LONG = `Look up an order. ${"It reads the order's whole history. ".repeat(8)}`;

function Verify() {
  return (
    <>
      <Tool name="verify_caller" description="Check the caller's customer number." schema={z.object({ number: z.string() })} onSubmit={() => ({ ok: true })} />
      <Skills>
        <Skill path="/opening-hours" description="When the branches are open.">
          Opening hours
        </Skill>
      </Skills>
    </>
  );
}
function ChangeAddress() {
  return <Tool name="change_address" description={LONG} schema={z.object({ street: z.string() })} onSubmit={() => ({ ok: true })} />;
}
function OpeningHours() {
  return <>Monday to Friday, 9 to 5.</>;
}
const routes: AgentRoute[] = [
  { path: "/verify", Component: Verify, meta: { title: "Verify the caller" } },
  { path: "/change-address", Component: ChangeAddress, meta: { title: "Change the address", description: "A verified caller's new address." } },
  { path: "/opening-hours", Component: OpeningHours },
];

function App({ s2s }: { s2s: S2sDescriptor }) {
  const verified = useCaller((state) => state.verified);
  return (
    <Agent s2s={s2s}>
      <SystemPrompt>You answer the phone at a bank.</SystemPrompt>
      <Skills>
        {verified ? <Skill path="/change-address">Change the address</Skill> : <Skill path="/verify">Verify the caller</Skill>}
      </Skills>
      <GlobalTools>
        <Tool name="request_callback" description="Have an adviser call back." schema={z.object({ phone: z.string() })} onSubmit={() => ({ ok: true })} />
      </GlobalTools>
    </Agent>
  );
}

/** The agent as a host builds it: the routes' paths and `meta` as its skills. Not the
 * opening-hours skill, which only `/verify` links to. */
function runtimeOf(s2s: S2sDescriptor) {
  const Site = () => <App s2s={s2s} />;
  const runtime = new AgentSiteRuntime(({ path, loadedPaths }) => agentAppElement(Site, { path, loadedPaths, routes }), {
    skills: routes.slice(0, 2).map((route) => ({ path: route.path, ...route.meta })),
  });
  runtime.setEndCallRequest(() => {});
  return runtime;
}

describe("the instructions of <Agent s2s>", () => {
  it("list every skill with its tools before any opens: one shown only later, one only a skill links to", () => {
    const runtime = runtimeOf(openai.live());
    expect(runtime.skillCatalog()).toEqual({
      tools: [{ name: "request_callback", description: "Have an adviser call back." }],
      skills: [
        { path: "/verify", label: "Verify the caller", tools: [{ name: "verify_caller", description: "Check the caller's customer number." }] },
        {
          path: "/change-address",
          label: "Change the address",
          description: "A verified caller's new address.",
          tools: [{ name: "change_address", description: LONG }],
        },
        { path: "/opening-hours", label: "Opening hours", description: "When the branches are open.", tools: [] },
      ],
    });
  });

  it("leave the conversation as it was: no skill loaded, no context event", () => {
    const runtime = runtimeOf(openai.live());
    const before = runtime.snapshot();
    voiceInstructions(runtime);
    const after = runtime.snapshot();
    expect(after.context.loadedSkills).toEqual([]);
    expect(after.events).toEqual(before.events);
    expect(after.agentContext).toEqual(before.agentContext);
  });

  it("put the hand-over list right under its title: answers first, tools by name under their skill", () => {
    const instructions = voiceInstructions(runtimeOf(openai.live()));
    const list = instructions.slice(instructions.indexOf("The back office does this:\n"));
    expect(list.split("\n")).toEqual([
      "The back office does this:",
      "- The caller's answer to a question the back office asked, even a short yes or no, a name, a number or a date: hand it over, the back office is waiting for it.",
      "- Ending the call, when the caller is finished or says goodbye.",
      "- request_callback: Have an adviser call back.",
      "- Verify the caller",
      "  - verify_caller: Check the caller's customer number.",
      "- Change the address: A verified caller's new address.",
      expect.stringMatching(/^ {2}- change_address: Look up an order\. .{100,}…$/),
      "- Opening hours: When the branches are open.",
    ]);
    expect(instructions.startsWith("You answer the phone at a bank.\n\n")).toBe(true);
    // The framework's own tools are not work to hand over.
    expect(instructions).not.toMatch(/read_skill|end_call/);
    // No language named: nothing tells the model which one to speak.
    expect(instructions).not.toContain("Speak English");
  });

  it("are in the call's language throughout, and say to speak it", () => {
    const instructions = voiceInstructions(runtimeOf(openai.live({ language: "de-DE" })));
    expect(instructions).toContain("Sprich mit dem Anrufer Deutsch. Hinter dir arbeitet ein Backoffice:");
    expect(instructions).toContain("Das Backoffice übernimmt:\n- Die Antwort des Anrufers auf eine Frage des Backoffice");
    // Curb's part, up to the agent's own tools, which are written as the agent wrote them.
    const curbs = instructions.slice(instructions.indexOf("\n\n"), instructions.indexOf("- request_callback"));
    expect(curbs).not.toMatch(/back office|hand over|caller/i);
    expect(runtimeOf(openai.live({ language: "de-DE" })).settings.language()).toBe("de");
  });

  it("stay English for a language the framework has no wording for, and say which one to speak", () => {
    const instructions = voiceInstructions(runtimeOf(openai.realtime({ language: "ja" })));
    expect(instructions).toContain("Speak Japanese with the caller. A back office works behind you:");
    expect(instructions).toContain("The back office does this:");
  });
});
