# Host protocol

This page is for whoever builds a host: the program that runs a Curb runner on your own servers.
Its routes are the runner's own, and only that program reaches them. Building an app or a backend
that talks to an agent? Start with [Connecting to a running agent](./connecting.md). On KugelAudio,
the platform is the host and you use its API instead.

A host starts a built agent, gives it calls and follows them over this HTTP protocol.
[Self-hosting](./hosting.md) covers when you need it.

Curb owns this protocol; nothing in it is specific to any one host. The Zod schemas in
`src/hosted/protocol.ts` are the source. `src/hosted/protocol.schema.json` is the same
contract as one JSON Schema 2020-12 document (every type under `$defs`) for hosts written
in other languages, and `src/hosted/protocol-fixtures/{valid,invalid}/<Type>.<case>.json`
are examples every implementation must accept or refuse.

## Runner environment

| Variable | Meaning |
|---|---|
| `CURB_MANAGEMENT_ADDR` | `host:port` to listen on. Absent means not managed. Port `0` binds a free port; the ready line reports the bound one. |
| `CURB_MANAGEMENT_TOKEN` | Per-runner bearer token. Required when the address is set; without it the runner refuses to open the port. Use one token per runner, never one per fleet. |
| `CURB_MAX_SESSIONS` | Concurrent calls this runner takes. Default `1`. Read once, at boot (see "Several calls in one runner"). |
| `CURB_RUNNER_ROLE` | `hooks` for a [hook runner](./hosting.md#hook-runner). `calls` or absent means a runner that takes calls. Anything else stops it at startup. |
| `CURB_DEPLOYMENT_ID` | Optional generation pin: which deployment this runner is. |
| `CURB_CONFIGURATION_VERSION` | Optional generation pin, a positive integer. |

Provider keys for the agent's STT, LLM and TTS are ordinary environment variables of the
runner process. A start request never carries secrets.

## The ready line

Once warm, the runner prints one line on stdout. Hosts may rely on its exact prefix:

```text
curb-hosted {"event":"ready","address":"127.0.0.1:7071","maxSessions":1,"warmupMs":812}
```

That is `curb-hosted`, a space, then a `LifecycleReady` JSON object with `event` as its
first key. Every lifecycle record is also printed this way. A runner whose warmup fails
never prints `ready` and exits non-zero.

## Routes

`GET /health` needs no auth and answers `200 {"ok":true,"protocolVersion":1,"versions":[1]}`.
Every other route needs `Authorization: Bearer <token>`, else `401 {"error":"unauthorized"}`
(checked before anything else, so an unauthenticated caller learns nothing). A path not
under `/v1/` answers `404 {"error":"unknown_version","detail":...,"versions":[1]}`.

| Route | Success | Errors |
|---|---|---|
| `GET /v1/runner` | 200 `RunnerStatus` | |
| `GET /v1/sessions` | 200 `{sessions: LiveCall[]}` | |
| `GET /v1/sessions/{id}` | 200 `LiveCall` | 404 `session_not_found` |
| `POST /v1/sessions` (body `StartCallRequest`) | 202 `{sessionId, accepted}` | 400 `invalid_request`, 409 `runner_at_capacity`, 409 `generation_mismatch`, 503 `runner_draining`, 500 `start_failed`, 501 `runner_takes_no_calls` |
| `DELETE /v1/sessions/{id}?reason=&graceMs=` | 202 `{sessionId, stopped}` | 400 `invalid_request` |
| `POST /v1/sessions/{id}/messages` (body `HostMessage`) | 202 `{id, delivered}` | 400 `invalid_request`, 404 `session_not_found`, 409 `runner_at_capacity`, 422 `no_handler` / `invalid_payload` / `handler_failed`, 501 `runner_takes_no_calls` |
| `PATCH /v1/sessions/{id}` (body `SessionUpdate`) | 200 `{sessionId, settings: EffectiveSettings}` | 400 `invalid_request`, 403 `not_adjustable`, 404 `session_not_found`, 422 `invalid_settings`, 501 `runner_takes_no_calls` |
| `POST /v1/runner/drain` | 202 `{draining: true, activeSessions}` | |
| `GET /v1/runner/events?from=N` | 200 NDJSON stream | 400 `invalid_request`, 410 `cursor_too_old`, 503 `no_journal` |
| `POST /v1/hooks/{name}` (body `HookRunRequest`) | 202 `{runId, accepted: true}` | 400 `invalid_request`, 404 `hook_not_declared`, 413 `payload_too_large`, 501 `runner_takes_no_hooks`, 503 `runner_draining` |
| `GET /v1/hooks/runs/{runId}` | 200 `HookRunStatus` | 404 `hook_run_not_found`, 501 `runner_takes_no_hooks` |
| anything else | | 404 `not_found` |
| a handler failed | | 500 `internal` |

Shapes (all in `protocol.schema.json`):

- `StartCallRequest` = `{sessionId, realtimeUrl, realtimeToken, deploymentId?, configurationVersion?, clientContext?, direction?, experiments?}`.
  Strings are non-empty; `configurationVersion` is a positive integer. Unknown fields are
  ignored. `deploymentId` and `configurationVersion` are each compared only when both the
  runner and the request state them; a mismatch is `409 generation_mismatch`.
- `clientContext` is what the caller's page or app said about this call, one string per key
  (`{"event": "webinar-11-04"}`); anything else is `400 invalid_request`. The call's agent
  reads each entry as `client.<key>`, set before its session starts, so the greeting can use
  it ([agent guide](./voice-sessions.md#how-a-call-opens)). Per call, never in the
  environment. Curb passes it on as sent: your host decides its limits, and since a browser
  wrote it, never an identity or a permission.
- `direction` is `outbound` when your host dialed the caller, `inbound` (the default) otherwise; the agent reads it as `call.direction`.
- `experiments` is the variant your host assigned this call in each of the agent's
  experiments (the bundle manifest's `experiments`), experiment name to variant name
  (`{"greeting": "casual"}`), one string per key like `clientContext`. The agent reads each as
  `experiment.<name>` (`useVariant(name)`), set before its session starts. The runner trusts
  it and applies it as sent. To assign as Curb does locally (`curb dev`, `curb test`): a
  `fromClient` key in `clientContext` whose value names a variant picks it; otherwise the
  first 8 bytes of SHA-256(`<sessionId>:<experiment>`), read as a big-endian unsigned 64-bit
  integer, modulo the sum of the weights, walked down the variants sorted by name, picks the
  first variant whose weight is larger than what is left.
- `accepted: false` means an idempotent repeat of a call the runner already holds.
- `stopped: false` means the runner held no such call. Still a success, so a retried stop
  never turns into an error.
- `graceMs` is an integer from 0 to 60000 (default 0): how long to let the agent finish
  its current utterance before leaving the room.
- `RunnerStatus` = `{protocolVersion: 1, role?, deploymentId?, configurationVersion?, maxSessions, activeSessions, draining, sessions: LiveCall[]}`. `role` is `hooks` on a hook runner and absent otherwise.
- `LiveCall` = `{sessionId, state: "starting" | "connected" | "ending" | "ended", startedAtMs}`.
- `SessionUpdate` and `EffectiveSettings`: see [Live session settings](#live-session-settings).
- `HookRunRequest` = `{runId, event, deadlineMs}`. `runId` is 1 to 128 characters. `event` is a
  `CallEvent`: `afterCall` takes `call.ended` and `afterEvaluation` takes `call.evaluated`,
  anything else is `400 invalid_request`. Fields this build does not know reach the hook
  as sent. `deadlineMs` counts from when the runner accepts the run, a positive integer of
  at most 2147483647. The body is limited to 2 MiB.
- `HookRunStatus` = `{runId, state: "running" | "succeeded" | "failed", error?: {message}}`.
  `error.message` is `timeout` past the deadline.
- In dev and worker mode, `POST /v1/sessions`, `GET /v1/runner` and `POST /v1/runner/drain`
  answer `501 runner_takes_no_calls` (see above).

## Error codes

Every non-2xx body is `ErrorBody` = `{error, detail?, versions?, requested?, oldestRetained?, path?, issues?}`.
Classify by `error`, never by `detail`, which is prose for humans.

`unauthorized`, `unknown_version`, `not_found`, `invalid_request`, `session_not_found`,
`runner_at_capacity`, `generation_mismatch`, `runner_draining`, `start_failed`,
`runner_takes_no_calls`, `cursor_too_old`, `no_journal`, `internal`, `no_handler`,
`invalid_payload`, `handler_failed`, `not_adjustable`, `invalid_settings`,
`runner_takes_no_hooks`, `hook_not_declared`, `hook_run_not_found`, `payload_too_large`.

`runner_draining` (503) means "place this call on another runner"; `runner_at_capacity`
and `generation_mismatch` (409) mean "this runner cannot take it". Runners older than
protocol v1 answered some 404s with prose in `error`; treat any 404 on
`POST /v1/sessions` as a protocol-version mismatch. `no_handler`, `invalid_payload` and
`handler_failed` (422) mean the call is there and its agent refused that message (see
"App messages"); `invalid_payload` carries the schema's `issues` as `[{path, message}]`.
`not_adjustable` (403, with `path`) and `invalid_settings` (422, with `issues`) refuse a
settings change as a whole (see "Live session settings").

## Event stream

`GET /v1/runner/events?from=N` streams everything the runner has to say as NDJSON
(`content-type: application/x-ndjson`), one `JournalRecord` per line:

```json
{"envelope":1,"producer":"runner","seq":1,"class":"lifecycle","at":1790625584758,"body":{"event":"ready","address":"127.0.0.1:7071","maxSessions":1,"warmupMs":185}}
```

- `envelope` is runner-wide, gapless and positive: the resume cursor. `from` is
  **exclusive**, so reconnect with the last envelope you processed; `from=0`, the
  default, replays everything until the runner has dropped the first envelope, then answers 410.
- `producer` + `seq` identify a record within its producer, for deduplication and for
  spotting a record lost before it reached the stream.
- `at` is milliseconds since the Unix epoch.

Record classes:

| `class` | `producer` | `body` |
|---|---|---|
| `conversation` | the session id | `{type: "turn", seq, at, speaker: "caller" \| "agent", text, final}` or `{type: "event", seq, at, kind: "curb.<name>", durationMs?, payload}` |
| `lifecycle` | `runner` | `{event, ...}`: `ready{address, maxSessions, warmupMs}`, `call-started{session, room}`, `call-stopping{session, reason}`, `first-audio{session, monotonicMs, sinceStartMs}`, `draining{signal?, active}`, `ended{reason}` |
| `host` | the session id | `{type: "host", seq, at, id, name, payload, expectsReply, inReplyTo?}`, a message from the agent to its host |

**What a call's record contains.** Besides the turns and the `host` records, every call
that keeps a record (a managed or direct-join runner, `curb dev` / `curb start` with a
management port) writes these `conversation` events. A plain self-hosted call with no
record writes none of them.

| `kind` | When | `payload` |
|---|---|---|
| `curb.tool` | every tool call, when it ends | `{name, arguments, ok, skillPath?, heldFor?}`; `durationMs` is how long the handler ran |
| `curb.skill` | the active skill changed | `{action: "loaded" \| "exited", path, title?}` |
| `curb.procedure` | a `<Procedure>` moved | `{action: "started" \| "step_completed" \| "completed" \| "left", title, step, steps, stepTitle?, stepTitles?}`; `stepTitles` is every step's title, on `started` |
| `curb.transfer` | a transfer request got its outcome | `{outcome: "answered" \| "no_answer" \| "busy" \| "failed" \| "refused"}`; `durationMs` is the time since the request. Never the number dialed |
| `curb.transfer_handed_off` | the transfer target is on the line and the agent stays quiet | `{}` |
| `curb.transfer_resumed`, `curb.transfer_ended_call` | the target left: the agent has the call back, or the transfer ended the call | `{}` |
| `curb.message_to_client` | every `useSend().toClient` message that left for the caller's app | `{key, id, payload, truncated?}` |
| `curb.reply_to_client` | every reply the agent gave to the app's `curb.message` RPC (an `ask`) | `{key, id, reply, truncated?}` |
| `curb.messages` | once, just before `curb.ended`, only when something is non-zero | `{undeliveredToClient: {[key]: n}, refusedQueuedHostMessages: n}` |
| `curb.ended` | last | `{reason}` |

`payload` and `reply` are kept as they were sent while their JSON is at most 4 KiB; a larger
one is kept as the first 4 KiB of its JSON text, as a string, with `truncated: true`.
`undeliveredToClient` counts `toClient` messages no app received (a phone call, or no app
in the room yet), per key; `refusedQueuedHostMessages` counts host messages accepted while
the call was `starting` that the agent refused once it connected.

A reader MUST skip classes it does not know (older runners also emitted `log`) and should
count what it skipped. Diagnostics go to the runner's stdout and stderr, never the stream.

**Heartbeat.** An idle stream writes `{"ping": <epoch ms>}` every 15 seconds. It has no
envelope, is not a record, and never advances a cursor. Set your read deadline to a
comfortable multiple of 15 seconds.

**Resume and 410.** The runner retains a bounded window of records (4096 by default). A
cursor older than the window answers `410 {"error":"cursor_too_old","requested":N,"oldestRetained":M}`
rather than silently skipping the gap. Reconnect with `from=<oldestRetained - 1>` to read everything still held,
and record the envelopes between `requested` and `oldestRetained` as lost.

**Truncation rule.** A call's conversation is complete when its producer's last record is
the event `curb.ended` (payload `{reason}`); EOF without it means the stream was cut. The
runner's own terminal record is lifecycle `ended`, written before the listener closes.

## Validating a host implementation

Decode every answer and every stream line against the matching `$defs` type of
`protocol.schema.json`, and run your decoder over the fixtures: each file under
`protocol-fixtures/valid/` must decode as the type its name starts with, and each file
under `protocol-fixtures/invalid/` must be refused. The schema never forbids unknown
properties; keep your decoder that lenient, so a newer runner's additions do not break it.

The Curb repository runs this end to end on every change (`npm run smoke:self-host`): it
builds an example agent, starts it as a managed runner with no LiveKit credentials, and
checks every answer against the schema.

## curl walkthrough

```bash
ADDR=127.0.0.1:7071
TOKEN=...   # the runner's CURB_MANAGEMENT_TOKEN
auth=(-H "Authorization: Bearer $TOKEN")

curl -s http://$ADDR/health
curl -s "${auth[@]}" http://$ADDR/v1/runner

# Follow the stream in another terminal (-N: no buffering).
curl -sN "${auth[@]}" "http://$ADDR/v1/runner/events?from=0"

# Place a call: create the LiveKit room and a room-scoped token first. clientContext is
# optional; the agent reads it as client.event.
curl -s "${auth[@]}" -H 'content-type: application/json' \
  -d '{"sessionId":"call-42","realtimeUrl":"wss://livekit.example.com","realtimeToken":"<room token>","clientContext":{"event":"webinar-11-04"}}' \
  http://$ADDR/v1/sessions

curl -s "${auth[@]}" http://$ADDR/v1/sessions/call-42
curl -s "${auth[@]}" -X DELETE "http://$ADDR/v1/sessions/call-42?reason=caller_hung_up&graceMs=2000"

# Retire the runner: finish the calls in progress, take no new ones, then exit.
curl -s "${auth[@]}" -X POST http://$ADDR/v1/runner/drain
```

`SIGTERM` or `SIGINT` drains the same way (the `draining` record then names the signal);
a second signal exits at once.

## App messages

Agent code exchanges small keyed messages with two parties during a call: the **client**
(the app the caller uses, over LiveKit) and the **host** (whatever runs the call, over this
protocol). A key is any non-empty string of at most 256 characters, used verbatim on the
wire. Dotted names such as `human.requested` remain a good convention for a host's own
vocabulary. The transport stamps who sent a message, never the payload.

```tsx
import { Tool, useMessage, useSend, z, HostTimeoutError, HostUnavailableError } from "curb";

function Claims() {
  const send = useSend();

  // From the caller's app. The return value is the reply to the client's send.
  useMessage("claim-submitted", {
    from: "client",
    schema: z.object({ claimId: z.string() }),
    onMessage: ({ claimId }) => ({ received: claimId }),
  });

  // From the host, unprompted.
  useMessage("ops.notice", { from: "host", onMessage: (payload) => console.log(payload) });

  async function askSupervisor(topic: string) {
    send.toClient("show-status", { status: "waiting-for-supervisor" });
    try {
      const answer = await send.askHost("human.requested", { topic }, { timeoutMs: 10_000 });
      return answer.disposition === "allowed" ? "Approved." : "Declined.";
    } catch (error) {
      if (error instanceof HostTimeoutError) return "The supervisor did not answer in time.";
      if (error instanceof HostUnavailableError) return "No supervisor is connected to this call.";
      throw error;
    }
  }
  // ...render a <Tool> that calls askSupervisor
}
```

- `useSend()` returns `{ toClient(key, payload?), toHost(key, payload?), askHost(key, payload?, { timeoutMs? }) }`.
  Payloads are JSON objects. It is stable across renders and safe in tool handlers.
- `toClient` with no app in the room yet, `toClient` on a phone call (SIP only, so no data
  channel), and `toHost` with no host connected are dropped with one warning per key and
  reason, never thrown. A dropped `toClient` is counted in the call record
  (`curb.messages`). The caller's app can call the agent as soon as the agent joins the
  room: a request that arrives before the agent's runtime is ready waits for it, up to 10
  seconds, then is refused `no_handler` (`not_adjustable` for an update).
- `askHost` resolves with the payload of the host message whose `inReplyTo` is the ask's
  `id`. It rejects with `HostUnavailableError` when no host is connected or the call ends
  while it waits, and with `HostTimeoutError` after `timeoutMs` (default 10000). A host is
  connected when the call keeps a record a host reads: a managed runner, a direct-join
  runner serving its events stream, or `curb dev` / `curb start` with a management port.
  Without one (and in unit tests) there is none.
- `useMessage(key, { from, schema?, onMessage })` handles every message with that key
  from `"client"` or `"host"` while the component is mounted. A `from: "client"` handler
  never sees a host message and vice versa. With a Zod `schema`, `onMessage` gets the
  parsed payload; without one the payload is `unknown`. If several mounted components
  listen for one key, each runs in mount order and the reply is the most recently mounted
  handler's return value. After the handlers run the context is recompiled, so a handler
  that changes a store can unlock a skill or tool.
- A message is refused with a code, never dropped: `no_handler` (nothing listens for the
  key from that sender), `invalid_payload` (a schema refused it; no handler ran, the Zod
  issues are returned), `handler_failed` (a handler threw; the others still ran).
- An invalid key or `from` throws `AGENT_INVALID_AUTHORING_PROP`.
- Each call has its own messages: two calls on one runner never see each other's.

### Host side

`HostMessage` = `{id, name, payload, inReplyTo?}`:

- `id`: 1 to 128 characters, unique per call. Delivery is idempotent by `id`.
- `name`: the message key, 1 to 256 characters.
- `payload`: a JSON object.
- `inReplyTo`: the `id` of the agent's `askHost` this message answers.

**Host to agent.** `POST /v1/sessions/{id}/messages` with a `HostMessage` body answers once
the agent's handlers have run: `202 {"id":..., "delivered":true}`, or `"delivered":false`
when that `id` was already delivered to the call. A reply (`inReplyTo` naming an ask still
waiting) resolves that ask and needs no handler; a reply that arrives after the timeout is
handled like any other message. A refusal answers `422` with `no_handler`,
`invalid_payload` (with `issues`) or `handler_failed`, and its id is not taken, so a
corrected retry with the same id is delivered. An unknown or ended call is
`404 session_not_found`, a malformed body `400 invalid_request`. Ids are scoped to the
call: two calls may each take a message `m-1`.

A message to a call still `starting` is held and delivered, in order, once the call
connects. Up to 32 are held per call; past that the message is refused with
`409 runner_at_capacity` and its id is not taken, so retry it once the call is `connected`.
A held message was already answered `202`, so if the agent refuses it on delivery the
runner logs a warning and counts it instead. A direct-join runner (handed its one call at
start) answers `501 runner_takes_no_calls` on this route: it has no host-to-agent path, so
an `askHost` there times out, but its agent-to-host records still leave over its events stream.

```bash
curl -s "${auth[@]}" -H 'content-type: application/json' \
  -d '{"id":"m-7","name":"human.decision","payload":{"disposition":"allowed","reason":"verified"},"inReplyTo":"a-3"}' \
  http://$ADDR/v1/sessions/call-42/messages
```

A refusal:

```json
{"error":"invalid_payload","detail":"invalid_payload: the payload of \"lead\" does not match its schema: score: Invalid input: expected number, received string","issues":[{"path":["score"],"message":"Invalid input: expected number, received string"}]}
```

**Agent to host.** A record of class `host` on the events stream, `producer` the session
id, `seq` from the same per-call counter as the conversation:

```json
{"envelope":57,"producer":"call-42","seq":31,"class":"host","at":1790625600000,"body":{"type":"host","seq":31,"at":1790625600000,"id":"a-3","name":"human.requested","payload":{"topic":"refund"},"expectsReply":true}}
```

`expectsReply: true` (from `askHost`) means the agent is waiting: answer with a
`HostMessage` whose `inReplyTo` is the record's `id`. `toHost` records have
`expectsReply: false`. Which keys exist and what their payloads mean is agreed between
your agent and your host; Curb only carries them.

### Transfer on your own host

`useTransferCall` and `<TransferCallTool>` work over these messages, so a host that can dial
can offer transfers. The transfer asks with `askHost`, so it appears on the events stream as a
`host` record with `expectsReply`:

| Direction | Name | Payload |
|---|---|---|
| Agent to host | `call.transfer` | `{ to, ringTimeoutSeconds? }` |
| Host to agent, as the reply | `call.transfer.accepted` | `{ transferId }` |
| Host to agent, as the reply | `call.transfer.refused` | `{ code, message }`, passed to the agent as the outcome `refused` |
| Host to agent, once the target answered or the dial failed | `call.transfer.result` | `{ transferId, outcome, dialStatus }`, with `outcome` one of `answered`, `no_answer`, `busy`, `failed`. Not a reply: it has no `inReplyTo` |

Both replies set `inReplyTo` to the record's `id`.

Dial the target into the call's LiveKit room. When it joins, the agent stops listening and
speaking; when it leaves and the caller is still there, the agent takes the call back. A host
that sends no reply in time gives the agent the outcome `failed`, with the code
`transfer_no_reply`. A direct-join runner takes no host messages, so a transfer there ends the
same way.

### Client side

The wire format is plain LiveKit, so `livekit-client` and the native SDKs work without a
Curb library. All of it, both parties:

| Direction | Transport | Shape |
|---|---|---|
| agent to client | text stream, topic `curb.message` | `{key, id, payload}` |
| client to agent (send and ask) | RPC method `curb.message` on the agent participant | request `{key, id, payload}`; response `{reply?}`, or an RPC error |
| client to agent, settings | RPC method `curb.update` on the agent participant | request a `SessionUpdate`; response the `EffectiveSettings`, or an RPC error |
| agent to host | host protocol v1 | `host` records on `GET /v1/runner/events` |
| host to agent | host protocol v1 | `POST /v1/sessions/{id}/messages` |
| host to agent, settings | host protocol v1 | `PATCH /v1/sessions/{id}`, the same body as `curb.update` |

Client to agent is RPC rather than a text stream so every send gets an acknowledgement or a
coded error. The cost is LiveKit's 15 KiB RPC payload cap.

A refused RPC fails with an RPC error whose `message` is the code:

| Code | `message` | Meaning |
|---|---|---|
| 2001 | `no_handler` | nothing listens for the key with `from: "client"` |
| 2002 | `invalid_payload` | the envelope is malformed or the schema refused the payload; `data` is the reason, or `{"issues":[...]}` |
| 2003 | `handler_failed` | a handler threw (its error stays on the server) |
| 2004 | `payload_too_large` | the request is over LiveKit's 15 KiB RPC cap |
| 2005 | `not_adjustable` | `curb.update` touched a path `<Agent adjustable>` does not give the client; `data` is `{"path":...}` |
| 2006 | `invalid_settings` | `curb.update` is malformed or a value does not fit; `data` is `{"issues":[...]}` |

#### `curb/client`

`curb/client` wraps that wire format for a browser app. It depends only on
`livekit-client` and takes the `Room` your app already owns, including
`useRoomContext()` from `@livekit/components-react`:

```ts
import type { Room } from "livekit-client";
import { AgentRefusedError, connectAgent } from "curb/client";

export async function talkToAgent(room: Room, openForm: (form: unknown) => void) {
  const agent = connectAgent(room);                          // one per room
  agent.on("show-form", (payload) => openForm(payload));     // useSend().toClient("show-form", …)

  await agent.send("claim-submitted", { claimId: "C-17" });  // resolves once the agent took it
  const quote = await agent.ask<{ price: number }>("quote", { plan: "basic" }, { timeoutMs: 5000 });

  let voiceChangeable = true;
  try {
    await agent.update({ tts: { voice: 17 } });   // needs <Agent adjustable={{ client: ["tts.voice"] }}>
  } catch (error) {
    if (error instanceof AgentRefusedError && error.code === "not_adjustable") voiceChangeable = false;
    else throw error;
  }

  return { quote, voiceChangeable, close: () => agent.close() };  // close on unmount
}
```

```ts
import type { Room } from "livekit-client";
import type { EffectiveSettings, SessionUpdate } from "curb/client";

declare function connectAgent(room: Room, options?: { agentIdentity?: string }): AgentClient;

interface AgentClient {
  send(key: string, payload?: unknown): Promise<void>;
  ask<T = unknown>(key: string, payload?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  on(key: string, handler: (payload: unknown, meta: { id: string }) => void): () => void;
  update(settings: SessionUpdate): Promise<EffectiveSettings>;
  close(): void;
}
```

- The agent is `options.agentIdentity`, else the first remote participant of kind
  `AGENT`. A call made before the agent joined waits for it, up to its timeout (default
  10 s), then rejects `AgentUnavailableError`.
- A refusal rejects `AgentRefusedError` with `code` (the names above), and `issues` or
  `path` when the agent sent them. A request over 15 KiB is refused `payload_too_large`
  before it is sent. Transport failures (a timeout, a disconnect) reject with LiveKit's own
  `RpcError`.
- `on` handlers get only the agent participant's messages. A message with no handler is
  dropped with one console warning per key.
- One client per room: LiveKit takes one handler per text-stream topic. `close()` releases it.

The same exchange with `livekit-client` alone:

```ts
// livekit-client, in the caller's app
import type { Room } from "livekit-client";

export async function talkToAgent(room: Room, showForm: (form: unknown) => void) {
  room.registerTextStreamHandler("curb.message", async (reader) => {
    const { key, payload } = JSON.parse(await reader.readAll());
    if (key === "show-form") showForm(payload);
  });

  const agent = [...room.remoteParticipants.values()].find((p) => p.isAgent)!;
  const response = await room.localParticipant.performRpc({
    destinationIdentity: agent.identity,
    method: "curb.message",
    payload: JSON.stringify({ key: "claim-submitted", id: crypto.randomUUID(), payload: { claimId: "C-1" } }),
  });
  const { reply } = JSON.parse(response);
  return reply;
}
```

## Media relay

A host can keep WebRTC out of the agent's process. A relay it runs holds the realtime room and
carries the call to the agent over one WebSocket, and the agent never receives a room token.

A build that can do this says `"mediaRelayProtocol": 1` in `curb.bundle.json`. To use it, start the
call with a `realtimeUrl` of `curb-relay+ws://` or `curb-relay+wss://`, and `realtimeToken` set to a
token for that one call. The agent sends the token as `Authorization: Bearer <token>`, never in the
URL.

Binary frames are one stream byte followed by little-endian 16-bit mono PCM:

| Stream | Direction | Audio |
|---|---|---|
| `0` | Relay to agent | The caller the agent listens to, at 16 kHz |
| `0` | Agent to relay | The agent's voice, at 24 kHz |
| `1` | Agent to relay | A transfer's announcement and ringback, at 48 kHz |

Text frames are JSON. `src/relay-wire.ts` is the source for every message. The first frame the agent
expects is `joined`, with the room's name and who is there, and it gives up after 15 seconds.

```json
{ "type": "joined", "room": "room-1", "participants": [{ "identity": "caller", "kind": 0 }] }
```

The relay owes the agent:

- participant events, and `room_lost` when it loses the room;
- `playout_done` or `playout_cleared` with `playedMs` after each `audio_flush` or `audio_clear`,
  which is what cuts an interrupted reply's transcript to the words that played;
- the caller's typed text, as `typed_text`;
- `rpc_request` for each method the agent registered, and `send_text_result` for each `send_text`;
- `transfer_ready` or `transfer_failed` after `transfer_open`, and `transfer_played` after
  `transfer_wait`;
- answers to WebSocket pings. Three missed heartbeats, five seconds apart, or a closed socket end
  the call.

The relay also publishes what the agent says to the room, so the caller's app sees what it sees on
any other call: `agent_text` and `caller_text` as transcripts and `agent_state` as the agent's state.

The relay forwards only the participant named by the latest `listen` message. A call through a
relay has no WebRTC in the agent, so stats and tracks from the room are not available to agent code.

## Live session settings

An agent can let its client app and its host change some of its settings during a call:
the voice, the TTS model, the recognition language, the LLM. Nothing is adjustable unless
the agent says so, per origin:

```tsx
import { Agent, useSession } from "curb";
import { kugelaudio } from "curb/providers";

export function App() {
  return (
    <Agent
      llm={kugelaudio.llm()}
      tts={kugelaudio.tts({ voice: 1072 })}
      adjustable={{ client: ["tts.voice"], host: ["tts.voice", "stt.language", "llm"] }}
    >
      {/* ... */}
    </Agent>
  );
}
```

Adjustable paths: `tts.voice`, `tts.model`, `stt.language`, `llm`. The body is the same
from both sides, `SessionUpdate`:

```ts
type SessionUpdate = {
  tts?: { voice?: string | number; model?: string };
  stt?: { language?: string };
  llm?: { provider: "kugelaudio" | "anthropic" | "openai" | "openai-compatible"; model: string; baseURL?: string };
};
```

- **Deny by default, all or nothing.** Every path in the body must be listed for the
  sender's origin (a client's `curb.update` is `client`, the host's PATCH is `host`), or the
  whole update is refused `not_adjustable` naming the first path. A value that does not fit
  the provider it would reach (a non-numeric KugelAudio voice, a language for a recognizer
  that takes none, an unknown LLM provider, an unknown key) refuses the whole update
  `invalid_settings` with `issues`. A refused update changes nothing.
- **An override, not a new prop.** An accepted value sits above the `<Agent>` and active
  `<Skill>` props until the next outside change of the same path. `tts.voice` changes the
  voice of whichever TTS the props pick; switching skills keeps it.
- **Takes effect from the next reply.** Speech providers are rebuilt and handed over
  through LiveKit (`AgentSession.updateAgent`), so the reply being spoken finishes in the
  old voice. The LLM changes from the next turn.
- **The endpoint stays the author's.** A client may switch `llm` only to a provider with
  no `baseURL` or to the agent's own `openaiCompatible` endpoint, because the endpoint
  receives the agent's key. The host may name any `http(s)` `baseURL`.
- The answer is the effective settings, never a credential:

```json
{"tts":{"provider":"kugelaudio","voice":17},"stt":{"provider":"azure","language":"de"},"llm":{"provider":"kugelaudio","model":"qwen3.8-27b"}}
```

Agent code reads the effective settings with `useSession()`; a component re-renders when
they change:

```tsx
import { Text, useSession } from "curb";

function VoiceNote() {
  const { settings } = useSession();
  return settings.tts.provider === "kugelaudio" && settings.tts.options.voice === 17
    ? <Text>The caller picked the calm voice; keep sentences short.</Text>
    : null;
}
```

From the host:

```bash
curl -s "${auth[@]}" -X PATCH -H 'content-type: application/json' \
  -d '{"tts":{"voice":17},"stt":{"language":"de"}}' \
  http://$ADDR/v1/sessions/call-42
# 200 {"sessionId":"call-42","settings":{...}}
# 403 {"error":"not_adjustable","detail":"...","path":"stt.language"}
# 422 {"error":"invalid_settings","detail":"...","issues":[{"path":["tts","voice"],"message":"..."}]}
```

From the client: `agent.update(...)` in `curb/client` above, or the `curb.update` RPC with
`livekit-client`. A change to a call that is still `starting` is applied once it connects.

## Next steps

- [Connecting to a running agent](./connecting.md): what your app and your backend use.

- [Self-hosting](./hosting.md): the ways to run an agent.
- [App messages](./app-messages.md): the agent's side.
- [Mid-call changes](./mid-call-changes.md): what `adjustable` allows.
