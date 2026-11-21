# Testing

`curb/testing` declares conversations for `curb test`. How to use them is in the
[Testing guide](./testing.md).

| Export | What it does |
|---|---|
| `scenario` | Declares a conversation |
| `personas` | A small library of simulated callers |
| `runHook` | Runs one of the agent's hooks in this process |
| `buildCallEvent` | Builds a valid call event for a hook |

## `scenario`

```ts
// src/agent/claims.scenario.ts
import { personas, scenario } from "curb/testing";

export default scenario({
  caller: { goal: "Report a broken windscreen", knows: "Policy number 12345678", ...personas.rushed },
  fakes: { open_claim: { ok: true, message: "Claim 42 is open." } },
  runs: 5,
  expectations: ["The agent tells the caller the claim number."],
  expect: ({ called }) => [called("open_claim")],
});
```

| Option | Type | Default | What it does |
|---|---|---|---|
| `name` | `string` | the file name | Shown in the report, matched by `curb test <filter>` |
| `caller` | `{ goal, knows?, language?, persona?, behaviours? }` | | A simulated caller. Give this or `turns` |
| `turns` | `string[]` | | Scripted caller lines. Give this or `caller` |
| `maxTurns` | `number` | 12 for a simulated caller | The most caller turns, at most 100 for a simulated caller |
| `client` | object | | Page info the call starts with |
| `experiments` | object | | The variant, by experiment name. An experiment left out is covered by repeated runs |
| `fakes` | object | | Tools that must not run for real, each with the result its calls get, or a function of the input that returns one. A tool without a fake runs for real on every run, so fake one that sends, books or charges |
| `runs` | `number` | 1 | How often the scenario runs, 1 to 100. `curb test --runs` overrides it for a simulated caller. Its tools without a fake run that many times |
| `minPassRate` | `number` | 1 | The share of completed runs that must pass, above 0 and at most 1 |
| `expectations` | `string[]` | | Sentences about the call that a judge answers with yes, no or unknown. A no fails the run. At most 12 |
| `failOn` | `JudgeFinding[]` | none | Built-in judge findings that fail a run when found |
| `style` | `StyleLimits` | none | The highest value accepted per style number, such as `{ wordsP90: 40 }` |
| `expect` | function | | Your own checks, run on the finished conversation |

### `caller`

| Field | Type | What it does |
|---|---|---|
| `goal` | `string` | What the caller wants from the call |
| `knows` | `string` | Everything the caller can tell the agent. It says no fact that is not here |
| `language` | `string` | The language it speaks. Default: the agent's |
| `persona` | `string` | Who the caller is and how they talk, in plain words |
| `behaviours` | `CallerBehaviour[]` | `everything_at_once`, `changes_mind`, `off_topic`, `impatient`, `asks_to_repeat` |

`JudgeFinding` is one of `asked_again`, `claimed_without_tool`, `ignored_caller`, `incoherent`,
`wrong_tool_use` and `ended_early`. `StyleMetric`, the key of a `StyleLimits`, is one of `wordsP50`,
`wordsP90`, `questionShare`, `repeatedOpeningShare`, `repeatedClosingShare`, `sameGoodbyeShare`,
`stepsPerTurn`, `stepsPerTurnMax` and `refusedToolCallsPerRun`.

## `expect`

`expect` gets the conversation and helpers, and returns a list of checks.

| Helper | Passes when |
|---|---|
| `called(tool, input?)` | The agent ran the tool without a refusal. With `input`, only a call with those values counts, at any depth |
| `calledInOrder(...calls)` | The agent ran these tools in this order; other calls may come between. An entry is a name or `[name, input]` |
| `notCalled(tool)` | The tool never ran. A refused or held call still passes |
| `said(text)` | A reply contains the text, ignoring case, or matches the pattern |
| `endedCall()` | The agent ended the call itself |
| `stateMatches(store, expected)` | The store's data at the end of the call has `expected`: an object by the fields it names, a list entry by entry and with the same length |
| `check(name, pass, detail?)` | `pass` is true |

`state(store)` returns the data of a [`createAgentStore`](./functions/create-agent-store.md) store when
the call ended, by its key and without its actions; it throws when the agent has no such store.
`context` holds the agent's rendered context at the end, line by line. `transcript` holds every turn:
`caller`, `reply`, `toolCalls`, `errors`, `skillPath`, `endedCall`, `steps` and more.

A check that a judge answered carries `evidence`: its `answer` (`yes`, `no` or `unknown`), the `turn`
and a `quote` from it.

## `personas`

```ts
import { personas, scenario } from "curb/testing";

export default scenario({
  caller: { goal: "Book a haircut", knows: "Name Alex Example", ...personas.undecided },
});
```

A simulated caller is more cooperative than the people who call. Each persona is a `persona` text and
the `behaviours` that go with it, to spread into `caller`:

| Persona | The caller | Behaviours |
|---|---|---|
| `personas.rushed` | is short on time and answers in a few words | `impatient` |
| `personas.talkative` | tells the whole story at once and wanders off the subject | `everything_at_once`, `off_topic` |
| `personas.undecided` | thinks out loud and revises a detail | `changes_mind` |
| `personas.hardOfHearing` | is on a bad line and asks for things again | `asks_to_repeat` |

Write your own as `{ persona: "...", behaviours: [...] }` (`CallerPersona`).

## `runHook`

```ts
import { runHook } from "curb/testing";
import { agent } from "./agent.js";

const event = await runHook(agent, "afterCall", { status: "failed" });
```

Runs one of the agent's [hooks](./after-call-code.md) in this process, as a host would: `(call, event)`,
within 120 seconds. The third argument is the fields of the call you care about, or a whole event. It
resolves with the event the hook received and rejects with what the hook threw.

## `buildCallEvent`

```ts
import { buildCallEvent } from "curb/testing";

const event = buildCallEvent("call.evaluated", {
  goals: [{ name: "booked", status: "reached", detail: null }],
});
```

Builds a valid event from a type and the fields you care about. The rest is a plain completed call.
It throws on what no real call produces, such as `goals` on a `call.ended` event or a `transcript` on
a call whose `content` is `not_stored`.

## Version history

| Version | Changes |
|---|---|
| v1.25.0 | `personas` added. `scenario` takes `runs`, `minPassRate`, `expectations`, `failOn`, `style`, and `caller.persona` and `caller.behaviours`. `expect` gets `state`, `stateMatches`, `context` and `calledInOrder`, and `called` matches nested input by the fields it names |
| v1.15.0 | `runHook` and `buildCallEvent` added |
| v1.4.33 | `curb/testing` introduced with `scenario` |

## Next steps

- [Testing guide](./testing.md): `curb check`, `curb say` and `curb test`.
- [Saved test runs](./test-runs.md): the file every `curb test` writes.
