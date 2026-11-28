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

The booking tool is a typed value in `src/agent/booking/tools.ts`: the skill renders it, and the
tests fake it and check it by the same value. `src/agent/booking.scenario.ts` plays the whole call
from the greeting; `src/agent/booking/booking.scenario.ts` tests the booking skill alone, starting
inside it (`start: { skills: [Booking] }`) on a fixed day (`now`).

```bash
npx curb check     # also type-checks each fake against what the tool returns
npx curb test      # a second run with nothing changed answers from the reply store
```
