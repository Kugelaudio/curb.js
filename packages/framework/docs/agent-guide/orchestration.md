# Voice sessions and production hosting

Curb runs the voice session itself, and it is the same session on every route:

| Route | Started by |
|---|---|
| Browser voice in the preview | `npm run dev` (`curb dev`) |
| LiveKit worker | `npm start` (`curb start`) |
| Built artifact | `curb build`, then its entrypoint in worker, direct-join or managed mode (see `docs/hosting.md`) |

A project holds no voice session code. What the session does is set where the agent is
authored:

| Setting | Where |
|---|---|
| LLM, speech-to-text, text-to-speech | `<Agent llm stt tts>`, overridden by the active `<Skill>` (see [authoring.md](./authoring.md)) |
| Who speaks first | `defineAgent({ firstTurn })`: `"user"` (the default), `"agent"`, or `{ say }` for exact words |
| Endpointing and the silence check-in | `VOICE_ENDPOINTING_MIN_MS` (300), `VOICE_ENDPOINTING_MAX_MS` (3000), `VOICE_SILENCE_FOLLOWUP_MS` (6000) in `.env` |
| Azure segmentation silence | `azure.stt({ segmentationMs })` |

A changed prop applies from the next render, mid-call included: the session swaps its
speech providers when the tree renders others. `curb dev` applies a saved `.env` (and saved
code) by reloading the agent once no call is live; `curb start` reads the environment when
it starts.

## A project with `src/orchestration/`

Projects scaffolded before this change carry `src/orchestration/agent.ts`, `session.ts` and
`worker.ts`. No route loads them any more, and `curb check` warns
`AGENT_ORCHESTRATION_IGNORED`. Delete the directory, then:

- Move voice settings to the places in the table above.
- If `worker.ts` exported an `agentName` other than the project's package name, set
  `CURB_AGENT_NAME` to it so LiveKit dispatch keeps finding the worker.
- The info keys `worker.ts` set keep working, now set by the framework (see below).

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
or your own host, see `docs/hosting.md`) also carries what the caller's page said about the
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

### `client.*` is written by the page

`useClient()` reads these keys as one object without the prefix,
`const { email, event } = useClient()`; a key the page did not send is `undefined`.
Whoever can edit a link or a page can set `client.*` to anything, so:

- Use it to prefill and to skip a question the page already answered (a logged-in
  visitor's email), never for access, identity or prices. No locked branch, skill, tool
  or account data depends on a `client.*` value; to know who the caller is, ask, or check
  in a tool against your own system.
- Treat it as untrusted text. Look a value up in a table you own rather than rendering it,
  so an unknown value renders nothing. When you do render one, quote it, keep it short, and
  render only the keys the agent needs.
- It may be absent: a visitor from another page, a link without its parameters, a context
  the host refused. The agent must work without it.

```tsx
import { Text, useClient } from "curb";

// Your own words for the events your links name. Any other value renders nothing.
const EVENTS: Record<string, string> = {
  "webinar-11-04": "the webinar on 4 November",
  "webinar-11-17": "the webinar on 17 November",
};

export function EventContext() {
  const { event } = useClient();
  const words = EVENTS[event ?? ""];
  return words ? <Text>The caller came from the page of {words}. Mention it in the greeting.</Text> : null;
}
```

With `firstTurn: "agent"` the agent greets once the caller is there. With
`firstTurn: { say }` it opens with exactly that line instead, with no model call, written
from the info above when `say` is a function ([authoring.md](./authoring.md), "Who speaks
first"). Neither opening can be interrupted: the caller hears the whole opening line, speech
during it is not taken as a turn, and a message typed during it is answered once it has
played. A call attached to a conversation that already has turns (typing in the preview
before starting the call) does not open it with the line again.

## The call's identity

`useSession().call` is set on every route. Read the call's identity there, never from
`process.env`:

| Route | `call.sessionId` | `call.scratchDir` |
|---|---|---|
| Managed runner | the start request's `sessionId` | a directory of its own, removed when the call ends |
| Direct join | `CURB_SESSION_ID`, else the room name | a directory of its own, removed when the call ends |
| LiveKit worker (`curb start`, built artifact) | the room name | a directory of its own, removed when the call ends |
| `curb dev` | the preview conversation's id (`preview-…`), typed or spoken; a rewind keeps it | absent |

## Run the hosted worker

Before building for a hosting platform, declare every runtime environment
variable the agent cannot operate without in the project's `package.json`:

```json
{
  "curb": {
    "requiredRuntimeSecrets": [
      "KUGELAUDIO_API_KEY"
    ]
  }
}
```

`curb build` writes these names to `curb.bundle.json` as required runtime secrets. It
does not read or copy their values. Deployment readiness and every new call then fail
before a runner starts when the selected environment cannot resolve one. List what this
project actually uses; curb does not infer credentials from the agent's providers. Omit
the key only when the project has no required runtime secrets.

List `AZURE_SPEECH_KEY` too with `azure.stt()`, and `ANTHROPIC_API_KEY` with `anthropic()`.
Azure Speech uses `eastus` when `AZURE_SPEECH_REGION` is unset; set that variable only when
the key belongs to another region.

Set the LiveKit server or Cloud project credentials in `.env` or in the
hosting platform's secret store:

```bash
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

Read secrets and provider keys lazily, at first use or per call, never at module
import. A host may start the agent process before it serves any call (a pre-warmed
runner, or one restored from a snapshot), so a value captured when a module loads
can be missing or belong to an earlier configuration by the time a call arrives:

```ts
// Wrong: captured once, when the module is imported.
const apiKey = process.env.CRM_API_KEY;

// Right: read where it is used.
async function lookupCustomer(id: string) {
  const apiKey = process.env.CRM_API_KEY;
  if (!apiKey) throw new Error("CRM_API_KEY is not set");
  // ...
}
```

Start the long-running production worker with:

```bash
npm start
```

This runs `curb start`, which registers the framework's LiveKit worker in production
mode. It does not start the preview or the browser-facing development server. The worker
registers under:

1. `CURB_AGENT_NAME`, when it is set;
2. otherwise the `name` in the project's `package.json`;
3. otherwise `curb-agent`.

A built artifact in worker mode registers under the same name: `curb build` bakes the
package name in, and `CURB_AGENT_NAME` still overrides it. Configure room dispatch or a
LiveKit SIP dispatch rule to target that exact name. For
phone calls, LiveKit SIP and trunk setup remain infrastructure outside curb. LiveKit runs
each dispatched call in a job process of its own, which serves it as described above and
ends when the call does.

When `curb start` serves a management port (`CURB_MANAGEMENT_ADDR` and
`CURB_MANAGEMENT_TOKEN`), every call is registered on it under its room name, the agent's
`useSend().toHost` reaches the events stream, and the host can send messages, change
settings and end the call. See `docs/hosting.md` ("Management port in dev and worker
mode").

## Ending a call from the agent side

The voice session gives the model the `end_call` tool by registering a hang-up for the
call. The registration is what makes the tool exist: it is compiled into the model's
context while a voice call is attached and removed when the call ends. A conversation
without voice (typed preview chat) has no `end_call`, and the model is not told about it
either.

The tool fires mid-turn, before its `goodbye` is said: the session says the goodbye once
the tool ran, as the end of the same reply. So the disconnect waits for that reply's
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

## Failure behavior

`curb start` fails before registering when a LiveKit credential is missing, naming it. A
dispatched job whose room has no name fails, saying so. A call whose voice session cannot
start (a provider key missing, for example) fails with the cause, and its conversation
recording is still finished. Closing a call attempts every cleanup step and logs whatever
it left behind; a failed cleanup never ends the process.

## Scripts: `curb/orchestration`

The `curb/orchestration` entry keeps its server-only exports for scripts that drive an
agent themselves, for example `createVoiceAgentBundle()`, which builds the curb half of a
conversation. Curb never loads project code through it.
