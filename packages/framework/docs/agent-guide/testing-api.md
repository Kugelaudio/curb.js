# Testing

`curb/testing` declares conversations for `curb test`. How to use them is in the
[Testing guide](./testing.md).

| Export | What it does |
|---|---|
| `scenario` | Declares a conversation |

## `scenario`

```ts
// src/agent/claims.scenario.ts
import { scenario } from "curb/testing";

export default scenario({
  caller: { goal: "Report a broken windscreen", knows: "Policy number 12345678" },
  fakes: { open_claim: { ok: true, message: "Claim 42 is open." } },
  expect: ({ called }) => [called("open_claim")],
});
```

| Option | Type | Default | What it does |
|---|---|---|---|
| `name` | `string` | the file name | Shown in the report, matched by `curb test <filter>` |
| `caller` | `{ goal, knows?, language? }` | | A simulated caller. Give this or `turns` |
| `turns` | `string[]` | | Scripted caller lines. Give this or `caller` |
| `maxTurns` | `number` | 12 for a simulated caller | The most caller turns |
| `client` | object | | Page info the call starts with |
| `experiments` | object | | The variant, by experiment name |
| `fakes` | object | | Tools that must not run for real, each with the result its calls get, or a function of the input that returns one |
| `expect` | function | | Your own checks, run on the finished conversation |

## `expect`

`expect` gets the conversation and helpers, and returns a list of checks.

| Helper | Passes when |
|---|---|
| `called(tool, input?)` | The agent ran the tool without a refusal. With `input`, only a call with those values counts |
| `notCalled(tool)` | The tool never ran. A refused or held call still passes |
| `said(text)` | A reply contains the text, ignoring case, or matches the pattern |
| `endedCall()` | The agent ended the call itself |
| `check(name, pass, detail?)` | `pass` is true |

`transcript` holds every turn: `caller`, `reply`, `toolCalls`, `errors`, `skillPath`, `endedCall` and more.

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

## Next steps

- [Testing guide](./testing.md): `curb check`, `curb say` and `curb test`.
