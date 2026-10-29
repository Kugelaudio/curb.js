import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentChatMessage } from "../llm/types.js";
import type { CompiledContext, ToolDefinition } from "../types.js";
import {
  agentViewSnapshot,
  beforePicture,
  callerMessageCount,
  newSince,
  SkillLiveStatus,
  skillPage,
  skillPageStatus,
  type SkillPageStatus,
} from "./agent-view.js";

function tool(name: string, scope: ToolDefinition["scope"] = "page", fields: string[] = []): ToolDefinition {
  return {
    id: `${scope}:${name}`,
    name,
    description: `Does ${name}.`,
    scope,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(fields.map((field) => [field, { type: "string", description: `The ${field}.` }])),
      required: fields.slice(0, 1),
    },
  };
}

function context(skills: Array<[string, string]>, tools: ToolDefinition[]): CompiledContext {
  return {
    // No skill loaded is the agent level: path "".
    path: skills.at(-1)?.[0] ?? "",
    title: skills.at(-1)?.[1] ?? "",
    loadedSkills: skills.map(([path, title]) => ({ path, title, characterCount: 100 })),
    instructions: [],
    content: [],
    errors: [],
    toolErrors: {},
    links: [],
    blocks: [],
    tools,
    diagnostics: [],
  };
}

const atStart = context([], [tool("read_skill", "runtime"), tool("request_callback", "global")]);
const afterRead = context(
  [["/property-damage", "Property damage"]],
  [tool("read_skill", "runtime"), tool("request_callback", "global"), tool("report_damage")],
);

const caller = (content: string): AgentChatMessage => ({ role: "user", content });

describe("what changed in the agent's view", () => {
  it("names the skills the agent read and the tools it gained, never the framework's own tools", () => {
    const changes = newSince(agentViewSnapshot(atStart), afterRead);

    expect(changes.skills.map((skill) => skill.title)).toEqual(["Property damage"]);
    expect(changes.tools).toEqual(["report_damage"]);
    expect(changes.instructions).toBe(false);
    expect(agentViewSnapshot(atStart).tools).toEqual(["request_callback"]);
  });

  // A prompt written with `{state}` in it reads differently once that state changes.
  it("says when the instructions read differently than at the caller's last message", () => {
    const before = agentViewSnapshot({ ...atStart, systemPrompt: "You help. Open tasks: none." });

    expect(newSince(before, { ...atStart, systemPrompt: "You help. Open tasks: milk." }).instructions).toBe(true);
    expect(newSince(before, { ...atStart, systemPrompt: "You help. Open tasks: none." }).instructions).toBe(false);
  });

  it("counts only what the caller said, not context events, framework input or tool results", () => {
    const messages: AgentChatMessage[] = [
      { role: "user", kind: "synthetic", content: "(The conversation has just started.)" },
      caller("I need to report property damage"),
      { role: "assistant", content: "" },
      { role: "user", kind: "context_event", content: "The user opened a skill." },
      caller("It was a burst pipe"),
    ];

    expect(callerMessageCount(messages)).toBe(2);
  });

  // The picture is what "new" is measured against. Retaking it on every context
  // frame would make everything the turn loads look old the moment it arrived.
  it("keeps the before picture through the turn and retakes it on the next message or conversation", () => {
    const sent = [caller("I need to report property damage")];
    const first = beforePicture(null, sent, atStart, "c1");

    expect(beforePicture(first, sent, afterRead, "c1")).toBe(first);

    const next = beforePicture(first, [...sent, caller("Thanks")], afterRead, "c1");
    expect(next.view.skills).toEqual(["/property-damage"]);

    const switched = beforePicture(first, sent, afterRead, "c2");
    expect(switched).not.toBe(first);
    expect(switched.view.tools).toContain("report_damage");
  });
});

describe("which compile a skill page shows", () => {
  // The insurance example: the conversation finished the claim procedure, so ITS
  // property-damage page has the intake tool; the preview's copy never ran the
  // procedure and still says intake is locked.
  const unlockedLive = context(
    [
      ["/claim-procedure", "Claim procedure"],
      ["/property-damage", "Property damage"],
    ],
    [tool("request_callback", "global"), tool("submit_property_damage_claim")],
  );
  unlockedLive.blocks = [{ type: "tool", name: "submit_property_damage_claim" }];
  const lockedCopy = context([["/property-damage", "Property damage"]], [tool("request_callback", "global")]);
  lockedCopy.blocks = [{ type: "text", text: "Claim intake is locked." }];

  it("shows the conversation's own page for the skill the agent is on, even when the copy differs", () => {
    const page = skillPage(unlockedLive, lockedCopy, "/property-damage", new Set());

    expect(page.context).toBe(unlockedLive);
    expect(page.showsLive).toBe(true);
    // Test runs go to the copy, where the unlocked tool does not exist.
    expect([...page.untryable]).toEqual(["submit_property_damage_claim"]);
  });

  it("shows the copy for other skills and once the viewer tried a tool on the agent's skill", () => {
    const otherSkill = { ...lockedCopy, path: "/member-portal", title: "Member portal" };

    expect(skillPage(unlockedLive, otherSkill, "/member-portal", new Set()).context).toBe(otherSkill);
    const tested = skillPage(unlockedLive, lockedCopy, "/property-damage", new Set(["/property-damage"]));
    expect(tested.context).toBe(lockedCopy);
    expect(tested.showsLive).toBe(false);
  });

  it("never claims a copy is what the model gets", () => {
    expect(skillPageStatus({ showsLive: true, current: true, inUse: true })).toBe("live");
    expect(skillPageStatus({ showsLive: false, current: true, inUse: true })).toBe("tested");
    expect(skillPageStatus({ showsLive: false, current: false, inUse: true })).toBe("earlier");
    expect(skillPageStatus({ showsLive: false, current: false, inUse: false })).toBe("unused");
  });
});

describe("a skill page's status", () => {
  const status = (value: SkillPageStatus, isNew = false, tried = false) =>
    renderToStaticMarkup(<SkillLiveStatus status={value} isNew={isNew} tried={tried} />);

  it("says what the page is", () => {
    expect(status("live")).toContain("In use right now: this is what the model gets.");
    expect(status("live", true)).toContain("after your last message");
    expect(status("tested")).toContain("this page shows your test runs, not what the model gets");
    expect(status("earlier")).toContain("In use from earlier. Shown as written");
    expect(status("unused")).toContain("Not in use right now");
  });

  // A test run that signs in on the preview's copy makes the page say "Signed in";
  // the page has to say that the agent in the conversation is not.
  it("says when test runs changed the preview and not the agent", () => {
    expect(status("unused")).not.toContain("test runs");
    expect(status("unused", false, true)).toContain(
      "Your test runs changed this preview, not the agent in the conversation.",
    );
    expect(status("live", false, true)).not.toContain("Your test runs");
  });
});

