# Migrate from ElevenLabs

Move an agent from ElevenLabs Agents to [Curb](./README.md) in five steps. There is no importer:
you export the agent's configuration and rebuild it as code, then test it and move your
phone numbers one at a time. Your ElevenLabs agent keeps answering until the last number has
moved.

A [coding agent connected to KugelAudio](https://docs.kugelaudio.com/hosted-agents/coding-agent) can do most of the
rebuild. Give it the exported files and this page.

If you only use ElevenLabs for text to speech, you do not need this page: see
[ElevenLabs API compatibility](https://docs.kugelaudio.com/integrations/elevenlabs-proxy).

## Before you start

Hosted deploys do not accept a project that installs Curb from npm yet, and step 2 creates such a
project. Your numbers can only move to KugelAudio once they do, so keep your ElevenLabs agent
answering until then.

Read [what has no equivalent yet](#what-has-no-equivalent-yet) first. If your agent depends
on your own SIP trunk or on one of the other features listed there, plan for that before you
rebuild anything.

## 1. Export your agent

Export into a folder of its own, outside your Curb project, because `curb deploy` uploads
the project's source. Install the [ElevenLabs CLI](https://elevenlabs.io/docs/eleven-agents/operate/cli)
and pull the agent, its tools and its tests:

```bash
npm install -g @elevenlabs/cli
mkdir elevenlabs-export && cd elevenlabs-export
elevenlabs auth login
elevenlabs agents init
elevenlabs agents pull --agent AGENT_ID
elevenlabs tools pull
elevenlabs tests pull
```

The configs land in `agent_configs/`, `tool_configs/` and `test_configs/`. Command names
change between CLI versions, so check `elevenlabs --help` if one is refused.

Then fetch what the configs only point to. Each knowledge base document has an ID under
`conversation_config.agent.prompt.knowledge_base`, and its text comes from the
[document content endpoint](https://elevenlabs.io/docs/api-reference/knowledge-base/get-content):

```bash
curl -H "xi-api-key: $ELEVENLABS_API_KEY" \
  https://api.elevenlabs.io/v1/convai/knowledge-base/DOCUMENT_ID/content
```

Past calls make the best tests, so fetch some from the
[conversations endpoints](https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/list).
The list gives you their IDs, and each conversation gives you its transcript, its tool calls
and its analysis. `/audio` on a conversation returns its recording.

```bash
curl -H "xi-api-key: $ELEVENLABS_API_KEY" \
  "https://api.elevenlabs.io/v1/convai/conversations?agent_id=AGENT_ID&page_size=100"

curl -H "xi-api-key: $ELEVENLABS_API_KEY" \
  https://api.elevenlabs.io/v1/convai/conversations/CONVERSATION_ID
```

Transcripts and recordings hold what your callers said, so keep them out of your repository.
Past calls do not move to KugelAudio. Export whatever you must keep before you close your
ElevenLabs account.

## 2. Rebuild it in Curb

Create the project as in [Installation](./installation.md):

```bash
npm create curb.js my-agent
cd my-agent && npx curb login
```

Then carry the configuration over. The [authoring reference](./agents-and-skills.md) covers
everything named here.

| ElevenLabs | Curb |
|---|---|
| System prompt | `<SystemPrompt>` in `src/agent/agent.tsx` |
| First message | `firstTurn: { say }` in `defineAgent` for fixed words, `firstTurn: "agent"` for a greeting the model writes |
| LLM | The `llm` prop: `kugelaudio.llm()`, `anthropic(model)` or `openai(model)` |
| Custom LLM | `openaiCompatible({ baseURL, model })` |
| Voice | The `tts` prop, see [step 3](#3-choose-a-voice) |
| Speech recognition keywords | `boostedPhrases` on `kugelaudio.stt()` |
| Turn eagerness | `turnDetectionLevel` on `kugelaudio.stt()` |
| Pronunciation dictionaries | [Dictionaries](https://docs.kugelaudio.com/features/dictionaries), selected with `dictionaryIds` |
| Webhook tool | `<Tool>` whose `onSubmit` calls your API ([recipe](./tools.md#call-an-https-api-with-a-secret)) |
| MCP server | `<Mcp>` |
| Client tool | `useSend()` and `useMessage()` |
| `end_call`, `skip_turn` | Built in: do not write your own |
| `transfer_to_number` | `<TransferCallTool>` or `useTransferCall()` ([forward a call](https://docs.kugelaudio.com/hosted-agents/outbound-calls#forward-a-call-to-a-person)) |
| `transfer_to_agent` | A skill in the same project |
| Dynamic variables | `useAgentInfo()` for what the call knows, `useClient()` for what your page sent |
| Knowledge base | Files in `context/`, rendered with `<Text src="..." />` |
| Evaluation criteria | `goals` with `judge` or `tool` ([goals](./goals-and-experiments.md)) |
| Data collection | A `<Tool>` that captures the fields and sends them with `send.toHost` ([recipe](./app-messages.md#ask-for-feedback-at-the-end-of-a-call)) |
| Web widget | [Web widget](https://docs.kugelaudio.com/hosted-agents/web-widget) |

Keep your keys out of the code. Put them in `.env`, then send them to the agent with
[`npx curb secrets push`](./deploying.md#curb-secrets-push).

### Turn a workflow into skills

A workflow is a graph the conversation moves through. Curb has no graph: each part of the
conversation is a skill, and React state decides what the model can see and do.

| Workflow part | Curb |
|---|---|
| Subagent node | A skill: `src/agent/<name>/skill.tsx`, holding that node's prompt, documents and tools |
| Subagent's own LLM or voice | `llm`, `stt` or `tts` on the skill's `<Skill>` link |
| Edge with an LLM condition | The `description` of the `<Skill>` link, written as a rule for when to use it |
| Edge with an expression | State: render the tool, text or `<Skill>` link only when the condition holds ([shared state](./state.md)) |
| Ordered steps | `<Procedure>` with `<Step>` ([pattern blocks](./procedures.md)) |
| Update state node | An agent store (`createAgentStore`), set from a tool's `onSubmit` |
| Dispatch tool node | The call itself, inside the `onSubmit` of the tool before it |
| Agent transfer node | A `<Skill>` link to the other agent's rebuilt skill |
| Transfer to number node | `<TransferCallTool>` in that skill |
| End node | `end_call`, with the reason in the skill's instructions |

A model picks its own tools, so a tool you render is not guaranteed to run. When a step must
always happen, do it in code, then check the path with `called()` in a
[scenario](#4-test-it-before-a-caller-reaches-it).

### Move the knowledge base

Curb has no vector search. A file you render with `<Text src="..." />` reaches the model in
full while its skill is loaded, so split documents by topic and put each one in the skill
that needs it. For a knowledge base too large for that, give the agent a `<Tool>` or an
`<Mcp>` server that searches it.

## 3. Choose a voice

ElevenLabs voice clones
[cannot be exported](https://elevenlabs.io/docs/help-center/product/voices/voice-cloning/can-i-export-my-voice-clones.md),
so pick a [KugelAudio voice](https://docs.kugelaudio.com/features/voices) or
[clone the voice again](https://docs.kugelaudio.com/features/voice-cloning), with the speaker's consent.

To compare, run the same agent on your machine with each voice. Set `ELEVEN_API_KEY` in
`.env` and start `npm run dev`:

```tsx
import { elevenlabs, kugelaudio } from "curb/providers";

// Your current voice, for the comparison on your machine:
const current = elevenlabs.tts({ voice: "ELEVENLABS_VOICE_ID" });

// The voice you are moving to:
const next = kugelaudio.tts({ voice: 1887, language: "de" });
```

Pass one of them to `<Agent tts={...}>`, and talk to the agent with each.

Deploy with `kugelaudio.tts()` and `kugelaudio.stt()`. `elevenlabs.tts()` and
`elevenlabs.stt()` open a direct connection, and a hosted agent's traffic has to leave
through [its egress proxy](https://docs.kugelaudio.com/hosted-agents/how-it-runs#what-a-running-agent-can-reach), so
they work on your machine but not in a hosted agent.

## 4. Test it before a caller reaches it

Check that the project builds, then try one turn:

```bash
npx curb check
npx curb say "I want a refund for a damaged order"
```

Turn your ElevenLabs tests and past calls into scenarios for
[`curb test`](./testing.md). Pick calls your old agent handled well and calls it handled
badly, and use the `analysis` of each conversation to find them.

| ElevenLabs test | Curb scenario |
|---|---|
| Simulation | `caller`, with a `goal` and what the caller `knows` |
| Next reply | `turns`, with the exact lines |
| Tool call | `expect`, with `called("tool_name", { ...input })` |
| Mocked tool | `fakes` |

```ts
// src/agent/refund.scenario.ts
import { scenario } from "curb/testing";

export default scenario({
  name: "refund for a damaged order",
  caller: {
    goal: "Get a refund for a damaged order",
    knows: "Order number 48213, name Max Mustermann",
  },
  fakes: { create_refund: { ok: true, message: "Refund created." } },
  expect: ({ called }) => [called("create_refund")],
});
```

A tool runs for real in every scenario, so fake anything that books, sends or deletes.

```bash
npx curb test
```

Then listen. Scenarios run on text, so they cannot show how the agent sounds or how it hears
your callers. [Deploy](./deploying.md) the agent, call it on the
[test line](https://docs.kugelaudio.com/hosted-agents/phone-numbers#call-your-agent-from-your-own-phone), and try the
names, numbers and spellings that matter to your business.

To check how real calls are heard, transcribe a few exported recordings with
[speech to text](https://docs.kugelaudio.com/features/speech-to-text), including noisy calls and spelled names.

## 5. Move your phone numbers

Move one number at a time, starting with your quietest. Connect it, watch its calls on the
agent's **Calls** page and its results on the **Goals** tab, then move the next one. Keep the
ElevenLabs agent until the last number has moved and stayed quiet.

How you move a number depends on how it reaches ElevenLabs today:

| Number today | Move it | Move it back |
|---|---|---|
| Twilio, imported into ElevenLabs | [Connect Twilio](https://docs.kugelaudio.com/hosted-agents/phone-numbers#connect-twilio) and choose the number | **Disconnect** puts back the settings it had |
| Twilio, on an Elastic SIP trunk | Remove the number from the trunk in Twilio, then connect it as above. Calls reach no agent between those two steps, so do it at a quiet hour | **Disconnect**, then add the number to the trunk again in Twilio: the trunk is not part of what KugelAudio saves |
| Telnyx | [Connect Telnyx](https://docs.kugelaudio.com/hosted-agents/phone-numbers#connect-telnyx) and choose the number | **Disconnect** puts back the settings it had |
| Another carrier, or your own phone system | [Not available yet](https://docs.kugelaudio.com/hosted-agents/phone-numbers#your-own-sip-trunk): forward it to a number you [bought from KugelAudio](https://docs.kugelaudio.com/hosted-agents/phone-numbers#buy-a-number) | Remove the forwarding |

If your agent also calls people, those calls need a number bought from KugelAudio, because
your own Twilio and Telnyx numbers cannot place calls yet. See
[outbound calls](https://docs.kugelaudio.com/hosted-agents/outbound-calls).

## What has no equivalent yet

| ElevenLabs | Today |
|---|---|
| Your own SIP trunk | Not available; forward the number as in [step 5](#5-move-your-phone-numbers) |
| Vector search over a knowledge base | Use a search API behind a `<Tool>` or `<Mcp>`, as in [step 2](#move-the-knowledge-base) |
| Post-call webhooks | Send what your systems need from a `<Tool>` during the call, or download calls from the **Calls** page |
| `language_detection` | Set `language: "de,en"` on `kugelaudio.stt()`, and give each language a skill with its own `tts` on the `<Skill>` link |
| `play_keypad_touch_tone` | None: the agent cannot send keypad tones |
| `voicemail_detection` with a message | None: an outbound call that reaches a mailbox reports `VOICEMAIL`, and the agent cannot leave a message on purpose |
| WhatsApp | None |
| Configured guardrails | Write the rule into the prompt, check it again in the tool, and use `confirm` on actions that need the caller's yes |

## Next steps

- [Agents and skills](./agents-and-skills.md): how a Curb project is built.
- [Testing](./testing.md): `curb check`, `curb say` and `curb test`.
