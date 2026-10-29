# Authoring reference

Everything here is importable from `"curb"`, except the provider factories,
which come from `"curb/providers"`.

## agent.tsx — the agent definition

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
          description="Use FIRST whenever the user wants to file a new claim — the mandatory ordered workflow."
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

### Providers: `llm`, `stt`, `tts`

The LLM and the speech providers are props on `<Agent>`, built with the
factories in `curb/providers`. Each returns a plain descriptor; the server
resolves it and reads the key from the environment, so nothing secret is in the
tree.

| Factory | Options | Key (env) |
|---|---|---|
| `kugelaudio.llm(...)` | `model`: `"qwen3.8-27b"` (default) or `"mistral-medium-3.5-128b"` | `KUGELAUDIO_API_KEY` |
| `anthropic(model)` | | `ANTHROPIC_API_KEY` |
| `openai(model)` | | `OPENAI_API_KEY` |
| `openaiCompatible({ baseURL, model, ... })` | `reasoningEffort`, `temperature`, `topP`, `body` | `AGENT_LLM_API_KEY`, else `OPENAI_API_KEY`, else none |
| `kugelaudio.stt(...)` | `language`, `turnDetection`, `turnDetectionLevel`, `boostedPhrases`, `dictionaryIds`, `projectId` | `KUGELAUDIO_API_KEY` |
| `azure.stt(...)` | `language`, `region`, `segmentationMs` | `AZURE_SPEECH_KEY` (`AZURE_SPEECH_REGION` default region, else `eastus`) |
| `deepgram.stt(...)` | `model`, `language` | `DEEPGRAM_API_KEY` |
| `elevenlabs.stt(...)` / `elevenlabs.tts(...)` | `model` / `voice`, `model` | `ELEVEN_API_KEY` |
| `openai.stt(...)` / `openai.tts(...)` | `model`, `language` / `voice`, `model` | `OPENAI_API_KEY` |
| `kugelaudio.tts(...)` | `voice`, `model`, `language`, `dictionaryIds`, `projectId` | `KUGELAUDIO_API_KEY` |
| `cartesia.tts(...)` | `voice`, `model`, `language` | `CARTESIA_API_KEY` |

Without a prop the defaults apply: `kugelaudio.llm()`,
`azure.stt()` and `kugelaudio.tts()` (English). A `kugelaudio.tts()` without `voice`
speaks the default voice of its `language`: 1072 for English, 1887 for German, and the
English 1072 for any other language, so give such an agent a `voice`
(`defaultKugelVoice(language)` from `"curb/providers"` returns the default). A chosen provider
whose key is missing fails with an error naming the variable.

`kugelaudio.llm()` is KugelAudio's LLM, hosted in the EU, on the same `KUGELAUDIO_API_KEY` as
its speech, so an agent on KugelAudio needs no other key; a hosted agent gets that key from
KugelAudio. Thinking is off on KugelAudio's side, so the agent never speaks its reasoning, and
nothing beyond the conversation and the tools is sent. It is served at `KUGELAUDIO_API_BASE`
(default `https://api.eu.kugelaudio.com`) plus `/v1`. An organization gets it with hosted
agents, in closed alpha; until then its turns answer 403 `LLM_NOT_ENABLED`.

`openaiCompatible()` sends nothing beyond the conversation and the tools unless you set it,
so the model runs with the server's defaults. For a reasoning model such as Qwen that often
means thinking out loud: the server returns the reasoning as plain reply text, and the agent
would speak it. Switch thinking off and set the model's recommended sampling on the
descriptor:

- `reasoningEffort`, sent as `reasoning_effort`: one of `"none"`, `"minimal"`, `"low"`,
  `"medium"`, `"high"`, `"xhigh"`, `"max"`. `"none"` turns thinking off where the endpoint
  takes it; the endpoint's documentation lists the values each model supports.
- `temperature` (0 to 2) and `topP` (above 0, at most 1), sent as `temperature` and `top_p`.
- `body`: extra request fields the endpoint accepts, sent as written. A field Curb sets
  itself (`model`, `messages`, `tools`, `tool_choice`, `stream`, `stream_options`) or one an
  option above sets (`temperature`, `top_p`, `reasoning_effort`) is refused when the agent
  renders, naming what to use instead.

Some hosted OpenAI-compatible APIs take `reasoning_effort`, not `chat_template_kwargs` (key in
`AGENT_LLM_API_KEY`):

```tsx
import { openaiCompatible } from "curb/providers";

<Agent
  llm={openaiCompatible({
    baseURL: "https://llm.example.com/v1",
    model: "qwen3.8-27b",
    reasoningEffort: "none",
    temperature: 0.7,
    topP: 0.8,
  })}
>
```

On a vLLM server, Qwen's chat template switches thinking off through
`chat_template_kwargs`, and `top_k` is a vLLM sampling field:

```tsx
<Agent
  llm={openaiCompatible({
    baseURL: "http://127.0.0.1:8000/v1",
    model: "qwen3.8-27b",
    temperature: 0.7,
    topP: 0.8,
    body: { top_k: 20, chat_template_kwargs: { enable_thinking: false } },
  })}
>
```

`kugelaudio.stt()` is Kugel Ear 1, KugelAudio's own speech-to-text, on the same
`KUGELAUDIO_API_KEY` as `kugelaudio.tts()`, so an agent on KugelAudio speech needs no
second vendor key. Set `language` to what your callers speak ("de", or "de,en" to detect
among several, expecting the first): without it the service detects German or English,
and a short German "Äh" or "Nein" can come out as English. KugelTurn, the end-of-turn
model inside the service, decides when the caller has finished (`turnDetectionLevel:
"conservative"` holds longer through pauses mid-thought). Names and product terms the
recognizer should spell your way go in `boostedPhrases`:

```tsx
<Agent
  stt={kugelaudio.stt({ language: "de", boostedPhrases: ["Beispiel GmbH", "Modell X7"] })}
  tts={kugelaudio.tts({ voice: 1887, language: "de" })}
>
```

Each caller turn becomes one transcript: the service's more accurate second pass over the
turn when it arrives within two seconds, else its first transcript. Supported languages:
de, en, fr, it, es, pt, nl, pl, ro; any other code fails when the agent starts.

A `<Skill>` link can carry the same props. While that skill is the active one
(the most recently read), its props override the agent's, slot by slot:

```tsx
import { Skill, Skills } from "curb";
import { kugelaudio } from "curb/providers";

export const skills = (
  <Skills>
    <Skill path="/billing" description="Invoices and payments.">Billing</Skill>
    <Skill path="/claims" description="Filing a claim." tts={kugelaudio.tts({ voice: 17 })}>Claims</Skill>
  </Skills>
);
```

Put such props on the link in the always-rendered `<Skills>` index, so they
hold however the skill was reached. Props are reactive: render another value
(from state, `useAgentInfo`, a skill change) and a running call switches to it.
A speech provider is swapped from the agent's next reply on (the reply being
spoken finishes in the old voice); the LLM applies from the next turn. A
re-render with an equal value changes nothing.

### Live settings: `adjustable` and `useSession`

The caller's app (`curb/client`'s `agent.update`) and the host
(`PATCH /v1/sessions/{id}`) may change a few settings mid-call, but only those
`<Agent adjustable>` lists for them. Absent, nothing is adjustable.

```tsx
import { Agent } from "curb";
import { kugelaudio } from "curb/providers";

export const agent = (
  <Agent
    tts={kugelaudio.tts({ voice: 1072 })}
    adjustable={{ client: ["tts.voice"], host: ["tts.voice", "stt.language", "llm"] }}
  >
    {/* the prompt, skills and tools */}
  </Agent>
);
```

Paths: `"tts.voice"`, `"tts.model"`, `"stt.language"`, `"llm"`. An accepted change
overrides the prop until the next change of the same path; a refused one changes
nothing. Read the effective providers (props plus outside changes) in any component:

```tsx
import { Text, useSession } from "curb";

export function CurrentVoice() {
  const { settings } = useSession();         // { llm, stt, tts } descriptors, read-only
  // e.g. { voice: 17 } after the app called agent.update({ tts: { voice: 17 } })
  return <Text>{`Speaking with ${settings.tts.provider} ${JSON.stringify(settings.tts.options)}.`}</Text>;
}
```

The body, the refusal codes and the wire format are in `docs/hosting.md`
("Live session settings").

On a hosted call, `useSession().call` is that call: its `sessionId` and its own
`scratchDir`, a writable directory removed when the call ends. A runner may serve
several calls in one process, so read the call's identity here, never from
`process.env`, and write files only under `scratchDir`. It is absent in
`curb dev`'s chat, and `scratchDir` is absent when the runner could not create one.

```tsx
import { Text, useSession } from "curb";

export function CallInfo() {
  const { call } = useSession();
  return <Text>{call ? `Call ${call.sessionId}.` : "Not a hosted call."}</Text>;
}
```

### Pronunciation dictionaries

Brand names, product names and abbreviations that TTS says wrong are fixed with
a **pronunciation dictionary**, not by spelling them out phonetically in the
prompt — the prompt is read by the model, and a phonetic respelling there leaks
into the text chat too.

```tsx
import { Agent } from "curb";
import { kugelaudio } from "curb/providers";

export const agent = (
  <Agent
    tts={kugelaudio.tts({
      voice: 1840,
      language: "de",
      projectId: 42,          // the number in your dashboard URL
      dictionaryIds: [7],   // applied in order
    })}
  >
    {/* the prompt, skills and tools */}
  </Agent>
);
```

Dictionaries belong to a KugelAudio project, so `projectId` is **required**
whenever `dictionaryIds` is set; the framework refuses the unpaired
combination at startup rather than letting the service reject the first spoken
turn of a live call. Find both in the console under
`/dashboard/<org>/<project>/dictionaries` — the project id is in the URL.

Omitting `dictionaryIds` entirely applies the project's own default selection.
Passing an empty array is a different thing: it opts out of every dictionary,
including the defaults.

### Who speaks first: `firstTurn`

| `firstTurn` | How a conversation opens |
|---|---|
| `"user"` (default) | The agent waits for the caller. |
| `"agent"` | A call opens with one short greeting the model writes after the caller joins. The instruction behind it is framework-generated and hidden from the preview transcript. |
| `{ say: "..." }` | Every conversation opens with exactly that line, with no model call: a call speaks it, typed chat in the preview shows it, `curb say` and `curb test` start with it. |

Use `{ say }` when the opening words must not vary, for example a notice the
law requires before an AI assistant talks to someone. A greeting the model
writes cannot guarantee wording; this line is said as written:

```tsx
export const agent = defineAgent({
  app: MyApp,
  firstTurn: {
    say: "Ich bin Clara, die digitale Assistentin von Beispiel GmbH. Ich bin eine KI und kann Fehler machen. Wie kann ich helfen?",
  },
});
```

The line is the agent's first message in the conversation, so the model knows
it has already greeted and answers the caller's first words instead of
greeting again. On a call it is spoken with interruptions off, like the
`"agent"` greeting: the caller hears all of it, and a message typed meanwhile
is answered once it has played.

`say` can also be a function of the session info the conversation has when it
opens: `caller.*` on a call, and `client.*`, the page info. It gets a
read-only record and returns the words. Return words for every session,
including one without the key it reads:

```tsx
firstTurn: {
  say: ({ "client.event": event }) =>
    typeof event === "string"
      ? `Ich bin Clara, die digitale Assistentin von Beispiel GmbH. Schön, dass Sie vom ${event} kommen.`
      : "Ich bin Clara, die digitale Assistentin von Beispiel GmbH.",
},
```

`client.*` is what the web page the agent is embedded in says about itself
(the event it advertises, the campaign it came from). It is untrusted input
from that page, like a form field: use it to choose words, never to decide
what the caller may see or do. Every route holds it to the same limits: a key
is a letter followed by up to 39 letters, digits or underscores, and a value is
a string of at most 256 characters. To try it locally, see
[testing.md](./testing.md) ("Page info: `client.*`").

`defineAgent` refuses a `say` with no words (`AGENT_INVALID_AUTHORING_PROP`).
A function that returns none is reported when the conversation opens, and the
conversation goes on without the line.

### Goals and A/B experiments: `goals`, `experiments`, `useVariant`

`goals` say what counts as a successful call, and `experiments` split calls
between variants of the agent, so you can see which variant reaches the goals
more often. Both are declared in `defineAgent`; `curb build` writes them into
the bundle (`curb.bundle.json`), and a hosting platform reports per call which
goals it reached and which variant it had.

```tsx
export const agent = defineAgent({
  app: MyApp,
  goals: {
    booked: { description: "The caller booked a webinar slot", tool: "book_slot" },
    felt_easy: { description: "Booking felt easy", judge: "The caller says booking with the assistant was easy or pleasant." },
  },
  experiments: {
    greeting: {
      description: "Formal vs casual opening",
      variants: { formal: 1, casual: 1 },   // relative weights
      fromClient: "greeting",               // optional: client.greeting naming a variant picks it
    },
  },
});
```

- A goal has exactly one of `tool` or `judge`. A `tool` goal is reached when
  the agent ran that tool and it succeeded; `curb check` warns
  (`AGENT_GOAL_TOOL_NOT_DECLARED`) when no `<Tool>` has that name. A `judge`
  goal is a criterion a judge model checks against the conversation (1 to
  1000 characters).
- An experiment has 2 to 6 variants with whole-number weights from 1 to 100:
  `{ formal: 1, casual: 3 }` sends three calls in four to `casual`.
  `fromClient` names a page info key (`client.<key>`) whose value, when it is
  one of the variants, picks that variant for the call instead of the draw.
- Names of goals, experiments and variants are a lowercase letter, then up to
  39 lowercase letters, digits or underscores. An agent has at most 20 goals
  and 5 experiments, and a `description` holds at most 200 characters.
  `defineAgent` refuses anything else (`AGENT_INVALID_AUTHORING_PROP`), naming
  every problem.

Read the call's variant with `useVariant(name)`. It is set before the first
turn and stays for the whole call:

```tsx
import { Instruction, useVariant } from "curb";

function Greeting() {
  return useVariant("greeting") === "casual" ? (
    <Instruction>Greet the caller casually, by first name when you know it.</Instruction>
  ) : (
    <Instruction>Greet the caller formally.</Instruction>
  );
}
```

`useVariant` returns `undefined` for an experiment the agent does not declare,
and in `curb say` and `curb start`, which assign no variants. The variant is
the session info `experiment.<name>`, so a `firstTurn: { say }` function reads
it as `info["experiment.greeting"]`. Where each local route gets its variants
(`curb dev`, `curb test`): [testing.md](./testing.md) ("Experiment variants").

## skill.tsx — one routed context

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
  `description` (used by links and the skills index — a `<Skill>` link's own
  `description` prop wins over it).
- **Plain JSX text is context.** `<Text>` is optional; it is required only
  for file-backed content (`<Text src="policy/coverage-basics.md" />` reads
  from the project's `context/` directory).
- `<Instruction>` is behavioral guidance ("do X, then Y"); plain text/`<Text>`
  is factual content. Keep the two separated.
- **Inline skill links.** A `<Skill>` written inside a `<Text>` renders as a
  clickable link in the prose flow (rather than a standalone row) and still
  registers as a routable link + `available_skill:` entry — so you can weave
  the skills into a sentence: `<Text>reach for <Skill path="/property-damage">property damage</Skill> when your home is affected…</Text>`.
  The model sees the flattened prose; the link's `description` (or the target's
  `meta.description`) is what routing reads.

## Writing prose

Write a system prompt, instruction or text that runs over several lines as ONE
template literal inside the component:

```tsx
<Instruction>{`
  Collect the caller's details before you promise anything.

  ## Order
  - name
  - phone number
  - what happened
`}</Instruction>
```

Plain JSX text cannot carry that structure. The JSX transform joins JSX text
onto one line before Curb ever sees it, so paragraphs, `## ` headings and `- `
lists written as JSX text reach the model as one run-on sentence. `curb check`
warns about it (`AGENT_PROSE_JSX_TEXT`) and shows the template-literal rewrite.

The compiler removes the indentation all lines share and the blank lines at the
start and end, and keeps the rest: paragraphs, headings, lists, line breaks and
`${...}` values. That holds in `<SystemPrompt>`, `<Instruction>` and `<Text>`,
inline `<Skill>` links included. Text that fits on one line, JSX or string,
compiles exactly as before.

The model gets the system prompt as written. In its context each multi-line
instruction or text stays one entry, with its continuation lines indented under
it:

```text
instruction: Collect the caller's details before you promise anything.

  ## Order
  - name
  - phone number
  - what happened
```

The preview shows the same text formatted, headings and lists included. Keep a
block in one literal: a one-line text written next to it becomes a paragraph of
its own.

## Tools

```tsx
<Tool
  schema={z.object({
    email: z
      .string()
      .email("Email address is invalid. Ask the user for a corrected email address.")
      .describe("Customer email address."),
  })}
  name="submit_property_damage_claim"          // snake_case verb, unique across the agent
  description="Submit a property damage claim intake."
  success="Property damage claim intake was accepted."
  onSubmit={(input) => ({ ok: true, data: input })}
/>
```

- `schema` is a Zod object, and the model gets its JSON Schema: lists, nested
  objects, `.nullable()` and `.optional()`, enums, number ranges, string formats
  and `.regex()` patterns, and every `.describe()` at any depth (before or after
  `.optional()`). `onSubmit` gets the parsed, typed value, so give a tool the shape
  it needs instead of a string to split:

  ```tsx
  schema={z.object({
    room: z.string().describe("The guest's room number."),
    items: z
      .array(
        z.object({
          name: z.string().describe("A dish or drink from the menu."),
          quantity: z.number().int().min(1).describe("How many."),
        }),
      )
      .min(1)
      .describe("Everything the guest ordered."),
  })}
  ```

  A `.default()` field may be left out. A refusal names where a nested problem is
  (`items.0.quantity: ...`); write validation messages as next-step instructions.
  A recursive schema or a type JSON cannot carry (`z.date()`, `z.bigint()`) is an
  authoring error; a date is `z.iso.date()` or `z.iso.datetime()`.
- `onSubmit` returns a `ToolResult` — `{ ok: boolean, message?, data? }`.
  Schema validation failures are generated automatically from the Zod
  messages; for handler-level failures return `{ ok: false, message }` or
  throw `ToolInputError`. Rendered `<ErrorMessage>` content becomes new
  context the model reads on its next step. Any other exception is logged on
  the server, and the model gets `{ ok: false }` with a generic "internal
  error" message instead of the raw error, so write `ToolInputError`
  messages for anything the model can fix.
- Tools inside `<GlobalTools>` exist from the first turn, whichever skills
  are loaded; tools inside a skill exist only while that skill is loaded.
- `tryWith` is optional input the preview's **Try** form opens with, typed from
  the schema, so trying a tool that needs real demo data takes one click; the
  model never sees it:

  ```tsx
  <Tool
    schema={verifySchema}
    name="verify_customer"
    description="Check the customer number and year of birth."
    tryWith={{ customerNumber: "K-482913", birthYear: "1985" }}  // a customer your demo data knows
    onSubmit={verify}
  />
  ```
- **Tool as an object.** The inline form above is best for showcasing a tool
  where it lives. To keep a tool next to the code that backs it, define it with
  `defineTool` (fully typed, like `defineAgent`) and pass it via `def`:

  ```tsx
  const submitClaim = defineTool({
    name: "submit_property_damage_claim",
    description: "Submit a property damage claim intake.",
    schema: z.object({ email: z.string().email().describe("Customer email address.") }),
    success: "Property damage claim intake was accepted.",
    onSubmit: (input) => ({ ok: true, data: input }),  // input is typed from the schema
  });

  // …in the tree:
  <Tool def={submitClaim} />        // equivalently: <Tool {...submitClaim} />
  ```

  Both compile to the same tool. The object supports every inline variant —
  `schema` + `onSubmit`, `onSubmit` alone, or `onCall`; you can also type an
  object by hand with the exported `ToolProps` type instead of `defineTool`.

### Calling your own API from a tool

```tsx
// .env.example lists ORDER_API_URL, such as https://shop.example.com/api/ (with the final "/").
async function orderApi(path: string): Promise<Response> {
  const base = process.env.ORDER_API_URL;
  if (!base) throw new Error("ORDER_API_URL is not set");
  return fetch(new URL(path, base), { signal: AbortSignal.timeout(5_000) });
}

const UNREACHABLE = "The order system is not answering. Tell the caller and offer to try again in a moment.";

<Tool
  schema={z.object({ order: z.string().min(1).describe("Order number, such as A-1234.") })}
  name="look_up_order"
  description="Look up the status of an order."
  onSubmit={async ({ order }) => {
    let response: Response;
    try {
      response = await orderApi(`orders/${encodeURIComponent(order)}`);
    } catch (error) {
      console.error("look_up_order: no answer from the order API", error);
      return { ok: false, message: UNREACHABLE };
    }
    if (response.status === 404) {
      throw new ToolInputError(`There is no order ${order}. Ask the caller to read the number again.`);
    }
    if (!response.ok) {
      console.error(`look_up_order: the order API answered ${response.status}`);
      return { ok: false, message: UNREACHABLE };
    }
    return { ok: true, data: await response.json() };
  }}
/>
```

- Read the base URL, and any key, from an env var listed in `.env.example`, so
  whoever runs or deploys the agent knows to set it.
- `new URL(path, base)` keeps the base's path only when the base ends with `/`
  and the path does not start with one: `new URL("orders/7", "https://shop.example.com/api")`
  is `https://shop.example.com/orders/7`, without `/api`.
- Give every request a timeout (`AbortSignal.timeout`): while a tool waits, the
  caller hears silence.
- Turn a failed request into `{ ok: false, message }` the model can say to the
  caller, and log the real error with `console.error`. An empty `catch {}`
  hides why calls fail.
- Throw `ToolInputError` for input the caller must fix, such as an order number
  that does not exist.

### Tools the framework provides

Three tools exist without being authored, and you should not write your own
versions of them:

| Tool | When the model has it | What it does |
|---|---|---|
| `read_skill` | whenever the current context has skill links | loads a skill's instructions and tools |
| `skip_turn` | always | ends the turn with no reply at all ("hold on", the user thinking out loud) |
| `end_call` | only during a live voice call | says its `goodbye` to the caller and hangs up |

`end_call` is the one to know about when you write a voice agent's prompts.
Its one input, `goodbye`, is the closing line: the session says it once the
call ran, and the transcript records it as the agent's reply. As before any
tool call, Curb holds back the newest sentence the model writes in that step
and drops it; sentences before that one were already said. An empty `goodbye`
is refused like any invalid input, and the call stays up. The
call disconnects the moment the goodbye has finished playing, so it is never
cut off mid-word. It is absent from typed chat sessions — there is no call to
hang up — and the framework's spoken-style rules teach it only while it is
present, including when NOT to use it (never to escape a hard question, never
while something is still open). Add domain reasons to end a call in your own
prompt if you have them; do not restate the mechanics.

## Actions that need the caller's yes

A tool that books, sends, pays or cancels should run only after the caller has
said yes to exactly what will happen. Give it `confirm`: the question read back
to the caller, built from the validated input, in the agent's language.

Only for such actions. To repeat a name or a number back so the caller can correct
it, say it in the reply: a `confirm` tool makes the caller's next turn the answer to
its question, so a caller who simply goes on with the next detail leaves the tool
waiting and unconfirmed.

```tsx
<Tool
  schema={bookSchema}
  name="book_meeting"
  description="Book the chosen slot."
  confirm={(input) => `${input.start} for ${input.email}, is that right?`}
  onSubmit={async (input) => ({ ok: true, message: `Booked for ${input.start}.` })}
/>
```

1. The model calls `book_meeting`, and `onSubmit` does not run. The input is
   validated as for any call, the caller hears the `confirm` question word for
   word, and the turn ends there. The model's tool result says that nothing has
   happened yet.
2. The caller's next words are checked against that question with one short
   call on the agent's own LLM, which answers yes, no or unclear:
   - **Yes:** `onSubmit` runs and the model answers from its result. The
     transcript records the call with the words that confirmed it.
   - **No,** or a changed detail: nothing runs, and the model is told so. It
     handles the correction; calling the tool again reads the new details back.
   - **Unclear,** or the check failed: nothing runs, the question stays open,
     and the model asks once more.
3. While the question is open, the model's context shows
   `Waiting for the caller to confirm: "…"`. Calling the tool again replaces
   the open question; holding another `confirm` tool does too, and the model is
   told that the replaced action will not run.

The model cannot run a `confirm` tool itself: only the caller's yes on a later
turn does, in preview chat, local voice, hosted calls and tests alike.

- Only words that arrived after the caller heard the question answer it: in
  chat and tests as soon as it is said, on a call once it played to its end.
  Input already waiting, and the framework's silence follow-up, do not; a turn
  the caller cancels before the question is said asks nothing.
- On a call, a caller who speaks before the question played to its end has not
  been asked: their words drop it, and the model is told to call the tool again
  so the whole question is said.
- A yes runs the tool from the skill that asked. If that skill no longer owns
  the tool's name, nothing runs and the model is told.
- A step that asks never hangs up: an `end_call` in the same step is refused,
  and its goodbye is not said.
- Rewinding, or reopening a stored conversation, to just after the question
  keeps it open. Rewinding anywhere else drops it.
- A confirmed action is not replayed when a conversation is reopened or
  rewound; the preview names it as not replayed.
- Limit: when the model writes two or more sentences before the call in the
  same step, all but the last are said before the question. The tool's
  description already tells the model not to claim success, and nothing runs
  without the yes.

When you write one:

- Name what the caller must check (date, time, email, amount), so that a plain
  yes means "do exactly this".
- The question is said word for word. Build it only from the input the tool
  sends, never from a free-text field the model fills, such as a summary, so
  the yes approves exactly what runs. A phone number, IBAN or plate the tool
  sends belongs in its read-back.
- Throw `ToolInputError` in `confirm` to send the model back for better input,
  for example a slot that cannot be booked.
- Do not also ask for the confirmation in your prompt. The model is told that
  calling the tool asks the caller.
- If `onSubmit` fails after the yes (`{ ok: false }` or a thrown error), the
  model learns it like any failed tool call.
- `confirm` works on both `onSubmit` variants (`schema`, or `<Field>` children),
  inline or in `defineTool`.

## Shared state — the gating mechanism

```tsx
// agent.tsx
export const useStore = createAgentStore<{
  procedureComplete: boolean;
  completeProcedure: () => void;
}>("insurance", (set) => ({
  procedureComplete: false,
  completeProcedure: () => set({ procedureComplete: true }),
}));

// property-damage/skill.tsx
const procedureComplete = useStore((s) => s.procedureComplete);
return procedureComplete ? (
  <Tool name="submit_property_damage_claim" … />
) : (
  <Text>Claim intake is locked: complete the claim procedure first — the submission unlocks afterwards.</Text>
);
```

This is the framework's core invariant pattern: the model **cannot route
around** a rule enforced by conditional rendering, because the locked tool is
absent from its context. Always pair a lock with text that tells the model
how to unlock it (otherwise diagnostics flag the branch as possibly locked).
Every action your prompt or a tool result offers the caller needs its tool
rendered in that state: a result that offers a callback while no callback tool
is rendered makes a promise the model cannot keep.

`useAgentInfo((info) => info["caller.phoneNumber"])` reads host-injected
session info (e.g. caller ID on the voice bridge), selector-based. `useClient()` reads the
`client.*` keys without the prefix (`const { email } = useClient()`). They come from the
caller's page and are forgeable: prefill with them, but never lock a branch like the one
above on them (see [orchestration.md](./orchestration.md#client-is-written-by-the-page)).
`useVariant(name)` reads the call's variant of an experiment (`experiment.<name>`; see
"Goals and A/B experiments" above).

## Pattern blocks

**Procedure** — ordered steps the model must complete in sequence:

```tsx
<Procedure
  title="Three-step claim reporting order"
  advanceTool={{ name: "complete_claim_procedure_stage", description: "Mark the current step complete." }}
  onComplete={completeProcedure}
  completed={<Tool name="submit_prepared_claim" … />}
>
  <Step title="Confirm safety and prevent further damage">…</Step>
  <Step title="Collect evidence before filing">…</Step>
  <Step title="Move to claim intake">…</Step>
</Procedure>
```

**Unlock after a check** (a verified email, a PIN): there is no gate component. Render
it with state, as in [Shared state](#shared-state--the-gating-mechanism): a tool that
checks and sets a store flag, a locked text that says how to unlock, and the content,
tools and `<Skill>` links once the flag is set. A `<Skill>` link rendered only then can
be discovered and loaded only after the check.

## Skill links and routing

`<Skill path="…" description="…">Label</Skill>` anywhere in a skill or in the
`<Skills>` index becomes a `read_skill` destination. Descriptions are the
routing table — phrase them as rules, including negative ones:

```
"Use FIRST whenever the user wants to file or report a new claim of any kind."
"NOT for filing a new claim — that always starts with the claim procedure skill."
```

Sub-skills are nested folders (`member-portal/priority-claim/skill.tsx` →
`/member-portal/priority-claim`). Every skill must be reachable from the
agent's `<Skills>` list, directly or through the links of a skill reached
from it; `curb check` warns about one that is not (`AGENT_UNREACHABLE_SKILL`).

## MCP

Declare a remote MCP server inline, right where you use it — no separate
config:

```tsx
<Mcp id="linear" url="https://mcp.linear.app/mcp" only={["create_issue"]} />
```

`id` is the tool namespace (`linear__create_issue`) and the credential key.
Placement is scope, like any tool: inside `<GlobalTools>` it is everywhere;
inside a skill it is scoped to that skill. `only` is an optional allowlist of
raw tool names. The server registers and connects on render; its tools appear
once it is ready.

**Credentials are implicit — never put a secret in agent code:**

- Omit `auth` → a bearer token from `MCP_<ID>_TOKEN` in `.env`
  (`id="linear"` → `MCP_LINEAR_TOKEN`) if present, else **OAuth**: the server
  parks until you log in once via the preview's "MCP servers" menu; tokens
  persist per-`id` in `.mcp-auth/<id>.json` (gitignored).
- Override with `auth={{ kind: "bearer", token }}` or `auth={{ kind: "none" }}`.

Alternatives: `defineAgent({ mcpServers: [{ id, url, enabled }] })` pre-registers
a server for eager connection before the first render; servers added at runtime
through the preview persist in the project's `mcp.servers.json` (tokens never
land there).

## App messages

`useSend()` sends small keyed messages to the caller's app (`toClient`) or to whatever
hosts the call (`toHost`, `askHost`); `useMessage(key, { from, schema?, onMessage })`
handles what they send. A key is any non-empty string up to 256 characters.

```tsx
import { useState } from "react";
import { HostTimeoutError, HostUnavailableError, Text, Tool, useMessage, useSend, z } from "curb";

export function Claims() {
  const send = useSend();
  const [claimId, setClaimId] = useState<string | null>(null);
  const [supervisorOnline, setSupervisorOnline] = useState(false);

  // From the caller's app. The return value is the reply to the app's send.
  useMessage("claim-submitted", {
    from: "client",
    schema: z.object({ claimId: z.string() }),
    onMessage: ({ claimId }) => {
      setClaimId(claimId);
      return { received: true };
    },
  });
  // From the host.
  useMessage("ops.supervisor_online", { from: "host", onMessage: () => setSupervisorOnline(true) });

  return (
    <>
      {claimId !== null && <Text>{`The caller submitted claim ${claimId}.`}</Text>}
      {supervisorOnline && (
        <Tool
          name="ask_supervisor"
          description="Ask a human supervisor to approve a refund."
          onCall={async () => {
            send.toClient("show-status", { status: "waiting-for-supervisor" });
            try {
              const answer = await send.askHost("human.requested", { topic: "refund" });
              return { ok: true, data: answer };
            } catch (error) {
              if (error instanceof HostUnavailableError || error instanceof HostTimeoutError) {
                return { ok: false, message: "No supervisor is available. Offer a callback instead." };
              }
              throw error;
            }
          }}
        />
      )}
    </>
  );
}
```

- `from` is required: a `"client"` handler never sees a host message and vice versa.
- With a `schema`, `onMessage` gets the parsed payload; a payload it refuses never
  reaches `onMessage` and the sender gets `invalid_payload` with the issues.
- A message nobody listens for is refused `no_handler`; a handler that throws is
  `handler_failed`. Nothing is dropped silently.
- `toClient` with no app in the room yet, `toClient` on a phone call (no app), and
  `toHost` with no host are dropped with one warning per key and reason, and counted in the
  call record. `askHost` rejects `HostUnavailableError` with no host, and
  `HostTimeoutError` after `{ timeoutMs }` (default 10000).
- After a `useMessage` handler runs the context is recompiled, so a store change it
  makes can unlock a skill or tool, like any other gate.
- Each call has its own messages. The wire formats (host protocol and LiveKit) are in
  `docs/hosting.md` ("App messages").

## Transfer a call

On a hosted phone call the agent can put the caller through to another number. The
ready tool lets the model do it; `useTransferCall()` is the same thing for your own code.

```tsx
import { Instruction, TransferCallTool, Tool, useTransferCall } from "curb";

export function Handover() {
  const transfer = useTransferCall();
  return (
    <>
      <Instruction>When the caller asks for a person, call transfer_call.</Instruction>
      <TransferCallTool to="+493012345678" ringTimeoutSeconds={25} />
      <Tool
        name="call_claims_desk"
        description="Put the caller through to the claims desk."
        onCall={async () => {
          const { outcome } = await transfer({
            to: "+493098765432",
            announce: "One moment, I am connecting you to the claims desk.",
          });
          return { ok: outcome === "answered", message: `Transfer: ${outcome}.` };
        }}
      />
    </>
  );
}
```

- `transfer({ to, ringTimeoutSeconds?, announce? })` resolves
  `{ outcome, code?, message?, transferId? }` with `outcome` one of `answered`, `no_answer`,
  `busy`, `failed`, `refused`. It never rejects for an outcome; a bad `to`, a
  `ringTimeoutSeconds` outside 10 to 60 or a blank `announce` throws `TypeError` (on
  `<TransferCallTool>`, an authoring error when it renders).
- The caller never waits in silence. `announce` is said first, in the agent's voice: it
  cannot be interrupted, and the number is dialed only once it has played. Without
  `announce` nothing is said. Then the caller hears a ringback tone (425 Hz, 1 s on, 4 s
  off) until the outcome arrives, whatever it is, or the call ends. Outside a phone call
  nothing plays.
- `answered`: the target is in the call and the agent is handed off: it stops listening
  and speaking. When the target leaves and the caller is still there, the agent takes the
  call back and is told the transfer ended. The caller hanging up ends the call.
- `refused`: nothing was dialed, and one error line in the log names the code.
  `upgrade_required` means the plan has no `outbound-calls` feature;
  `transfer_unsupported_session` means this is not a phone call (a browser session or
  `curb dev`), where transfers never work; `transfer_in_progress`, one transfer at a time.
- `failed` with code `transfer_no_reply`: the host did not answer the request within 20 s,
  or sent no result within the ring time plus 30 s.
- `<TransferCallTool>` takes `to`, and optionally `name` (default `transfer_call`),
  `description` and `ringTimeoutSeconds`. The model calls it with `announce`, the one
  sentence it says to the caller before connecting ("One moment, I am connecting you to our
  sales team."); a call without one is refused and nobody is dialed, so the model calls
  again with it. The tool tells the model each outcome in plain words ("nobody answered",
  "the line was busy") so it can tell the caller.

## Don'ts

- Don't import framework internals by deep path — only `"curb"`.
- Don't hand-register skills or routes; the filesystem is the registry.
- Don't encode invariants only in prompt text; render them structurally.
- Don't duplicate tool names, and don't leave a `<Skill>` link undescribed.
- Don't put UI concerns in skills — there is no DOM; everything is context.
