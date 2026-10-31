import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentSession, type AgentLlmClient } from "./agent-session.js";
import { Agent, Instruction, Skill, Skills, SystemPrompt, Tool } from "./components.js";
import { createAgentStore } from "./agent-state.js";
import { serializeLlmInput } from "./llm/serialize-input.js";
import type { AgentRunRequest, AgentRunResponse, LlmMessage } from "./llm/types.js";
import { agentAppElement, type AgentRoute } from "./routing.js";
import { AgentSiteRuntime } from "./runtime.js";

/**
 * The page `docs/agent-guide/what-the-model-receives.md` shows real requests and states what
 * a skill takes with it when it unloads. This file is its proof: the agent below is the one
 * the page prints, and the request text in the page is compared with what this agent sends.
 */
const useClaim = createAgentStore<{ policy: string | null; verify: (policy: string) => void }>("claim", (set) => ({
  policy: null,
  verify: (policy) => set({ policy }),
}));

function ReportClaim() {
  const { policy, verify } = useClaim();
  const [attempts, setAttempts] = useState(0);
  return (
    <>
      <Instruction>Ask for the policy number.</Instruction>
      {policy ? `Verified policy: ${policy}.` : "No policy is verified."}
      {`Attempts so far: ${attempts}.`}
      <Tool
        name="verify_policy"
        description="Check the policy number."
        schema={z.object({ policy: z.string() })}
        onSubmit={({ policy: number }) => {
          verify(number);
          setAttempts(attempts + 1);
          return { ok: true, message: "Verified." };
        }}
      />
    </>
  );
}

function plainSkill(instruction: string, tool: string) {
  return function PlainSkill() {
    return (
      <>
        <Instruction>{instruction}</Instruction>
        <Tool name={tool} description={instruction} onSubmit={() => ({ ok: true })} />
      </>
    );
  };
}

const routes: AgentRoute[] = [
  { path: "/report-claim", Component: ReportClaim, meta: { title: "Report a claim", description: "Use when the caller wants to report damage." } },
  { path: "/claim-status", Component: plainSkill("Ask for the claim number.", "get_claim_status"), meta: { title: "Claim status", description: "Use when the caller asks about an open claim." } },
  { path: "/policy-questions", Component: plainSkill("Answer from the policy terms.", "read_policy_terms"), meta: { title: "Policy questions", description: "Use for questions about cover." } },
];

function App() {
  return (
    <Agent>
      <SystemPrompt>You answer the phone at an insurance company.</SystemPrompt>
      <Skills>
        {routes.map((route) => (
          <Skill key={route.path} path={route.path}>
            {route.meta?.title}
          </Skill>
        ))}
      </Skills>
    </Agent>
  );
}

/** A session on the agent above, whose model answers from `steps`, and every request it got. */
function insurer(steps: AgentRunResponse[], options: { maxLoadedSkills?: number; maxTranscriptMessages?: number } = {}) {
  const runtime = new AgentSiteRuntime(
    ({ path, loadedPaths }) => agentAppElement(App, { path, loadedPaths, routes }),
    { maxLoadedSkills: options.maxLoadedSkills ?? 2 },
  );
  const requests: AgentRunRequest[] = [];
  let step = 0;
  const llm: AgentLlmClient = async (request) => {
    requests.push(request);
    return steps[step++] ?? { text: "Okay.", toolCalls: [] };
  };
  const session = new AgentSession(runtime, llm, {
    ...(options.maxTranscriptMessages ? { maxTranscriptMessages: options.maxTranscriptMessages } : {}),
  });
  return { runtime, session, requests, script: steps };
}

function read(skill: string): AgentRunResponse {
  return { text: "", toolCalls: [{ id: `read-${skill}`, name: "read_skill", input: { skill } }] };
}

/** One message as the page prints it. */
function printed(message: LlmMessage): string {
  if (typeof message.content === "string") return `${message.role}: ${message.content}`;
  const parts = message.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "tool-call") return `call ${part.toolName}(${JSON.stringify(part.input)})`;
    return `result ${part.toolName}: ${JSON.stringify(part.output.value)}`;
  });
  return `${message.role}: ${parts.join("\n")}`;
}

function printedRequest(request: AgentRunRequest): string {
  const { system, messages, tools } = serializeLlmInput(request);
  return [
    "=== system ===",
    system,
    "=== tools ===",
    Object.keys(tools).join(", "),
    "=== messages ===",
    ...messages.map(printed),
  ].join("\n");
}

/** The request as it reads apart from today's date, which changes every minute. */
function dated(text: string): string {
  return text.replace(/^Today is .*$/m, "Today is Friday, 30 October 2026, 15:00 (UTC). The next days: …");
}

function guideBlock(name: string): string {
  const page = readFileSync(
    fileURLToPath(new URL("../docs/agent-guide/what-the-model-receives.md", import.meta.url)),
    "utf8",
  );
  const marker = `<!-- request: ${name} -->\n\`\`\`text\n`;
  const start = page.indexOf(marker);
  if (start === -1) throw new Error(`what-the-model-receives.md has no block "${name}"`);
  const from = start + marker.length;
  return page.slice(from, page.indexOf("\n```", from));
}

describe("what the model receives", () => {
  it("prints the first request and the one after read_skill exactly as the guide shows them", async () => {
    const { session, requests } = insurer([read("/report-claim"), { text: "What is your policy number?", toolCalls: [] }]);
    await session.runTurn("A pipe burst at home");

    expect(dated(printedRequest(requests[0]!))).toBe(guideBlock("first"));
    expect(dated(printedRequest(requests[1]!))).toBe(guideBlock("after-read-skill"));
  });

  it("keeps the current context out of the transcript: it is rebuilt for every request", async () => {
    const { session, requests } = insurer([read("/report-claim"), { text: "Your policy number?", toolCalls: [] }]);
    await session.runTurn("Hello");
    await session.runTurn("4711");

    const second = serializeLlmInput(requests[2]!).messages;
    const snapshots = second.filter((message) => String(message.content).startsWith("<current_context"));
    expect(snapshots).toHaveLength(1);
    expect(second.at(-1)).toBe(snapshots[0]);
  });
});

describe("what state does to the request", () => {
  let values = "";

  function ReportClaimWithSwitch() {
    const [verified, setVerified] = useState(false);
    values = `verified = ${verified}`;
    if (!verified) return <>
      <Instruction>Ask for the policy number.</Instruction>
      <Tool
        name="verify_policy"
        description="Check the policy number."
        schema={z.object({ policy: z.string() })}
        onSubmit={() => { setVerified(true); return { ok: true }; }}
      />
    </>;
    return <>
      <Instruction>Ask what happened.</Instruction>
      <Tool
        name="open_claim"
        description="Open the claim."
        schema={z.object({ what: z.string() })}
        onSubmit={() => ({ ok: true, message: "Claim opened." })}
      />
    </>;
  }

  /** The lines of a request's `<current_context>` that belong to the skill, under one heading. */
  function state(heading: string, request: AgentRunRequest, seen: string): string {
    const context = String(serializeLlmInput(request).messages.at(-1)?.content);
    const lines = context.split("\n").filter((line) => /^(instruction|content):|\[page\]$/.test(line));
    return [`=== ${heading}`, `state: ${seen}`, ...lines].join("\n");
  }

  it("prints what each step of a call leaves in the request exactly as the guide shows it", async () => {
    const steps: AgentRunResponse[] = [
      read("/report-claim"),
      { text: "What is your policy number?", toolCalls: [] },
      { text: "", toolCalls: [{ id: "verify", name: "verify_policy", input: { policy: "4711" } }] },
      { text: "Thanks. What happened?", toolCalls: [] },
    ];
    const switchRoutes: AgentRoute[] = [
      { path: "/report-claim", Component: ReportClaimWithSwitch, meta: { title: "Report a claim", description: "Use when the caller wants to report damage." } },
    ];
    const SwitchApp = () => (
      <Agent>
        <SystemPrompt>You answer the phone at an insurance company.</SystemPrompt>
        <Skills>
          <Skill path="/report-claim">Report a claim</Skill>
        </Skills>
      </Agent>
    );
    const runtime = new AgentSiteRuntime(({ path, loadedPaths }) =>
      agentAppElement(SwitchApp, { path, loadedPaths, routes: switchRoutes }),
    );
    const requests: AgentRunRequest[] = [];
    const seen: string[] = [];
    const session = new AgentSession(runtime, async (request) => {
      requests.push(request);
      seen.push(values);
      return steps[requests.length - 1]!;
    });

    await session.runTurn("A pipe burst at home");
    await session.runTurn("It's 4711");

    expect(requests).toHaveLength(4);
    expect(
      [
        state("A pipe burst at home: read_skill", requests[1]!, seen[1]!),
        state("It's 4711: verify_policy", requests[3]!, seen[3]!),
      ].join("\n"),
    ).toBe(guideBlock("states"));
    // A tool that is not rendered is not in the request.
    const tools = requests.map((request) => request.tools.map((tool) => tool.name));
    expect(tools[1]).toContain("verify_policy");
    expect(tools[1]).not.toContain("open_claim");
    expect(tools[3]).toContain("open_claim");
    expect(tools[3]).not.toContain("verify_policy");
  });
});

describe("what a skill takes with it when it unloads", () => {
  /** /report-claim read and used, then two more skills, which evicts it past `maxLoadedSkills: 2`. */
  async function evictClaim() {
    const app = insurer([
      read("/report-claim"),
      { text: "", toolCalls: [{ id: "verify-1", name: "verify_policy", input: { policy: "4711" } }] },
      { text: "Policy 4711, got it.", toolCalls: [] },
      read("/claim-status"),
      read("/policy-questions"),
      { text: "Your claim is open.", toolCalls: [] },
    ]);
    await app.session.runTurn("It's 4711");
    await app.session.runTurn("What is my claim status, and does my policy cover it?");
    return app;
  }

  it("unloads its instructions and tools", async () => {
    const { runtime, requests } = await evictClaim();
    const last = requests.at(-1)!;

    expect(runtime.snapshot().context.loadedSkills.map((skill) => skill.path)).toEqual(["/claim-status", "/policy-questions"]);
    expect(last.tools.map((tool) => tool.name)).not.toContain("verify_policy");
    expect(last.stateSnapshot.join("\n")).not.toContain("Ask for the policy");
  });

  it("keeps its history: the calls, the results and the capped diff stay in the transcript", async () => {
    const { requests } = await evictClaim();
    const messages = serializeLlmInput(requests.at(-1)!).messages.map(printed).join("\n");

    expect(messages).toContain('call verify_policy({"policy":"4711"})');
    expect(messages).toContain("Policy 4711, got it.");
    // The evicted skill's instruction, as the read_skill result reported it.
    expect(messages).toContain("instruction: Ask for the policy number.");
  });

  it("refuses a call of an unloaded tool and tells the model", async () => {
    const { session, requests, script } = await evictClaim();
    const next = requests.length;
    script.push({ text: "", toolCalls: [{ id: "verify-2", name: "verify_policy", input: { policy: "4712" } }] });
    await session.runTurn("And policy 4712");

    const messages = serializeLlmInput(requests[next + 1]!).messages.map(printed).join("\n");
    expect(messages).toContain("Unknown tool");
  });

  it("loses the skill's useState but keeps its store, on the next read", async () => {
    const { runtime } = await evictClaim();
    await runtime.callTool("read_skill", { skill: "/report-claim" });
    const context = runtime.snapshot().stateSnapshot.join("\n");

    expect(context).toContain("Attempts so far: 0.");
    expect(context).toContain("Verified policy: 4711.");
  });

  it("has no context per skill: every skill reads the one transcript", async () => {
    const { requests } = await evictClaim();
    const messages = serializeLlmInput(requests.at(-1)!).messages.map(printed).join("\n");

    expect(messages).toContain("user: It's 4711");
    expect(messages).toContain("user: What is my claim status, and does my policy cover it?");
  });

  it("drops history by message count alone, whichever skill it came from", async () => {
    const { session, requests } = insurer(
      [read("/report-claim"), { text: "Okay.", toolCalls: [] }, { text: "Okay.", toolCalls: [] }],
      { maxTranscriptMessages: 3 },
    );
    await session.runTurn("first");
    await session.runTurn("second");
    await session.runTurn("third");
    const messages = serializeLlmInput(requests.at(-1)!).messages.map(printed).join("\n");

    expect(session.messages.some((message) => message.content === "first")).toBe(true);
    expect(messages).not.toContain("user: first");
    expect(messages).toContain("user: third");
  });
});
