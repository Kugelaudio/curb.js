# The preview

`npm run dev` (i.e. `curb dev`) serves a browser preview on one port and
opens it in your browser (default http://127.0.0.1:4000; it walks to 4001,
4002, … if the port is taken, so several agents run side by side; pass
`--no-open` or set `CURB_NO_OPEN=1` to skip the auto-open). Edits apply on
save: saving a file under `src/`, a `context/*.md` or `.env` reloads the
agent within seconds, without restarting `curb dev` (see
[Editing while it runs](#editing-while-it-runs)). The preview
renders the *same*
compiled tree two ways: as an interactive UI you can operate, and as ONE live
conversation you can hold by typing, talking, or both. It is where you meet,
drive, and debug the agent.

## Editing while it runs

`curb dev` restarts the agent's server process on every save, so the agent you
talk to runs the code on disk, including the helpers your skills import and the
keys in `.env`. The terminal prints one line per reload, naming the file:

```text
 ✓ 14:25:26 dev   reloaded src/agent/agent.tsx in 1.2s
```

- The preview stays on its conversation: it reconnects to the same recorded
  conversation (`.data/conversations.jsonl`), and your next message runs on the new
  code. With recording off (`KUGEL_CONVERSATIONS_DB=off`) it starts a new one.
- A reload keeps the conversation, the skills it has open and its store data
  (`createAgentStore`), and never runs a tool again: a booking or an email your
  agent made happens once, however often you save. When something cannot come
  back (a store or a skill that no longer exists, store fields that are not
  JSON data), a line above the message field says what.
- A reply that is being written finishes first, for at most 30 seconds; a
  longer one is cut off, and the terminal says so. A live call is never cut:
  the reload waits until the call ends, and a line above the message field
  says so. An MCP sign-in you opened holds the reload until the provider
  answers, for at most 5 minutes.
- A finished call's recordings (the audio under its messages and the call
  replay) do not survive a reload.
- An edit that does not load or render (a syntax error, an `AgentAuthoringError`,
  a component that throws) leaves `curb dev` running: the preview shows the
  diagnostic in place of the agent, and the next good save brings it back.
- A `src/` or `context/` folder created while `curb dev` runs is watched from
  then on.
- MCP servers connect again on every reload. When a reload changes the
  conversation store (a `KUGEL_CONVERSATION_SINK` added to or removed from
  `.env`), the terminal names the new one.

## The page

The conversation is on the left and **Agent context** on the right, under a top
bar that names the agent (a picker when the project has several) and shows what
`curb check` finds: **No problems**, or how many problems there are, which opens
them (see [Problems](#problems)).

Nothing in the preview edits the agent; the code under `src/agent/` does, and
**Copy for coding agent** (see below) hands your coding agent a real
conversation to work from.

## Agent context

The **Context** tab shows what the model gets from your code, live:

- **Always available**: the **Instructions** (your `<SystemPrompt>`; the row
  shows its first sentence and opens it in full, with what Curb adds to every
  message: the date and time line and, on calls, the rules for phone calls),
  the agent-wide **Tools**, and the **MCP servers** with their state. A server
  that needs a sign-in shows **Sign in**; one that could not connect says
  **Not connected** and expands to the error.
- **Skills**, as the folders they live in: each top-level skill folder is a
  root, with the folders nested in it beneath. A skill's row shows its
  description and says **In use** (the skill the agent is on), **Read** (in the
  model's context from earlier), **Locked** (its route waits for a condition),
  or what it holds, such as **2 skills · 1 tool**. The chevron in front expands
  it to its own tools, which work only while it is in use, and its sub-skills;
  the row opens it. The skill in use starts expanded.
- **Built in**: what the framework adds on its own, such as ending the call or
  opening a skill.

After each message, what entered the agent's view because of it (a skill it
read, a tool it can call now, changed instructions) carries a **New** mark until
your next message.

Clicking a skill opens its page beside the conversation: its instructions, its
documents, its tools and, for a locked skill, when your agent can open it. The
page of the skill the agent is on is the conversation's own: exactly what the
model gets, including what the conversation changed (a finished procedure, a
sign-in, the tools they unlocked). Every other page comes from the preview's
own copy of the agent, which browsing and test runs use so they never touch the
conversation, and each page says which it is:

- "In use right now: this is what the model gets": the conversation's page.
- "In use from earlier": the agent has the skill from earlier in the
  conversation; the page shows it as written, without the conversation's
  changes.
- "Not in use right now": the agent reads the skill when the conversation needs
  it.

On a page, a `<Procedure>` renders as a stepper whose button advances it one
step, the same transition the model would drive. Knowledge (`<Text>`, plain JSX
text) renders as readable documents, and the system prompt and every multi-line
`<Instruction>` and `<Text>` render as formatted text: paragraphs, headings,
lists and line breaks, the structure the model reads (see "Writing prose" in
`authoring.md`).

The address bar follows what is open, so a link opens the same view:
`/skill/<path>` a skill's page, `/graph` the graph, `/system-prompt` the
instructions, `/tools` the tools and `/diagnostics` the problems.

## Trying a tool

**Try** beside a tool opens a form built from its schema: a field per input,
labelled with its name, its description as help, marked optional where it is.
A tool with `tryWith` (see `authoring.md`) opens with those values filled in.
When the agent called the tool in this conversation, **Use these** fills in the
arguments it used. **Run** runs the tool's `onSubmit` once with your values,
exactly as if the model had called it, and shows what it returned, or why it
failed, and how long it took. The run uses the preview's own copy of the
agent's state, so it changes neither your agent nor the conversation; from then
on that skill's page shows the copy, and **Undo last try** on the page takes the
run back. If the tool's code calls an outside service, that call is real.

A tool the conversation unlocked cannot be tried, because test runs go to the
copy, where it is still locked; ask the agent to use it instead.

So you can reproduce and debug any tool call yourself, without talking, and
watch the agent's state change the way it would mid-conversation.

## The graph

**Graph**, above the agent's context, opens a large view that starts at your
agent and draws the skills it can open, from the live context and the routes in
your code. The skill in use is highlighted. A dashed connector is a route that
exists in the code but is locked until its condition holds, and its label names
the condition. Click a skill to open its page, or the agent to read its
instructions. An agent without skills has no graph, so it shows no button.

## The conversation

There is ONE conversation: one transcript, one session, one authored system
prompt. Type into the composer, or press **Start call** to attach voice
(your real microphone, real speech) to the same thread: spoken and typed turns land
in the same transcript and share all agent state. During a call the bar shows
how long it has run and whether your agent is speaking or listening, the
microphone button mutes you and its menu switches the input device, and **End
call** hangs up. Keep typing and the conversation continues. While a call is
live, typed messages run through the voice pipeline too, so the agent speaks
its answer.

The title in the conversation header opens recent preview conversations, and
**New conversation** starts one. A new conversation gets a fresh runtime and
session; selecting an earlier one restores its transcript and agent state (the
skills it had open, its store data) without running any of its tools again, so
you can continue it.

- **What the agent did**, in order inside its turn: "Opened skill" for a skill
  it read, and a row per tool call with its first arguments and its outcome,
  which expands to the full arguments and result.
- **What the model read**, under the newest reply (and under older ones on
  hover), with play and copy: the exact input of the model call that wrote the
  reply, its instructions, every message and the tools, downloadable as JSON.
  This is the ground truth for "what did the model actually see" and the
  fastest way to explain a wrong answer.
- **Rewind** in both modes: **Retry from here** under your message, **Go back
  to this reply** under the agent's, to retry a prompt or a routing decision.
- **Live transcription** of what you are saying, as you say it (on a call).
- **Per-message audio**: on call turns, replay exactly what was heard and said,
  your captured mic audio under your messages and the agent's speech under its
  replies. On typed turns, play synthesizes the reply once with the configured
  voice.
- **Synchronized call replay**: microphone and agent audio are combined into
  one seekable timeline that preserves pauses, overlap, and interruptions.
  Play, scrub, or download the complete call as one WAV.
- **Interruptions** as on a real call: talk over the agent and it stops, and
  its model history is trimmed to the words that actually played. The
  generated but unheard continuation stays visible, muted, for debugging.

The system prompt stays singular: what you author is what both modes use. On
spoken turns the framework appends its spoken-reply delivery rules at
runtime; you never write those yourself, and typed turns never see them.

## Problems

The `curb check` output (unreachable skills, duplicate tools, missing routing
descriptions, oversized skills …) lives in the preview: the top bar says how
many problems there are and opens them, each with a location, a concrete fix
and a copy button for your coding agent. The same output appears in the server
startup log; after a reload the terminal line counts the errors instead.

## Copy for coding agent

**Copy for coding agent** in the conversation header copies a coding-agent-ready
transcript of the conversation, together with the skill map and the tools, so you
can hand a real session to a coding agent to improve the agent from what
actually happened.

The transcript carries the system prompt this conversation sent to the model. A
conversation restored from the list that has not had a turn since carries the
prompt the store recorded for it. When there is none (the conversation never
reached the model, or was recorded before prompts were), it carries the prompt
in the code now, headed "System prompt (current code)", because the
conversation may have run with a different one.

## Recorded conversations

By default every conversation is written to `.data/conversations.jsonl`
in the project: each message with its time and kind (what the caller
said, a context event, or input the framework generated), each tool call with
its input and result, the context diff it caused, the system prompt the
conversation's model calls carried, and what continuing it needs (the skills it
has open, its store data and its page info), updated after every turn. The file
is append-only, one JSON record per line (`{"t":"conversation",...}`,
`{"t":"message",...}`, `{"t":"system_prompt",...}`, `{"t":"state",...}`), and a
later record for the same message, prompt or state replaces the earlier one when
the file is read. Read it with `curb conversations`, `jq` or any editor for a
durable record beyond the live preview.
`KUGEL_CONVERSATIONS_DB` moves the file (a path relative to the directory the
server runs in) or turns recording off (`off`).

If the server stopped in the middle of a write, the cut-off last line is dropped
the next time the file opens, with a warning naming its line; every record
before it is kept. Any other line that is not a record stops the server with the
file and line number, so fix or delete that line, or move the file away to start
a new history. An older curb recorded to `.data/conversations.db`; that file is
not read (the startup log says so once) and can be deleted.

The conversation list behind the conversation title reads this file:
it offers the 20 most recent recorded conversations, plus the ones started on
the current connection. It is read once when the preview connects, so reload
the page to see conversations recorded since.

The server's startup log names the store in force, in one line:

```text
conversation store: JSONL /path/to/my-agent/.data/conversations.jsonl
conversation store: sink /path/to/my-agent/lib/conversation-sink.ts (KUGEL_CONVERSATION_SINK)
conversation store: off (KUGEL_CONVERSATIONS_DB=off)
```

### Recording to your own store

To send transcripts somewhere else, set `KUGEL_CONVERSATION_SINK` to a module
in your project (an absolute path, or one relative to the project root) whose
default export is a `ConversationSink`:

```ts
// lib/conversation-sink.ts
import type { ConversationSink } from "curb";
import { db } from "./db"; // your own client; curb adds no driver

const sink: ConversationSink = {
  // Return a stable id. `metadata` is the session info your host sent with
  // `set_info`, read when the first message starts the conversation.
  async startConversation(agentId, metadata) {
    return db.insertConversation({ agentId, metadata });
  },
  // MUST replace the message already stored at (conversationId, seq).
  async recordMessage(conversationId, seq, message) {
    await db.upsertMessage({ conversationId, seq, message });
  },
  // Optional: the system prompt the conversation's model calls carried. Called
  // again whenever it changes, and replaces the one stored before.
  async recordSystemPrompt(conversationId, systemPrompt) {
    await db.setSystemPrompt({ conversationId, systemPrompt });
  },
  // Optional: what continuing the conversation needs (open skills, store data,
  // page info), as plain JSON. Called when it changes; replaces the one before.
  async recordState(conversationId, state) {
    await db.setState({ conversationId, state });
  },
};

export default sink;
```

```bash
KUGEL_CONVERSATION_SINK=./lib/conversation-sink.ts npx curb server
```

The server imports the module at startup, so a wrong path or a module without
that default export fails the boot rather than recording nowhere. While a sink
is registered nothing is written to or read from `.data/conversations.jsonl`: the
conversation list then shows only the conversations started on the current
connection, and reading older transcripts is up to your store.

### When the store fails

The transcript is a record; the call is the product. A write your sink
rejects never fails the turn or drops a live call. It is not dropped either:

- Each rejection is logged at error level with the conversation id (once the
  sink has issued one) and the attempt number, and the message stays pending.
- Pending messages are retried, in order, on the next change to the
  transcript, and once more when the session ends: when the connection that
  owns it closes, or when a call served by a `curb build` artifact ends. A
  direct-join or managed runner waits at most 10 seconds for that last attempt
  before ending the call, and logs it if it gave up waiting.
- Whatever the sink still rejects then is logged at error level with the
  conversation id and the number of messages lost. That transcript is
  incomplete in your store.

What your sink has to guarantee, because of those retries:

- `recordMessage` upserts on `(conversationId, seq)`. A retry can repeat a
  write that actually landed, and a barge-in rewrites a message that is
  already stored; both must replace it, never add a second row.
- `startConversation` is retried only after it rejected, so a rejection must
  mean no conversation was created.
- Calls for one session never overlap and arrive in `seq` order, so a write
  that keeps failing holds back the ones after it. curb puts no timeout on a
  call; bound your own.
