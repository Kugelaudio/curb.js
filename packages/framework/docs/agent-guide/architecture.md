# Architecture

Curb is a framework: it runs one voice agent. A host starts that agent and gives it calls.
KugelAudio's hosted platform is one host, and your own server can be another. This page says
what each part does and how they talk to each other, including what Curb does not do.

## The parts

```text
  Caller (phone, web widget, your app)
     │  audio over LiveKit (SIP for phones)
     ▼
┌────────────────────────── a LiveKit room ─────────────────────────┐
│                                                                   │
│   Curb runner: one process, your agent's bundle                   │
│   ┌───────────────────────────────────────────────────────────┐   │
│   │ Voice session   audio in/out, VAD, endpointing, barge-in  │   │
│   │ Agent session   turn loop, transcript, tool calls         │   │
│   │ Your React tree → context + tools for the next request    │   │
│   └───────────────────────────────────────────────────────────┘   │
└──────────┬───────────────────────────────────┬────────────────────┘
           │ HTTPS / WebSocket                 │ host protocol v1 (HTTP on a local port)
           ▼                                   ▼
   STT, LLM and TTS providers            The host: places calls, reads events,
   (keys in the runner's environment)    sends messages, ends and drains
```

| Part | Owns | Does not own |
|---|---|---|
| **Your agent** | Prompts, skills, tools, state, provider choice | Audio, turn-taking, the LLM loop |
| **Curb** | Rendering context, the turn loop, the voice session, the preview, `curb test`, `curb build` | Rooms, phone lines, call placement, scaling, storage of calls |
| **LiveKit** | Rooms and media, SIP | Anything about the conversation |
| **A host** | Starting runners, creating rooms and tokens, placing calls, keeping records | What the agent says |

Curb builds on LiveKit's agents library. LiveKit's `AgentSession` owns audio, voice activity
detection, endpointing and interruption; Curb replaces its LLM step with its own loop. A
project holds no voice session code ([Voice sessions](./voice-sessions.md)), and can still edit the
pipeline around Curb's loop ([Override the LiveKit pipeline](./livekit-pipeline.md)).

## One call, end to end

1. The host creates a LiveKit room and a token scoped to it, and asks a warm runner to take
   the call: `POST /v1/sessions` with the room's URL and token. A start request never carries
   secrets.
2. The runner joins the room and starts a session with a fresh agent runtime, transcript and
   stores. Two calls on one runner never share these.
3. The caller speaks. STT produces the turn's text. Curb compiles the tree and calls the LLM
   ([What the model receives](./what-the-model-receives.md)).
4. Tool calls run your handlers in the runner. State changes re-render the tree.
5. The reply streams to TTS sentence by sentence. Speaking over the agent interrupts it, and
   the transcript keeps only the words the caller heard.
6. The runner writes turns and events to its event stream, and the host reads them.
7. The call ends. The runner stays warm for the next one, or exits after a drain.

## How the platform and Curb communicate

Everything passes through three narrow contracts. None of them is private to KugelAudio.

| Contract | Between | Carries |
|---|---|---|
| **Bundle** (`curb build`, `curb.bundle.json`) | Project and host | The built agent, its entrypoint, required secret names, goals and experiments |
| **Host protocol v1** | Host and runner | Start, stop, drain, messages, live settings, the event stream ([Host protocol](./host-protocol.md)) |
| **LiveKit text streams and RPC** | Caller's app and agent | App messages and live settings ([Host protocol](./host-protocol.md#client-side)) |

The runner does not know which host it talks to. A host that speaks these contracts can run
any Curb agent; the same agent runs under `curb start` with no host at all.

## What the hosted platform adds

On KugelAudio, the platform is the host. It builds your bundle, keeps warm runners, and adds
everything around a call that a framework cannot do:

| Capability | Where it lives |
|---|---|
| Builds and deployments, `curb deploy`, deploy on GitHub push | Platform |
| Runner isolation, the egress proxy, secrets | Platform |
| Phone numbers, the web widget, the Playground | Platform |
| Call transfer: dialing the target | Platform, over the host channel |
| Call log, recordings, retention, goals results, experiment assignment | Platform |
| The agent's turn loop and everything in your code | Curb, the same as on your machine |

Hosting is a closed alpha, switched on per organization. The details of a hosted call are in
[How a hosted agent runs](https://docs.kugelaudio.com/hosted-agents/how-it-runs), and what
you take over when you run it yourself is in [Hosting a Curb agent yourself](./hosting.md).

## What this design costs

- **One process per call by default.** A runner serves one call unless `CURB_MAX_SESSIONS`
  is set, and calls in one process share an OS user ([Hosting a Curb agent yourself](./hosting.md#several-calls-in-one-runner)).
- **One agent per conversation.** Handing over between skills is built in. Handing over
  between two deployed agents is a phone transfer ([Complex handoffs](./complex-handoffs.md)).
- **One transcript per conversation.** No skill has private history
  ([Skill lifecycle](./skill-lifecycle.md#context-per-skill)).
- **Node on a server.** A runner runs agent code under Node, not on an edge runtime. A browser
  project runs it in a worker in the page.
- **The voice session is Curb's.** You change it through settings or
  `defineAgent({ pipeline })`. A session of your own needs your own worker
  ([Override the LiveKit pipeline](./livekit-pipeline.md)).
