# Voice sessions

Curb runs the voice session itself, and it is the same session on every route:

| Route | Started by |
|---|---|
| Browser voice in the preview | `npm run dev` (`curb dev`) |
| LiveKit worker | `npm start` (`curb start`) |
| Built artifact | `curb build`, then its entrypoint in worker, direct-join or managed mode ([Hosting a Curb agent yourself](./hosting.md#built-artifact-curb-build)) |

A project holds no voice session code. What the session does is set where the agent is
authored:

| Setting | Where |
|---|---|
| LLM, speech-to-text, text-to-speech | `<Agent llm stt tts>`, overridden by the active `<Skill>` (see [Agents and skills](./agents-and-skills.md)) |
| Who speaks first | `defineAgent({ firstTurn })`: `"user"` (the default), `"agent"`, or `{ say }` for exact words |
| Endpointing and the silence check-in | `VOICE_ENDPOINTING_MIN_MS` (300), `VOICE_ENDPOINTING_MAX_MS` (3000), `VOICE_SILENCE_FOLLOWUP_MS` (6000) in `.env` |
| Azure segmentation silence | `azure.stt({ segmentationMs })` |
| Anything else in the LiveKit session | `defineAgent({ pipeline })` ([Override the LiveKit pipeline](./livekit-pipeline.md)) |

A changed prop applies from the next render, mid-call included: the session swaps its
speech providers when the tree renders others. `curb dev` applies a saved `.env` (and saved
code) by reloading the agent once no call is live; `curb start` reads the environment when
it starts.

## Change how a call runs

| To change | Use |
|---|---|
| Who opens the call, and in which words | `defineAgent({ firstTurn })` |
| The order of a conversation | `<Procedure>` with `<Step>`s |
| What needs the caller's yes | `<Tool confirm>` |
| Which skill runs next, from code | `useRouter().push(path)` |
| Steps per turn | `defineAgent({ maxSteps })` |
| History the model reads | `defineAgent({ maxTranscriptMessages })` |
| Skills open at once | `defineAgent({ maxLoadedSkills })` |
| When a turn is over | `VOICE_ENDPOINTING_MIN_MS`, `VOICE_ENDPOINTING_MAX_MS` in `.env` |
| The silence check-in | `VOICE_SILENCE_FOLLOWUP_MS` in `.env` |

## How a call opens

As soon as the caller is in the room, before any turn runs, the conversation's info carries:

| Key | Value |
|---|---|
| `caller.identity` | the caller's LiveKit participant identity |
| `caller.phoneNumber` | the number a SIP caller dialed in from; absent otherwise |

A call LiveKit dispatched to a worker (`curb start`, a built artifact in worker mode)
also carries its job, set before the session starts:

| Key | Value |
|---|---|
| `call.roomName` | the LiveKit room |
| `call.jobId` | LiveKit's job id |
| `call.metadata` | the dispatch's metadata, as sent (an explicit dispatch's per-call data); absent when empty |

A call a host placed with a `clientContext` (a hosted platform's web widget or session API,
or your own host, see [Hosting a Curb agent yourself](./hosting.md)) also carries what the caller's page said about the
call, set before the session starts:

| Key | Value |
|---|---|
| `client.<key>` | the start request's `clientContext.<key>`, always a string; absent when the page sent none |

Every hosted or dispatched call also carries `call.direction`: `outbound` when the host dialed the caller (the start request's `direction`), else `inbound`; a LiveKit dispatch always reads `inbound`.

A call a host placed with `experiments` (a hosted platform assigns them from the agent's
`defineAgent({ experiments })`) also carries the variant it got in each, set before the
session starts. Unlike `client.*`, the host assigned it, so it is trusted:

| Key | Value |
|---|---|
| `experiment.<name>` | the start request's `experiments.<name>`, the variant's name; read it with `useVariant(name)` |

Read them with `useAgentInfo((info) => info["caller.phoneNumber"])`. The caller is the
first participant who is a person, a phone line or a connector; another agent or a
recorder in the room is not. Do not log phone numbers or other caller data.

## The call's identity

`useSession().call` is set on every route. Read the call's identity there, never from
`process.env`:

| Route | `call.sessionId` | `call.scratchDir` |
|---|---|---|
| Managed runner | the start request's `sessionId` | a directory of its own, removed when the call ends |
| Direct join | `CURB_SESSION_ID`, else the room name | a directory of its own, removed when the call ends |
| LiveKit worker (`curb start`, built artifact) | the room name | a directory of its own, removed when the call ends |
| `curb dev` | the preview conversation's id (`preview-…`), typed or spoken; a rewind keeps it | absent |

## Ending a call from the agent side

The voice session gives the model the `end_call` tool by registering a hang-up for the
call. The registration is what makes the tool exist: it is compiled into the model's
context while a voice call is attached and removed when the call ends. A conversation
without voice (typed preview chat) has no `end_call`, and the model is not told about it
either.

The tool fires mid-turn, before its `goodbye` is said: the session says the goodbye once
the tool ran, as the end of the same reply. A model that wrote the goodbye as text in the
same step has said its first sentences by then; the session says only the rest, so the
caller hears no sentence twice. So the disconnect waits for that reply's
`waitForPlayout()`, LiveKit's own signal that every frame of the reply has been handed to
the published track. It is the same signal that decides whether a reply is committed whole
or truncated to the words that actually played, so a goodbye is never cut off, and a user
who talks over the closing line cancels the hang-up instead of being hung up on. The model
then reads that the call is still on, in its context, until it calls `end_call` again. That
cancellation happens once per call: a second `end_call` hangs up after its goodbye even if
it is talked over too, so a voicemail menu or an announcement that never stops talking
cannot hold the call open. The receiver's own jitter buffer (tens of
milliseconds after the last frame leaves the agent) is not observable from this side and
is not compensated for with a timer.

After the disconnect the session closes normally: the room is left, and a hosted
single-call runner reaches the end of its work and exits 0, the ordinary "completed"
outcome, with no separate signal.

## When the model talks about a tool instead of calling it

A model on a call sometimes says what it is doing without doing it. The session catches
two forms:

- **A tool call written as words.** A spoken step whose text names one of its tools
  (`add_to_list(reason=...)`) is never said from the name on. A typed reply is not
  filtered. The model is asked once
  more, with a note that the reply was not said; a second such step ends the turn with
  the fixed apology. Only names nobody says in a sentence are matched: ones with an
  underscore, a digit or an inner capital.
- **An action announced, then not taken.** After a spoken turn that ends on a statement
  ("I'm removing you from our list now.") rather than a question, the session asks the
  model once whether that reply spoke of something one of its tools does without calling
  it. An offer or a suggestion ("I can show you a demo.") is not an action yet and gets
  no call, and neither is an answer or a description of how something works. The check
  offers only the agent's own tools that have not run in that turn, a confirmed action
  included, so it never repeats or retries one; a turn with nothing left to offer is not
  checked. It offers `end_call` only once one of the agent's own tools succeeded in that turn
  ("You are off the list. Goodbye."), and the call then hangs up after the words already
  said, without a second goodbye. After a turn that only answered, or whose tool call was
  refused, the check cannot hang up, so a reply it misreads as a goodbye never cuts the
  caller off. A tool call in the answer runs as
  part of the same turn, unless its input carries a long number (six digits or more as
  written, leading zeros included, like `+1 (202) 555-0142` or `012345`: a phone, order or
  account number) that the conversation never contained: the check made that up, so the call
  is dropped. Numbers are compared whole. In a phone field (its name, or its schema's
  `format` or description, says phone, tel, mobile or cell) the same number may be written
  with or without its country code or leading zero (`+49 30 123456`, `030 123456`); any
  other field, an order or account number, matches only digit for digit, as written.
  Dates are not checked. Anything else the check writes is dropped, unsaid and out of the
  transcript. That is one more LLM request on those turns, counted
  in the usage `curb test` reports. It starts once the reply's last words have gone to
  speech. A check that fails or times out is logged and leaves the turn answered.

## Failure behavior

`curb start` fails before registering when a LiveKit credential is missing, naming it. A
dispatched job whose room has no name fails, saying so. A call whose voice session cannot
start (a provider key missing, for example) fails with the cause, and its conversation
recording is still finished. Closing a call attempts every cleanup step and logs whatever
it left behind; a failed cleanup never ends the process.

## Upgrade a project with `src/orchestration/`

Projects scaffolded before this change carry `src/orchestration/agent.ts`, `session.ts` and
`worker.ts`. No route loads them any more, and `curb check` warns
`AGENT_ORCHESTRATION_IGNORED`. Delete the directory, then:

- Move voice settings to the places in the table above.
- If `worker.ts` exported an `agentName` other than the project's package name, set
  `CURB_AGENT_NAME` to it so LiveKit dispatch keeps finding the worker.
- The info keys `worker.ts` set keep working, now set by the framework (see below).

## Next steps

- [Self-hosting](./hosting.md): run the session on your own servers.
- [Architecture](./architecture.md): what runs where.
