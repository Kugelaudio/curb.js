# Agents and skills

An agent is a React tree. `src/agent/agent.tsx` holds what is true for the whole call, and each
skill holds one area of work with its own instructions and tools. The model reads a skill only
when the call needs it, so a skill it has not read costs nothing and does nothing.

A skill is a whole area of work, such as reporting a claim. A single action, such as putting a
caller through, is a [tool](./tools.md).

## Your first agent

Replace `src/agent/agent.tsx`:

```tsx
// src/agent/agent.tsx
import { Agent, Skill, Skills, SystemPrompt, defineAgent } from "curb";
import { kugelaudio } from "curb/providers";

function App() {
  return (
    <Agent stt={kugelaudio.stt({ language: "en" })} tts={kugelaudio.tts({ language: "en" })}>
      <SystemPrompt>You answer the phone at an insurance company. Keep replies short.</SystemPrompt>
      <Skills>
        <Skill path="/report-claim" description="Use when the caller wants to report damage.">Report a claim</Skill>
      </Skills>
    </Agent>
  );
}

export const agent = defineAgent({ app: App, firstTurn: { say: () => "Hello, how can I help?" } });
```

Delete the `about-you` and `how-this-works` folders and `context/about-you.md`, then add the skill.
A folder under `src/agent/` is a skill.

```tsx
// src/agent/report-claim/skill.tsx
import { Instruction } from "curb";

export default function ReportClaim() {
  return <Instruction>Ask what happened and when.</Instruction>;
}
```

The preview reloads when you save. Say "A pipe burst at home" and watch the Context panel: the model
opens **Report a claim**, and the instruction joins its context.

## `agent.tsx`: the agent definition

`src/agent/agent.tsx` exports two things: the app component and `agent`, a
`defineAgent(...)` result. Hosts (preview, WebSocket server, voice bridge)
consume `agent`; you never write host code. It is also the **agent level**,
where every conversation starts: what the app renders inside `<Agent>` (the
system prompt, the `<Skills>` list, `<GlobalTools>`, MCP servers, and any text
or state of the agent's own) is in context from the first turn, with no skill
loaded. Each skill joins only once the model reads it.

```tsx
import { Agent, GlobalTools, Skill, Skills, SystemPrompt, Tool, defineAgent, z } from "curb";
import { azure, kugelaudio } from "curb/providers";

export function MyApp() {
  return (
    <Agent
      llm={kugelaudio.llm()}                               // optional; this is the default
      stt={azure.stt({ language: "en" })}                 // optional; default azure.stt()
      tts={kugelaudio.tts({ language: "en" })}             // optional; default "en"; the voice follows it (1072 en, 1887 de)
    >
      <SystemPrompt>
        You are a support agent. Use read_skill silently to load the topic you need, then answer plainly.
      </SystemPrompt>
      <Skills>
        <Skill
          path="/claim-procedure"
          description="Use FIRST whenever the user wants to file a new claim: the mandatory ordered workflow."
        >
          Claim procedure
        </Skill>
      </Skills>
      <GlobalTools>
        <Tool
          schema={z.object({ phone: z.string().min(1).describe("Customer phone number.") })}
          name="request_callback"
          description="Request a human advisor callback."
          success="Callback request was recorded."
          onSubmit={(input) => ({ ok: true, data: input })}
        />
      </GlobalTools>
    </Agent>
  );
}

export const agent = defineAgent({
  app: MyApp,
  maxLoadedSkills: 3,          // LRU window of loaded skills (default 3)
  maxSteps: 8,                 // LLM tool-call rounds per turn (default 8)
  timeZone: "Europe/Berlin",   // the date line in every request (default "UTC")
  maxTranscriptMessages: 60,   // transcript cap sent to the LLM (default 60)
  firstTurn: "agent",          // calls open with a greeting; { say } for exact words; "user" (default) waits
  goals: { callback: { tool: "request_callback" } },               // what counts as a successful call
  experiments: { tone: { variants: { warm: 1, brief: 1 } } },     // A/B variants, read with useVariant("tone")
  mcpServers: [{ id: "linear", url: "https://mcp.linear.app/mcp", enabled: false }],
  preview: { suggestedPrompts: ["How do I file a claim?"], chatPlaceholder: "Ask me anything…" },
});
```

Contract: the app component needs no props and returns `<Agent>`. Its children
are the agent level, and after them `<Agent>` renders every skill the
conversation has opened, so while none is open the model sees the agent level
alone. List every top-level skill in `<Skills>`, with its routing description,
so the model can open it.

The **system prompt** is authored in the tree with `<SystemPrompt>` (once, at
the top of `<Agent>`): one prompt for every turn. Replies are spoken by TTS,
and voice sessions append the framework's spoken-reply rules after your prompt
at runtime. They cover:

- two or three short sentences, about forty words, unless the caller asks for detail
- plain spoken sentences: no markdown, lists, headings, emojis or label-colon telegram style
- at most two items of any list: the count, the one or two that matter, the rest offered
- a greeting answered in one sentence about what the agent is for, then a question
- never the same reply twice word for word
- the answer first, details only when asked, at most one question per turn
- numbers, dates and IDs in their normal written form, never spelled out phonetically
- tools called without words, and one reply once their results are back
- `skip_turn` when the caller says "wait" or "hold on", or is thinking out loud
- after an interruption, what the caller did not hear worked back in
- on a live call, `end_call` with a short goodbye, never to escape a hard question

Write your prompt for the agent's job only: do not restate these rules or
contradict them.

## `skill.tsx`: one skill

```tsx
import { Instruction, Text, Tool, z, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Property damage",
  description: "Describing or assessing damage to buildings and household items.",
};

export default function PropertyDamage() {
  return (
    <>
      <Instruction>
        Help the user report property damage. Collect contact details and a concise damage description.
      </Instruction>
      Ask for the customer name, email address, and what happened to the property.
      <Text src="property-damage/intake-checklist.md" />
    </>
  );
}
```

- Default export: the skill component. Named export `meta` (`SkillMeta`):
  `title` (skill heading; derived from the path when omitted) and
  `description` (used by links and the skills index; a `<Skill>` link's own
  `description` prop wins over it).
- **Plain JSX text is context.** `<Text>` is optional; it is required only
  for file-backed content (`<Text src="policy/coverage-basics.md" />` reads
  from the project's `context/` directory).
- `<Instruction>` is behavioral guidance ("do X, then Y"); plain text/`<Text>`
  is factual content. Keep the two separated.
- **Inline skill links.** A `<Skill>` written inside a `<Text>` renders as a
  clickable link in the prose flow (rather than a standalone row) and still
  registers as a routable link + `available_skill:` entry, so you can weave
  the skills into a sentence: `<Text>reach for <Skill path="/property-damage">property damage</Skill> when your home is affected…</Text>`.
  The model sees the flattened prose; the link's `description` (or the target's
  `meta.description`) is what routing reads.

## Skill links and routing

`<Skill path="…" description="…">Label</Skill>` anywhere in a skill or in the
`<Skills>` index becomes a `read_skill` destination. Descriptions are the
routing table: phrase them as rules, including negative ones:

```
"Use FIRST whenever the user wants to file or report a new claim of any kind."
"NOT for filing a new claim; that always starts with the claim procedure skill."
```

Sub-skills are nested folders (`member-portal/priority-claim/skill.tsx` →
`/member-portal/priority-claim`). Every skill must be reachable from the
agent's `<Skills>` list, directly or through the links of a skill reached
from it; `curb check` warns about one that is not (`AGENT_UNREACHABLE_SKILL`).

## Next steps

- [Tools](./tools.md): give the skill something to do.
- [Skill lifecycle](./skill-lifecycle.md): what happens when a skill unloads.
