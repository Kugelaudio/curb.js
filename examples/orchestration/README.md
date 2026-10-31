# Changing the orchestration

Curb runs one voice session and a project holds no code of it: there is no loop to replace.
You change how a call runs through the settings below, and this example uses each of them on
a booking line.

| What you change | Where | In this example |
|---|---|---|
| Who speaks first, in which words | `defineAgent({ firstTurn })` | a line built from the caller's page |
| The order of a conversation | `<Procedure>` | details, slot, booking, in that order |
| What needs the caller's yes | `<Tool confirm>` | the booking |
| How many steps one turn gets | `defineAgent({ maxSteps })` | 4 |
| How much history the model reads | `defineAgent({ maxTranscriptMessages })` | 30 |
| How many skills stay open | `defineAgent({ maxLoadedSkills })` | 1 |
| When a turn is over | `.env`: `VOICE_ENDPOINTING_*` | `.env.example` |

```bash
npx curb check
npx curb test
```
