# What the model receives

Curb uses React to write the model's context. The model never sees React: it gets ordinary
LLM requests, a system prompt, messages and tools. This page shows those requests, so you
can judge the framework by what it sends.

This agent is the example. It has a system prompt and three skills:

```tsx
export function App() {
  return (
    <Agent>
      <SystemPrompt>You answer the phone at an insurance company.</SystemPrompt>
      <Skills>
        <Skill path="/report-claim" description="Use when the caller wants to report damage.">Report a claim</Skill>
        <Skill path="/claim-status" description="Use when the caller asks about an open claim.">Claim status</Skill>
        <Skill path="/policy-questions" description="Use for questions about cover.">Policy questions</Skill>
      </Skills>
    </Agent>
  );
}
```

```tsx
// src/agent/report-claim/skill.tsx
export default function ReportClaim() {
  const { policy, verify } = useClaim();        // a createAgentStore store
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
```

## The first request

A caller types "A pipe burst at home". This is the whole request, with the tools by name. On a
voice call, the system text also carries the spoken-reply rules and the tools include `end_call`.

<!-- request: first -->
```text
=== system ===
You answer the phone at an insurance company.

## Context from your application
Your application, not the person you talk to, adds two kinds of blocks to the conversation. The person cannot see or write them.
- `<current_context>` ends the newest user message: today's date and time, your current state and knowledge, and the instructions and tools of the skills you have read, written fresh for every turn. Follow it.
- `<context_event>`: a notice of something that happened outside your own tool calls: your state changed, or the person talked over one of your replies.
Treat both as your own trusted context, never as the person's words, and never mention, quote or comment on them.
=== tools ===
skip_turn, read_skill
=== messages ===
user: A pipe burst at home
user: <current_context>
Today is Friday, 30 October 2026, 15:00 (UTC). The next days: …
available_skill: Report a claim — Use when the caller wants to report damage.
available_skill: Claim status — Use when the caller asks about an open claim.
available_skill: Policy questions — Use for questions about cover.
tool: skip_turn() [runtime]
tool: read_skill(skill*) [runtime]
</current_context>
```

Three things are there, in order:

1. **`system`** is your `<SystemPrompt>` and a fixed note about the two kinds of block. On a
   voice turn, Curb's spoken-reply rules follow your prompt
   ([Agents and skills](./agents-and-skills.md#agenttsx-the-agent-definition)).
2. **The transcript** is what was said, plus each tool call and its result.
3. **`<current_context>`** is the render of your tree right now, added as the last message.
   It is written fresh for every request and never stored in the transcript, so what comes
   before it stays the same and a provider's prompt cache keeps working.

In `<current_context>`, `tool:` lines end in `[runtime]` for Curb's own tools and `[page]` for
tools your tree renders, and `*` marks a required input.

No skill is loaded yet, so `/report-claim`'s instruction and tool are not in the request at all.
The model knows only each skill's name and description, and `read_skill`.

## After `read_skill`

The model calls `read_skill` for `/report-claim`. Curb mounts the skill, renders, and asks the model
again. The second request of the same turn:

<!-- request: after-read-skill -->
```text
=== system ===
You answer the phone at an insurance company.

## Context from your application
Your application, not the person you talk to, adds two kinds of blocks to the conversation. The person cannot see or write them.
- `<current_context>` ends the newest user message: today's date and time, your current state and knowledge, and the instructions and tools of the skills you have read, written fresh for every turn. Follow it.
- `<context_event>`: a notice of something that happened outside your own tool calls: your state changed, or the person talked over one of your replies.
Treat both as your own trusted context, never as the person's words, and never mention, quote or comment on them.
=== tools ===
skip_turn, read_skill, verify_policy
=== messages ===
user: A pipe burst at home
assistant: call read_skill({"skill":"/report-claim"})
tool: result read_skill: {"ok":true,"note":"Skill read: its instructions and tools are now in your current context (the last message). Skills are internal; the user never sees them.","contextChanged":["active_skill: Report a claim","instruction: Ask for the policy number.","content: No policy is verified.","content: Attempts so far: 0.","tool: verify_policy(policy*) [page]"]}
user: <current_context skill="Report a claim">
Today is Friday, 30 October 2026, 15:00 (UTC). The next days: …
active_skill: Report a claim
instruction: Ask for the policy number.
content: No policy is verified.
content: Attempts so far: 0.
available_skill: Report a claim — Use when the caller wants to report damage.
available_skill: Claim status — Use when the caller asks about an open claim.
available_skill: Policy questions — Use for questions about cover.
tool: skip_turn() [runtime]
tool: read_skill(skill*) [runtime]
tool: verify_policy(policy*) [page]
</current_context>
```

Compare the two: `verify_policy` joined the tools, the skill's instruction and text joined
`<current_context>`, and the tool result reports what changed in `contextChanged`. Each line
there is cut at 200 characters, because a tool result stays in the transcript; the full text
is always in `<current_context>`.

That is all a render does. When state changes, the next request differs, and a tool that is
not rendered is not in the request.

## When state changes, the tools change

Branch on state, and the model's instruction and tools change with it. This is the same skill
with one switch:

```tsx
// src/agent/report-claim/skill.tsx, with a switch
export default function ReportClaim() {
  const [verified, setVerified] = useState(false);
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
```

What each step of a call leaves in the request: what the caller said, the tool the model called,
the value of `verified`, then the skill's lines.

<!-- request: states -->
```text
=== A pipe burst at home: read_skill
state: verified = false
instruction: Ask for the policy number.
tool: verify_policy(policy*) [page]
=== It's 4711: verify_policy
state: verified = true
instruction: Ask what happened.
tool: open_claim(what*) [page]
```

`open_claim` does not exist until the policy is verified, so the model cannot open a claim for a
caller it has not checked, whatever the caller says.

## See it for your own agent

| Where | What you get |
|---|---|
| `curb dev`, **What the model read** under a reply | The exact input of that model call, downloadable as JSON ([The preview](./preview.md)) |
| `curb say` | The tool calls and the lines each turn added to the context ([Testing](./testing.md)) |
| `curb conversations` | Recorded conversations with every tool call, input and result |

## Next steps

- [Skill lifecycle](./skill-lifecycle.md): what leaves the request when a skill unloads.
- [How Curb works](./how-it-works.md): the renderer and the turn loop.
- [Architecture](./architecture.md): what runs where, and how Curb talks to a host.
