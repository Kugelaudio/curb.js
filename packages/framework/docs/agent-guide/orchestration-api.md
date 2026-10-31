# Orchestration

`curb/orchestration` is server-only, for scripts that drive an agent themselves. A project never needs
it: Curb runs the voice session on every route ([Voice sessions](./voice-sessions.md)).

| Export | What it does |
|---|---|
| `createVoiceAgentBundle` | A runtime, session and voice settings for one agent |
| `buildVoiceProviders` | Builds the agent's STT and TTS |
| `buildVoiceStt` | Builds its STT |
| `buildVoiceTts` | Builds its TTS |
| `describeMissingVoiceEnv` | Names the voice keys that are missing |
| `VoiceProviderError` | A voice provider cannot be built |
| `createProviderSwitch` | Swaps STT or TTS during a call |
| `ConversationClips` | Holds a call's audio clips |
| `attachClientMessages` | Connects app messages to a room |
| `serveCall` | Serves host protocol v1 for one call |
| `createEndCallHangup` | What `end_call` does in a call |
| `END_CALL_TOOL_NAME` | `end_call` |
| `SKIP_TURN_TOOL_NAME` | `skip_turn` |
| `AutoSubscribe`, `defineAgent`, `llm`, `voice` | Re-exported from `@livekit/agents` |
| `silero` | Re-exported from `@livekit/agents-plugin-silero` |
| `RoomEvent` | Re-exported from `@livekit/rtc-node` |

## Next steps

- [Host protocol](./host-protocol.md): running calls from a host instead.
