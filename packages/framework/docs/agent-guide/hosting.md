# Hosting a Curb agent yourself

A Curb agent needs no hosted platform. Everything below runs on your own machines with
your own LiveKit deployment (LiveKit Cloud or self-hosted `livekit-server`) and your own
provider keys. This page says what you get and what you take on, covers the four ways to
run an agent, and specifies **host protocol v1**, the HTTP contract between a Curb runner and
whatever orchestrator starts it. For how your app and your backend talk to the agent once it runs,
see [Connecting to a running agent](./connecting.md).

## What self-hosting includes

The framework is the same on every route: your tree, skills, tools, stores, the turn loop, the
voice session, `curb dev`, `curb say`, `curb test` and `curb build`. What differs is what sits
around a call.

| Capability | Self-hosted | On KugelAudio |
|---|---|---|
| Agent code, skills, tools, MCP servers | Included | Included |
| Voice session: turn-taking, interruptions, greeting | Included | Included |
| STT, LLM and TTS | Every provider in `curb/providers`, your keys | `KUGELAUDIO_API_KEY` provided. ElevenLabs STT and TTS do not run in a hosted agent |
| Recording conversations | `.data/conversations.jsonl`, or your own store with `KUGEL_CONVERSATION_SINK`. A managed runner (`CURB_MANAGEMENT_ADDR`) writes no file, only to a sink | Call log with retention |
| `curb test`, with a simulated caller and its judge | Included, on the agent's own LLM | Included |
| Goals (`defineAgent({ goals })`) | **Not judged.** Your goals are written to `curb.bundle.json`, and nothing evaluates them | Judged after each call by a hosted LLM, shown on the Goals tab |
| After-call code (`afterCall`, `afterEvaluation`) | **Your host runs it.** The manifest names the hooks, and your host starts a [hook runner](#hook-runner) and posts each event to it | Run after each call in a sandbox of its own, with retries, on plans that include it |
| Experiments (`defineAgent({ experiments })`) | **Not assigned.** Your host picks each call's variants and passes them when it starts the call. Under `curb start` no call gets a variant | Assigned per call, with results |
| Call transfer | **Your host dials.** The agent asks for a transfer in a host message. With no host, or a host that does not answer, the transfer ends as `failed` ([transfer on your own host](./host-protocol.md#transfer-on-your-own-host)) | Included on phone calls |
| Changing a live call's settings from your server | `PATCH /v1/sessions/{id}` on the management port | No published route yet: from the caller's app or the agent |
| Phone numbers, web widget, Playground, dashboard | Not included. LiveKit SIP and your own page take their place | Included |
| Egress and isolation | Whatever your network and your runtime give you | Sandboxed runner, restricted egress |
| Secrets | Your environment or secret store | Stored per environment |
| Builds and deployments | `curb build`, then your own deployment | `curb deploy`, deploy on GitHub push. Hosted deploys accept a project that installs Curb from npm |

Goals are judged by KugelAudio's platform, so a self-hosted agent gets no goal results, even
with a KugelAudio key. To judge calls yourself, read them from your conversation store and
give them to a model of your own.

A hosted agent reaches only public addresses, over HTTPS on port 443 and HTTP on port 80: no
private addresses and no other TCP. The rule and the details are in
[How a hosted agent runs](https://docs.kugelaudio.com/hosted-agents/how-it-runs). A self-hosted
runner has no such limit, so an agent that must reach a private system or a database port
needs your own hosting, or an HTTPS API in front of that system.

## Ways to run an agent

| Mode | Command | What it needs | Use it for |
|---|---|---|---|
| Dev | `npm run dev` (`curb dev`) | provider keys in `.env` | building the agent; preview, chat and voice on one port |
| LiveKit worker | `npm start` (`curb start`) | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | a long-running worker that LiveKit dispatches rooms to |
| Built artifact | `curb build`, then `node <entrypoint>` | Node only; no `npm install`, no TypeScript | shipping one self-contained directory to a server or container |
| Managed runner | the built artifact with `CURB_MANAGEMENT_ADDR` + `CURB_MANAGEMENT_TOKEN` | an orchestrator that speaks host protocol v1 | your own control plane placing calls on warm runners |
| Hook runner | a managed runner with `CURB_RUNNER_ROLE=hooks` | an orchestrator that speaks host protocol v1 | running `afterCall` and `afterEvaluation` apart from the calls |

Every mode runs the same voice session, the framework's: the same providers, greeting,
caller info and call identity ([Voice sessions](./voice-sessions.md)). A
project's `src/orchestration/` is not loaded by any of them.

Dev and the LiveKit worker also serve host protocol v1 for the calls they run when
`CURB_MANAGEMENT_ADDR` and `CURB_MANAGEMENT_TOKEN` are set: see
[Management port in dev and worker mode](#management-port-in-dev-and-worker-mode).

### Dev

`curb dev` serves the preview on `http://127.0.0.1:4000`. See the project README for the
loop itself. With no LiveKit configured, a call runs over the page's own connection to the
dev server, so voice needs nothing else running. Such a call has no phone line, so a
transfer is refused. With `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` set,
calls use that deployment instead. All three are needed: `curb dev` does not start with only
some of them set, and names the missing ones.

A host that runs `curb dev` for someone else, where the browser cannot reach a LiveKit
server beside it, sets `CURB_REALTIME_SESSION_URL` instead of handing over an API key and
secret, which would mint tokens for any room. On every **Start call** `curb dev` sends a
`POST` with no body to that URL and expects one fresh room for that call:

```json
{
  "room": "preview-1f3a9c",
  "agentUrl": "ws://livekit.example.com:7880",
  "agentToken": "<a token for that room, as the agent>",
  "callerUrl": "wss://livekit.example.com",
  "callerToken": "<a token for that room, as the person calling>"
}
```

The agent server joins with the agent token and the page with the caller token. A non-2xx answer fails the call with the body's `message`, so the
host's own words ("try again in a moment") reach the preview. In this mode `LIVEKIT_URL`,
`LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are refused, not ignored: `curb dev` does not
start with one of them in the environment or `.env`, and a call does not start when one was
added to `.env` since.

### LiveKit worker (`npm start`)

The scaffolded project's `npm start` registers a worker with your LiveKit deployment and
waits to be dispatched:

```bash
export LIVEKIT_URL=wss://livekit.example.com
export LIVEKIT_API_KEY=...
export LIVEKIT_API_SECRET=...
npm start
```

The worker registers under `CURB_AGENT_NAME` when it is set, otherwise under the `name` in
the project's `package.json`, otherwise as `curb-agent`. Configure a LiveKit dispatch rule
(room or SIP) that targets that name. Provider keys (`KUGELAUDIO_API_KEY` and so on) come
from the project's `.env` or the process environment.

### Provider keys

Which providers an agent runs is authored in the agent, as `<Agent llm stt tts>` props
from `curb/providers` (see [Agents and skills](./agents-and-skills.md)). The environment
holds only the keys of the providers the agent actually uses; a missing one fails with an
error naming it.

| Provider prop | Variable |
|---|---|
| `kugelaudio.llm({ model? })` (default LLM) | `KUGELAUDIO_API_KEY`; `KUGELAUDIO_API_BASE` (default `https://api.eu.kugelaudio.com`), plus `/v1` |
| `anthropic(model)` | `ANTHROPIC_API_KEY` |
| `openai(model)`, `openai.stt()`, `openai.tts()` | `OPENAI_API_KEY` |
| `openaiCompatible({ baseURL, model })` | `AGENT_LLM_API_KEY`, else `OPENAI_API_KEY`; optional |
| `azure.stt()` | `AZURE_SPEECH_KEY`; `AZURE_SPEECH_REGION` (default `eastus`) |
| `kugelaudio.stt()` | `KUGELAUDIO_API_KEY`; `KUGELAUDIO_API_BASE` (default `https://api.kugelaudio.com`) |
| `kugelaudio.tts()` (default TTS) | `KUGELAUDIO_API_KEY`; `KUGELAUDIO_API_BASE` (default `https://api.kugelaudio.com`) |
| `deepgram.stt()` | `DEEPGRAM_API_KEY` |
| `elevenlabs.stt()`, `elevenlabs.tts()` | `ELEVEN_API_KEY` (or `ELEVENLABS_API_KEY`) |
| `cartesia.tts()` | `CARTESIA_API_KEY` |

### Built artifact (`curb build`)

```bash
npx curb build --out dist
```

`dist/` is self-contained: the bundled agent, its traced runtime dependencies (including
native modules for the build machine's OS and architecture) and `curb.bundle.json`. The
manifest's `entrypoint` names the file to run; never hardcode it. The build starts the
finished artifact once and renders every skill before it reports success. Build on the OS
and architecture you deploy to (the manifest records it under `target`).

The built entrypoint picks its mode from the environment, one of four:

| Environment | Mode |
|---|---|
| `CURB_READINESS_PROBE=1` | load the bundle, construct the agent, exit 0; touches no media |
| `CURB_MANAGEMENT_ADDR` (+ `CURB_MANAGEMENT_TOKEN`) | managed runner, below; with `CURB_RUNNER_ROLE=hooks`, a [hook runner](#hook-runner) |
| `CURB_REALTIME_URL` + `CURB_REALTIME_TOKEN` | direct join: join that one already-created room, serve one call, exit |
| none of the above | LiveKit worker, exactly like `npm start` (needs the three `LIVEKIT_*` variables): the same job, under the same name (`CURB_AGENT_NAME`, otherwise the package name `curb build` baked in) |

In the room-token modes the runner never sees `LIVEKIT_API_KEY` or `LIVEKIT_API_SECRET`:
your orchestrator creates the room and mints a room-scoped token, and the runner removes
the API credentials from its own environment.

### Managed runner

A managed runner is started before any call, pays its warmup (bundle, VAD model,
provider plugins) once, announces `ready`, and then takes calls over an HTTP management
port. It does not exit when a call ends; it exits after a drain empties it.

```bash
cd dist
CURB_MANAGEMENT_ADDR=127.0.0.1:7071 \
CURB_MANAGEMENT_TOKEN="$(openssl rand -hex 24)" \
node "$(node -p 'require("./curb.bundle.json").entrypoint')"
```

Your orchestrator then places calls with `POST /v1/sessions`, handing each call a
LiveKit URL and a room-scoped token. Everything it can say is host protocol v1.

#### Several calls in one runner

With `CURB_MAX_SESSIONS=N` a managed runner serves up to N calls of its one deployment at
once, in one process. What Curb guarantees between them:

- **Capacity is exact.** N starts are accepted; the next is refused with `409
  runner_at_capacity` until a call has fully ended (its recording finished and its scratch
  directory removed). A retry of a call already running is still answered as a repeat.
  `CURB_MAX_SESSIONS` and the generation pins are read once, at boot: a runner restored
  from a memory snapshot keeps the values it booted with, whatever its environment says
  after the restore. `GET /v1/runner` and the ready line report the bound in force.
- **One generation per runner.** A start pinned to another `deploymentId` or
  `configurationVersion` than the runner's is refused with `409 generation_mismatch`. Each
  pin is compared only when both the runner and the request state it, so set
  `CURB_DEPLOYMENT_ID` on every runner that serves more than one call.
- **Each call has its own identity.** The agent reads its call as `useSession().call`:
  `sessionId` is the start request's, never the environment's. The runner's environment
  (provider keys, `CURB_*` variables) is the same for every call on it; never read a
  call's identity from `process.env`.
- **Each call has its own scratch directory**, `useSession().call.scratchDir`: created
  under `$TMPDIR` (mode `0700`, a random name) when the call starts, removed when it ends,
  including when it fails to start or is stopped. No other call is given its path. If it
  cannot be created, the call runs without one and the runner logs why; point `TMPDIR` at
  a writable directory.
- **Each call has its own conversation**: agent runtime, transcript, agent stores
  (`createAgentStore`), app messages, live settings, debug clips and event-stream producer.
  Shared by design: the loaded bundle, the VAD model, provider plugin modules, the MCP
  manager and its connections, and the conversation sink.

What Curb cannot guarantee: calls in one process run as one OS user. Agent code that
writes outside its `scratchDir` (`os.tmpdir()` itself, a fixed path) or keeps state in a
module-level variable shares it with every other call on the runner. Run one call per
runner (the default) when calls must not share a process.

### Hook runner

`CURB_RUNNER_ROLE=hooks` turns a managed runner into one that runs the agent's
`afterCall` and `afterEvaluation` and takes no calls. Start the same build:

```bash
cd dist
CURB_RUNNER_ROLE=hooks \
CURB_MANAGEMENT_ADDR=127.0.0.1:7072 \
CURB_MANAGEMENT_TOKEN="$(openssl rand -hex 24)" \
node "$(node -p 'require("./curb.bundle.json").entrypoint')"
```

It prints the same ready line, but warms up no voice session, so it needs no
speech provider keys unless a hook uses them. It answers `POST /v1/sessions` with
`501 runner_takes_no_calls` and reports `role: "hooks"` in `GET /v1/runner`. A role
that does not exist, or the role with no `CURB_MANAGEMENT_ADDR`, stops it at startup
with exit code 78. Without the variable a runner is what it always was, and answers both
hook routes with `501 runner_takes_no_hooks`.

Your host decides when a hook runs: `hooks` in `curb.bundle.json` names the ones the
agent declares. Post each event to
`POST /v1/hooks/{name}`, then read `GET /v1/hooks/runs/{runId}` ([Host protocol](./host-protocol.md#routes)):

- **Once per `runId`.** Repeating a `runId` the runner holds answers `202` and runs nothing,
  so a retried post is safe. Send a new `runId` to run the hook again, and the same
  `event.id`: that is what a hook uses to do its work once.
- **A hook that fails cannot take the runner down.** A throw, a rejection, or an error
  in something the hook left running reads as `failed`. A stray error cannot be traced
  to one run, so it fails every run in progress. Past `deadlineMs` the run reads `failed`
  with `error.message` `timeout`, and it stays failed if the hook finishes later.
- **`error.message` is safe to store.** It holds no stack trace, the runner's environment
  values are replaced with `[redacted]`, and a thrown value that is not an `Error` or a
  string is reported only by its type. Values under 6 characters and encoded forms of a value
  are not caught. The whole error goes to the runner's log, redacted the same way.
- **What a hook prints** reaches the runner's stdout, as an agent's logs do.
- **Runs are not bounded by `CURB_MAX_SESSIONS`.** Every run accepted runs at once, so
  limit what you send. A runner remembers the last 1024 finished runs.
- **Draining waits for runs.** New ones answer `503 runner_draining`, a repeat of a held
  `runId` still answers `202`, the `draining` line counts the runs in progress in `active`,
  and the process exits when they end. `activeSessions` counts calls only, so it reads 0 here.

### Management port in dev and worker mode

`curb dev` and `curb start` open the same management port as a managed runner when both
variables are set, so you can write and test your own host against a real agent without
deploying anything:

```bash
CURB_MANAGEMENT_ADDR=127.0.0.1:7071 \
CURB_MANAGEMENT_TOKEN="$(openssl rand -hex 24)" \
npm start    # or: npm run dev
```

| Variable | Meaning |
|---|---|
| `CURB_MANAGEMENT_ADDR` | `host:port` to listen on. Absent: no port, nothing else changes. |
| `CURB_MANAGEMENT_TOKEN` | Bearer token for every route but `/health`. Required: with the address but no token the port stays closed and the process says why. |

`curb start` prints `curb: host protocol v1 on http://127.0.0.1:7071/v1 (calls by room name)`;
`curb dev` shows the same address on its `Host` banner row.

Here LiveKit dispatch (or the preview's **Start call**) places the calls, not your host.
Every call the process runs is registered while it runs, **under its LiveKit room name as
the session id**, and leaves the list when it ends. In worker mode that is also the agent's
`useSession().call.sessionId`; in dev the agent's is its preview conversation's id
(`preview-…`), which a voice call on that conversation keeps. In worker mode each job runs
in its own process and registers its call with the worker over a private local socket, so
one port covers every job of the worker. For those calls your host can:

| Route | In dev and worker mode |
|---|---|
| `GET /v1/sessions`, `GET /v1/sessions/{id}` | the calls running now |
| `GET /v1/runner/events?from=N` | their records (see "What a call's record contains"), plus what the voice session reports through the `reporter` it is handed |
| `POST /v1/sessions/{id}/messages` | delivered to that call's `useMessage({ from: "host" })` handlers |
| `PATCH /v1/sessions/{id}` | live settings, gated by `<Agent adjustable={{ host: [...] }}>` |
| `DELETE /v1/sessions/{id}` | ends the call (`graceMs` lets the agent finish its sentence) |
| `POST /v1/sessions`, `GET /v1/runner`, `POST /v1/runner/drain` | `501 runner_takes_no_calls`: LiveKit places, counts and drains the calls here; stop the worker with `SIGTERM` |

With `askHost`, an agent in dev or worker mode now has a host to wait for: answer its
`host` record on the events stream with a `HostMessage` whose `inReplyTo` is the record's
`id`. Without the port, `askHost` rejects `HostUnavailableError` as before.

```bash
ADDR=127.0.0.1:7071
auth=(-H "Authorization: Bearer $CURB_MANAGEMENT_TOKEN")

curl -s "${auth[@]}" http://$ADDR/v1/sessions                       # which rooms have a call
curl -sN "${auth[@]}" "http://$ADDR/v1/runner/events?from=0"        # follow them (another terminal)
ROOM=curb-1a2b3c4d                                                   # a sessionId from the list

curl -s "${auth[@]}" http://$ADDR/v1/sessions/$ROOM
curl -s "${auth[@]}" -H 'content-type: application/json' \
  -d '{"id":"m-1","name":"ops.notice","payload":{"text":"supervisor online"}}' \
  http://$ADDR/v1/sessions/$ROOM/messages
curl -s "${auth[@]}" -X PATCH -H 'content-type: application/json' \
  -d '{"tts":{"voice":17}}' \
  http://$ADDR/v1/sessions/$ROOM
curl -s "${auth[@]}" -X DELETE "http://$ADDR/v1/sessions/$ROOM?reason=host_stop&graceMs=2000"
```

## Run a production worker

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
project actually uses; Curb does not infer credentials from the agent's providers. Omit
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
phone calls, LiveKit SIP and trunk setup remain infrastructure outside Curb. LiveKit runs
each dispatched call in a job process of its own, which serves it as described above and
ends when the call does.

When `curb start` serves a management port (`CURB_MANAGEMENT_ADDR` and
`CURB_MANAGEMENT_TOKEN`), every call is registered on it under its room name, the agent's
`useSend().toHost` reaches the events stream, and the host can send messages, change
settings and end the call. See [Hosting a Curb agent yourself](./hosting.md#management-port-in-dev-and-worker-mode).

## Next steps

- [Connecting to a running agent](./connecting.md): how your app and your backend reach it.
- [Host protocol](./host-protocol.md): how a host talks to a runner.
- [Architecture](./architecture.md): what Curb does and what a host does.
