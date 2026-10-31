# Configuration

Curb reads everything below from the environment or the project's `.env`. How an agent behaves is set
in code, on [`<Agent>`](./components.md#agent) and in [`defineAgent`](./functions.md#defineagent).

## Provider keys

The environment holds only the keys of the providers the agent uses. A missing one fails with an error
naming it.

| Provider | Variable |
|---|---|
| `kugelaudio.llm()`, `kugelaudio.stt()`, `kugelaudio.tts()` | `KUGELAUDIO_API_KEY`. With `npx curb login`, a project on this machine needs none |
| `anthropic()` | `ANTHROPIC_API_KEY` |
| `openai()`, `openai.stt()`, `openai.tts()` | `OPENAI_API_KEY` |
| `openaiCompatible()` | `AGENT_LLM_API_KEY`, else `OPENAI_API_KEY`; optional |
| `azure.stt()` | `AZURE_SPEECH_KEY`; `AZURE_SPEECH_REGION` (default `eastus`) |
| `deepgram.stt()` | `DEEPGRAM_API_KEY` |
| `elevenlabs.stt()`, `elevenlabs.tts()` | `ELEVEN_API_KEY`, or `ELEVENLABS_API_KEY` |
| `cartesia.tts()` | `CARTESIA_API_KEY` |

`KUGELAUDIO_API_BASE` points the KugelAudio providers at another endpoint.

## Voice

| Variable | Default | What it does |
|---|---|---|
| `VOICE_ENDPOINTING_MIN_MS` | `300` | The shortest pause that can end a turn |
| `VOICE_ENDPOINTING_MAX_MS` | `3000` | The longest wait before a turn ends |
| `VOICE_SILENCE_FOLLOWUP_MS` | `6000` | Silence before the agent checks in |

## LiveKit

| Variable | What it does |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Your LiveKit server or Cloud project. All three, or `curb dev` names what is missing |
| `CURB_REALTIME_SESSION_URL` | Asks this URL for each call's room and tokens, in place of the three above |
| `CURB_AGENT_NAME` | The name a worker registers under. Default: the `name` in `package.json` |
| `LIVEKIT_AGENTS_LOG_LEVEL` | Log level of the LiveKit agent runtime. Default `warn` |

## Running

| Variable | Default | What it does |
|---|---|---|
| `PORT`, `WS_PORT` | `4000` | The port. `WS_PORT` wins. An explicit port is used exactly; otherwise `curb dev` takes the next free one |
| `WS_HOST` | `127.0.0.1` | The address to listen on |
| `AGENT_DEFAULT` | the first by name | The agent a project with several starts with |
| `AGENT_LLM_TIMEOUT_MS` | `60000` | How long a model may take to answer |
| `KUGEL_CONVERSATIONS_DB` | a local file | Where conversations are recorded. `off` turns it off ([The preview](./preview.md#recorded-conversations)) |
| `CURB_NO_OPEN` | | `1` keeps `curb dev` from opening the browser |
| `CURB_CDN` | `https://cdn.kugelaudio.com/curb` | Where `curb upgrade` looks. Set it to a mirror |
| `MCP_SERVERS_FILE` | `mcp.servers.json` | The servers added in the preview |
| `MCP_AUTH_DIR` | `.mcp-auth` | Where MCP sign-ins are stored |
| `MCP_<ID>_TOKEN` | | A bearer token for the MCP server with that id |

## Runner

These apply to a built artifact, and to `curb dev` and `curb start` with a management port
([Self-hosting](./hosting.md)).

| Variable | What it does |
|---|---|
| `CURB_MANAGEMENT_ADDR` | `host:port` for host protocol v1. Absent means not managed |
| `CURB_MANAGEMENT_TOKEN` | The bearer token, one per runner. Required with the address |
| `CURB_MAX_SESSIONS` | Concurrent calls. Default `1` |
| `CURB_DEPLOYMENT_ID` | Optional: which deployment this runner is |
| `CURB_CONFIGURATION_VERSION` | Optional: a positive integer |
| `CURB_REALTIME_URL`, `CURB_REALTIME_TOKEN` | Join this one room directly and serve one call |
| `CURB_SESSION_ID` | The call's id on a direct join. Default: the room name |
| `CURB_READINESS_PROBE` | `1` loads the bundle, builds the agent and exits |

## `package.json`

```json
{
  "curb": {
    "requiredRuntimeSecrets": ["KUGELAUDIO_API_KEY"]
  }
}
```

`curb build` writes these names into `curb.bundle.json`. A deployment or call then fails before a
runner starts when one cannot be resolved ([Self-hosting](./hosting.md)).

## Next steps

- [CLI](./cli.md): every command.
- [Self-hosting](./hosting.md): the ways to run an agent.
