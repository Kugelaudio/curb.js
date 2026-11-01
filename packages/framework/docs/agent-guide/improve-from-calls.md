# Improve an agent from real calls

The fastest way to improve an agent is to hand a coding agent a call that went wrong, let it
fix the cause, and let it prove the fix by talking to the agent itself. You need no test
script to start: the call is the test.

## 1. Copy the transcript

| Where the call happened | How to copy it |
|---|---|
| `curb dev` preview | **Copy for coding agent** in the conversation header: the transcript with the skill map, the tools and the system prompt ([The preview](./preview.md#copy-for-coding-agent)) |
| Hosted agent, dashboard | Open the call on the **Calls** page, open the **Copy or download** menu, choose **Copy transcript**: every turn and tool call as Markdown |
| Hosted agent, coding agent connected | Name the call; the agent reads it with `agent_get_call` and `agent_get_call_timeline` |
| `curb dev`, with no copy button at hand | `npx curb conversations --last 5` |

## 2. Have the coding agent improve it

Paste the transcript into your coding agent in the project folder, with one sentence about
what should have happened:

```text
Here is a call. The agent promised a callback but never recorded one. Find out why, fix the
agent, and keep this call as a scenario so it stays fixed.

<paste the transcript>
```

A project from `npm create curb.js` tells a coding agent how to work: its `AGENTS.md` names
the checks below, and the full guide is in `node_modules/curb/docs/agent-guide/`.

Before it changes a prompt, the coding agent should ask where the behaviour comes from. Most
wrong calls are one of these:

| What happened | Usually the cause | Fix |
|---|---|---|
| Used a tool it should not have had yet | The tool is always rendered | Render it only when state allows it |
| Promised something it cannot do | No tool for it in that state | Render the tool, or stop offering it |
| Opened the wrong skill | The skill's `description` | Rewrite it as a routing rule, with "NOT for" |
| Forgot something from earlier, or asked for it twice | `useState` in a skill that unloaded, or the transcript window | Move it to a store ([Skill lifecycle](./skill-lifecycle.md)) |
| `Unknown tool` after the caller changed topic | The tool is not rendered now: its skill unloaded, or its gate reset | Move the gate's state to a store, or read the skill again |
| Misheard a name | Speech recognition | `boostedPhrases` on `kugelaudio.stt()` |
| Said a name wrong | Text to speech | A [pronunciation dictionary](./pronunciation.md) |

## 3. Let the agent test itself

The coding agent runs the same loop you would, with no browser or microphone:

```bash
npx curb check                                  # does it build?
npx curb say --new "<the caller's first line>"  # replay the call, one line per turn
npx curb say "<the caller's next line>"
npx curb test                                   # do whole conversations still pass?
```

It reads the tool calls and context lines of each turn, not just the reply. `--fake <tool>`
keeps a booking or an email from happening for real. Each `curb say` and `curb test` turn calls
the agent's LLM, so it costs tokens like a real call.

Then it keeps the call, in a scenario file under `src/agent/`, usually in the skill's folder. When
the fix changes the call, keep the caller's lines that still make sense and rewrite the others:

```ts
// src/agent/callback.scenario.ts
import { scenario } from "curb/testing";

export default scenario({
  name: "records the callback it promises",
  turns: ["Nobody is answering at your office", "Yes, call me on 030 555 0100"],
  fakes: { request_callback: { ok: true, message: "The callback is recorded." } },
  expect: ({ called }) => [called("request_callback")],
});
```

`curb test` now fails if this ever breaks again ([Testing](./testing.md)).

## 4. Listen, then ship

Text checks cannot hear timing, interruptions or pronunciation. Run `npm run dev` and call the
agent once. Then put it live on [your own servers](./hosting.md), since hosted deploys do not accept a
project that installs Curb from npm yet, or from a browser project with `agent_publish`.

## Next steps

- [Testing an agent](./testing.md): every flag and check.
- [The preview](./preview.md): rewind, per-message audio and what the model read.
- [Diagnostics](./diagnostics.md): every code `curb check` can report.
