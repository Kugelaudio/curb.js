# Testing

Three commands tell you whether an agent works, with no browser, microphone or
LiveKit: `curb check` says whether it builds, `curb say` says how it behaves
turn by turn, and `curb test` whether whole conversations still work. Run them
after every change, in that order.

## Test the agent you built

`curb say` plays one caller turn from the terminal and prints the tool calls and what the turn added
to the context. A coding agent uses the same commands.

```bash
npx curb check
npx curb say --new "A pipe burst at home last night"
```

Keep a conversation as a test:

```ts
// src/agent/report-claim/report-claim.scenario.ts
import { scenario } from "curb/testing";

export default scenario({
  name: "opens a claim",
  turns: ["A pipe burst at home last night"],
  expect: ({ called }) => [called("open_claim")],
});
```

```bash
npx curb test
```

Each `curb say` and `curb test` turn calls the LLM, so it costs tokens like a real call.

## 1. `curb check`: does it build?

```bash
npx curb check
```

It type-checks every file under `src/` with the project's `tsconfig.json`,
renders the whole agent with every skill loaded, and reads the source of every
skill, including branches that are not rendered yet. Each finding has a stable
code, a `file:line` location and a fix ([Diagnostics](./diagnostics.md)).
It exits 1 when there is an error.

Agent code runs through tsx, which does not check types. Without the check, a
misspelled name in a tool's `onSubmit`, or in a branch that only renders after
a tool call, fails only when that line runs: in the middle of a call. Fix every
error before you talk to the agent; fix the warnings too, they are almost
always real.

After the findings it prints a Configuration block: every environment
variable the agent needs, `set` or `missing` in `.env` or the environment, by
name only, never a value. `Providers` are the keys of the `llm`, `stt` and
`tts` that `<Agent>` and its `<Skill>` links choose, plus the variables they
can run without, such as `AZURE_SPEECH_REGION`, marked `(optional)`;
`Project code` is what
your code under `src/` reads from `process.env`, with the `file:line` of the
read, and the names in `package.json` `curb.requiredRuntimeSecrets`. To learn
whether a key is set, read this block instead of opening `.env`. A missing
value does not fail the check, because a hosted agent gets its values from the
platform. A variable your code reads that `.env.example` does not list is an
`AGENT_ENV_NOT_DECLARED` warning.

```text
Configuration (names only, never values; looked up in .env and the environment):
  Providers:
    KUGELAUDIO_API_KEY  set      llm kugelaudio, stt kugelaudio, tts kugelaudio
  Project code:
    ORDERS_API_URL      missing  src/agent/orders/skill.tsx:11
  A missing value does not fail the check: set it in .env to run locally; a hosted agent gets it from the platform.
```

## 2. `curb say`: does it behave?

```bash
npx curb say "Put buy milk on my list"
```

It runs ONE caller turn through the same session a call uses: the same skills,
tools and context, and the spoken-reply rules a voice call adds. It calls the
LLM on your `curb login` or the key in the project's `.env`, so it costs tokens like a real call;
speech keys are not needed. It prints the reply, one line per tool call, any
error, and the context lines the turn added:

```text
Done, buy milk is on your list.
[tool add_task ok] {"title":"buy milk"}
[context added]
+ content: Open tasks: buy milk.
+ content: Added to the list.
[turn 1, no skill read]
```

A refused call shows why, after `->`:

```text
[tool complete_task refused] {"title":"bread"} -> No open task titled "bread". Retry with a title from the open task list.
```

A tool with `confirm` is held, not run: the reply is its read-back, and the next
`curb say "Yes"` runs it:

```text
[tool book_meeting held] {"email":"max@example.com"} -> runs on the caller's yes to "I'll book it for max@example.com, is that right?"
```

The next turn's words are checked as the answer first, and one line says how
they were taken, `yes`, `no` or `unclear`, and what became of the action:

```text
[confirmation no] "Ja, passt so. Wie lautet meine Schadennummer?": create_claim did not run
```

Only a `yes` runs the tool. A `no` drops the action, an `unclear` answer keeps
it waiting for a yes, and the model is told which.

The agent can hang up, as on a call: it has `end_call`, and the reply that ends
the call, the `goodbye` the agent passed to it, is followed by
`[the agent ended the call]`. That conversation is over: the next `curb say`
exits 1 until `--new` starts another.

### A conversation is several calls

Each `curb say` continues the conversation the previous one left, so a
scenario is one `curb say` per caller turn:

```bash
npx curb say --new "Hi, I'd like to file a claim"
npx curb say "Yes, everyone is safe"
npx curb say "I have photos of the damage"
```

`--new` starts a new conversation with its turn; `curb say --new` alone just
resets. Between calls the conversation is kept in `.curb/say-session.json`:
the transcript, the loaded skills, the page info (`--client`), and the state of
every `createAgentStore` store. Component state (`useState`) starts fresh on every `curb say` run, so keep
anything a later turn depends on in a store. Tool calls are not run again
when a conversation continues: a booking made in turn 1 is not booked twice.
After you change the agent's code, start the scenario over with `--new`.

A turn that failed (no key, a provider error, a timeout) is not added to the
conversation: fix the cause and run the same `curb say` again. A turn that ran
a tool before it failed (a booking, a yes the caller gave) is saved anyway, so
the tool does not run twice: continue with the next caller line, or start over
with `--new`. `curb say` notes which tools ran.

A new conversation opens as a call does, before the caller's first words: an
agent with `firstTurn: "agent"` greets (a model call), one with
`firstTurn: { say }` says its line (no model call). The opening prints first,
each of its lines marked `(opening)`:

```text
(opening) Ich bin Clara, die digitale Assistentin von Beispiel GmbH.
Gern, worum geht es?
[turn 1, no skill read]
```

### Faking a tool

A turn that runs a tool runs it for real: a meeting is booked, a claim is
filed. To play such a turn without touching the real system, fake the tool with
`--fake <tool>`. Its `onSubmit` never runs; its calls get a result instead:

```bash
npx curb say --new --fake create_claim "Ich möchte einen Hagelschaden melden"
npx curb say "Ja, passt so."
```

```text
Ihr Schaden ist gemeldet.
[confirmation yes] "Ja, passt so.": create_claim ran
[tool create_claim faked] {"policy":"KV-123","damage":"Hagel am Dach"}
[turn 2, skill /claims]
```

The result is `{"ok":true,"message":"Done."}` unless you give one as JSON after
`=`, for example to see how the agent handles a failure:

```bash
npx curb say --fake 'create_claim={"ok":false,"message":"The claims system is down."}' "Ja, passt so."
```

The rest of the call is as without the fake: the tool checks the input as it
always does, so input it refuses is still refused, its success or error line
follows the result, and a tool with `confirm` still waits for the caller's yes.
Fakes are kept with the
conversation, like `--client`, so the `--fake` on the turn that starts it
covers every later turn, the yes included; a new result for a tool replaces the
old one, and `--new` starts without fakes. Repeat `--fake` for several tools.

### Exit code and JSON

`curb say` exits 1 when the turn errored: a provider error, a timeout, or the
step limit. The step limit (`[error step_limit]`) usually means the model kept
calling a tool that refused its input; read the refused lines above it.

`--json` prints one object instead, for scripts:

```json
{
  "opening": null,
  "reply": "Done, buy milk is on your list.",
  "confirmation": null,
  "toolCalls": [{ "name": "add_task", "input": { "title": "buy milk" }, "ok": true, "result": { "ok": true } }],
  "errors": [],
  "contextDiff": ["content: Open tasks: buy milk.", "content: Added to the list."],
  "skillPath": "",
  "turn": 1,
  "endedCall": false
}
```

`skillPath` is the skill the agent read last, and `""` while it has read none: a
conversation starts at the agent level, `agent.tsx` alone, and the text output
says `no skill read`. `errors` holds `{ "kind", "message" }` with `kind` one of
`failed`, `timeout`, `busy` or `step_limit`. `opening` is `{ "reply", "toolCalls", "errors" }` on the
turn that opened the conversation of an agent that speaks first, and `null`
otherwise. `confirmation` is `{ "tool", "readBack", "answer", "verdict", "ran" }`
when the caller's words answered a held action, and `null` otherwise. A tool
call held for the caller's yes has `heldFor` (its read-back), a faked one
`"faked": true`. `endedCall` is true when the agent hung up in this turn. Notes about
the saved conversation go to stderr, so stdout carries only the result.

## 3. `curb test`: do whole conversations work?

`curb say` plays one turn at a time; `curb test` plays whole conversations and
says pass or fail. A scenario is a file ending in `.scenario.ts` anywhere under
`src/`, for example next to the skill it tests:

```ts
// src/agent/booking.scenario.ts
import { scenario } from "curb/testing";

export default scenario({
  name: "books a follow-up", // optional, default: the file name ("booking")
  caller: {
    goal: "Book a follow-up call for next week",
    knows: "Name Max Mustermann, company Example GmbH, email max@example.com",
    language: "de", // optional, default: the agent's language
  },
  maxTurns: 12, // optional: the most caller turns, 12 by default
  expect: ({ called }) => [called("book_meeting")],
});
```

A file may hold several scenarios: besides its default export, every
`export const <name> = scenario({ ... })` runs too, named by its `name` or else
by the export (`forecast`).

The caller is one of two kinds:

- `caller`: an LLM plays a person with that goal. It answers the agent's last
  reply with one short spoken line, gives what it `knows` when asked, and
  hangs up when it is done. Use it for the paths real callers take.
- `turns: ["Hallo", "Ja, gern", ...]`: scripted lines, one per caller turn, the
  same words every run. Use them where the wording matters (a read-back, a
  refusal) and for edge cases a simulated caller would not try.

Run every scenario, or those whose name or file contains a filter:

```bash
npx curb test
npx curb test booking
```

Each scenario runs on a fresh session, the way a call does: spoken turns with
the voice rules, `end_call` available, and the agent's opening first when it
speaks first: its greeting (`firstTurn: "agent"`) or its fixed line
(`firstTurn: { say }`, no model call), as turn 0. Scenarios run one after
another. The report prints the call as it goes, then every check:

```text
--- books a follow-up (src/agent/booking.scenario.ts)
caller: Hallo, ich möchte einen Folgetermin für nächste Woche vereinbaren.
agent:  Gern. Auf welchen Namen und an welche E-Mail-Adresse?
caller: Max Mustermann, max@example.com.
  [tool book_meeting ok] {"name":"Max Mustermann","email":"max@example.com","day":"2026-10-27"}
agent:  Ich habe Sie für Dienstag, den 27. Oktober, eingetragen. Kann ich sonst noch helfen?
caller: Nein, danke. Tschüss.
agent:  Gern geschehen. Auf Wiederhören.
  [the agent ended the call]
  pass  no turn errors
  pass  no empty agent reply
  pass  no fallback line instead of a reply
  pass  no sentence repeated within a turn
  pass  the conversation ends cleanly: the agent ended the call (end_call) at turn 3
  pass  the caller reaches its goal: The agent booked the follow-up for Tuesday and confirmed it.
  pass  called book_meeting: turn 2: {"name":"Max Mustermann","email":"max@example.com","day":"2026-10-27"}
PASS books a follow-up (3 caller turn(s), 14.2s)

1 of 1 scenario(s) passed in 15.0s.
```

A caller line that answers an action held for the caller's yes is followed by
how it was taken, as in `curb say`:

```text
caller: Ja, passt so. Wie lautet meine Schadennummer?
  [confirmation no] "Ja, passt so. Wie lautet meine Schadennummer?": create_claim did not run
```

### Faking what must not run

A tool runs for real in every run of a scenario that calls it: what it books,
sends or deletes happens again on each run. Fake such a tool in the scenario:
`fakes` maps its name to the result its calls get, or to a function of the
call's input that returns one.

```ts
export default scenario({
  turns: ["Ich möchte einen Hagelschaden melden", "KV-123, das Dach", "Ja, passt so."],
  fakes: {
    create_claim: { ok: true, message: "Claim KV-123-7 created." },
    send_sms: (input) => ({ ok: true, message: `Sent to ${String(input.phone)}.` }),
  },
  expect: ({ called }) => [called("create_claim", { policy: "KV-123" })],
});
```

A fake replaces only `onSubmit`, and the transcript marks its calls
`[tool create_claim faked]`. The rest of the call is as on a real call: the
tool checks the input with its schema, rules and transforms included, so input
it refuses never reaches the fake and the fake gets what `onSubmit` would get;
the tool's success or error line follows the fake's result; a tool with
`confirm` runs the fake only on the caller's yes; and `called()` counts the
call. What `onSubmit` itself would have changed (a store, a skill it unlocks)
does not change. A tool with `onCall` instead of `onSubmit`, or one from an MCP
server, has no input check in Curb: its fake stands in for the whole call and
gets the input as the model sent it. A fake that no call used is noted under
the checks (`note  the fake for send_sms was never used: ...`), which fails
nothing; it often means a misspelled tool name, or a path the conversation did
not take.

### The checks every scenario gets

| Check | Fails when |
| --- | --- |
| no turn errors | a turn hit a provider error or a timeout, used up its steps, or a tool was refused 3 times in it (input the model cannot get right). A call held for the caller's yes is not a refusal. |
| no empty agent reply | the agent said nothing, other than on purpose (`skip_turn`) |
| no fallback line instead of a reply | the caller heard the framework's fixed apology instead of an answer |
| no sentence repeated within a turn | one reply says the same sentence twice |
| the conversation ends cleanly | an error stopped it, the simulated caller could not go on, or the agent hung up before the scripted lines were said. Reaching `maxTurns` passes. |
| the caller reaches its goal | (simulated caller only) a judge LLM reads the call and decides; its reason is shown either way |

The conversation stops at the first turn that reports an error.

### Your own checks

`expect` gets the transcript and these helpers, and returns a list of checks:

- `called(tool, input?)`: the tool ran, not refused, at least once. With
  `input`, only a call whose input has those values counts (text compared
  ignoring case). A value may be a pattern, `{ date: /^2026-10-/ }`, tested
  against the field's text. A call that returned `ok: false`, a fake's
  included, counts as refused: to test a failure path, read it from
  `transcript` with `check`.
- `notCalled(tool)`: the tool never ran.
- `said(text)` or `said(/pattern/)`: an agent reply contains the text (ignoring
  case) or matches the pattern.
- `endedCall()`: the agent hung up itself.
- `check(name, condition, detail?)`: anything else, computed from `transcript`.

```ts
expect: ({ called, notCalled, said, check, transcript }) => [
  called("book_meeting", { email: "max@example.com" }),
  notCalled("cancel_meeting"),
  said(/dienstag/i),
  check("asks for the email once", transcript.filter((turn) => turn.reply.includes("E-Mail")).length === 1),
],
```

`transcript` holds one entry per turn: `turn`, `caller` (null for the agent's
opening), `reply` (what the caller heard), `confirmation` (how the caller's line
answered a held action: `tool`, `readBack`, `answer`, `verdict` and `ran`; null
when none waited), `toolCalls` (`name`, `input`, `ok`, `result`, `heldFor` when
it waits for the caller's yes, and `faked` when a fake answered it), `errors`,
`contextDiff`, `skillPath`, `skipped` and `endedCall`. `expect` may be async,
for example to read back what a tool stored.

A scenario without `expect` has no checks of its own: only the built-in checks
run, and its report notes that.

### Exit code and JSON

`curb test` exits 1 when a scenario fails, when there is no scenario, or when
the filter matches none. `--json` prints one object instead, for scripts:

```json
{
  "passed": true,
  "scenarios": [
    {
      "name": "books a follow-up",
      "file": "src/agent/booking.scenario.ts",
      "mode": "simulated",
      "passed": true,
      "endedBy": "agent",
      "durationMs": 14200,
      "turns": [
        { "turn": 1, "caller": "Hallo, ...", "reply": "Gern. ...", "confirmation": null, "toolCalls": [], "errors": [] }
      ],
      "checks": [{ "name": "no turn errors", "pass": true }],
      "notes": []
    }
  ]
}
```

`endedBy` is `agent` (end_call), `caller` (the simulated caller hung up),
`script` (the last line was said), `max_turns`, `error` or `simulator` (the
simulated caller gave no line). `notes` holds what fails nothing but is worth
knowing: a fake that no call used, and a scenario without checks of its own. A
scenario file that cannot be loaded is reported as
`{ "name", "file", "passed": false, "error" }`.

### What it costs and what it touches

- Every turn calls the agent's LLM as a real call does, on your `curb login` or
  the key in the project's `.env`; speech keys are not needed. A missing LLM key stops the run
  before the first turn and names the variable.
- The simulated caller and the judge run on the agent's own provider, on a
  small fast model: `claude-haiku-5-5` for Anthropic, `gpt-5.4-mini` for
  OpenAI, and the agent's own model on an OpenAI-compatible endpoint.
- Tools run for real unless the scenario fakes them. Fake every tool that
  books, sends or deletes something (`fakes`, above), or point it at test data.
- A simulated caller can take another path on the next run. Scripted turns
  repeat exactly: keep a scripted scenario for every path that must never break.
- Test conversations are not recorded to the conversation store.

## Page info: `client.*`

A page the agent is embedded in can send page info about itself, which the
agent reads as `client.<key>` session info (see [Agents and skills](./agents-and-skills.md),
"Who speaks first", for what it is and why it is untrusted). Every way of
talking to the agent locally can send it, held to the same limits, and it is on
the conversation before the agent opens, so a `firstTurn: { say }` function
reads it:

- `curb say --client key=value` sets `client.<key>` before the turn. Repeat it
  for several keys. It is kept with the conversation for later turns (a new
  value for a key replaces the old one), and `--new` starts without it:

  ```bash
  npx curb say --new --client event=webinar-11-04 "Hallo"
  ```

- A scenario's `client` sets it before the call starts, so before turn 0:

  ```ts
  export default scenario({
    client: { event: "webinar-11-04" },
    turns: ["Hallo"],
    expect: ({ said }) => [said("webinar-11-04")],
  });
  ```

- `curb dev`: put it in the preview's own URL,
  `http://127.0.0.1:4000/?client.event=webinar-11-04`. Every conversation the
  page starts carries it, typed or spoken, and it stays in the URL as you
  navigate the preview.

A key outside the limits (a letter, then up to 39 letters, digits or
underscores) or a value longer than 256 characters is refused: `curb say` exits
1 with the reason, `scenario()` names it, and the preview shows it above the
input and sends the rest.

## Experiment variants: `experiment.*`

An agent that declares `defineAgent({ experiments })` gets one variant of each
per call, read with `useVariant(name)` (see [Agents and skills](./agents-and-skills.md),
"Goals and A/B experiments"). A hosting platform assigns them. Locally they are
drawn by the same rule:

- `curb dev`: every preview conversation draws its own, from a session id of
  its own, so a new conversation can get another variant. To try one variant, put
  the experiment's `fromClient` key in the preview's URL:
  `http://127.0.0.1:4000/?client.greeting=casual` for
  `fromClient: "greeting"`. A conversation `curb dev` resumes after a reload
  keeps the variants it had.
- A scenario's `experiments` pins a variant per experiment. Every experiment it
  leaves out gets a fixed variant, drawn for the session id
  `scenario:<file>:<name>` (the scenario's file under the project and its name),
  so a scenario gets the same variants on every run and passes or fails the
  same way; renaming it can change them. Its `client` page info picks through
  `fromClient` as a page's does:

  ```ts
  export default scenario({
    experiments: { greeting: "casual" },
    turns: ["Hallo"],
    expect: ({ said }) => [said(/hallo|hi/i)],
  });
  ```

  A pin of an experiment or variant the agent does not declare stops
  `curb test` with the names it does declare. Keep one scenario per variant
  for every path that must hold in both.
- `curb say` assigns none, so `useVariant` returns `undefined` there.

## Hooks: `curb hook`

`curb dev` and `curb say` never fire `afterCall` or `afterEvaluation`
([After-call code](./after-call-code.md)). Run one yourself, on a call you describe:

```bash
npx curb hook afterCall --call fixtures/call.json
```

The fixture holds a whole event, or a call object that may leave out whatever
the hook does not read: `{ "status": "failed" }` is enough, and curb fills in
the rest. The hook gets `.env` the way `curb say` does, and what it prints shows
up as it runs. The last line says how it ended, with the event's id and the time
it took. The exit code is 0 when it succeeded and 1 when it threw.

In a test of your own, `runHook` from `curb/testing` does the same in process.
It resolves with the event the hook received and rejects with what the hook
threw; `buildCallEvent` builds a valid event from a partial call:

```ts
import { buildCallEvent, runHook } from "curb/testing";
import { agent } from "./agent.js";

const event = await runHook(agent, "afterCall", { status: "failed" });
const evaluated = buildCallEvent("call.evaluated", {
  goals: [{ name: "booked", status: "reached", detail: null }],
});
await runHook(agent, "afterEvaluation", evaluated);
```

Both refuse what no real call produces, such as `goals` on a `call.ended` event
or a `transcript` on a call whose `content` is `not_stored`.

## The loop

1. Edit `src/agent/` (and `context/`).
2. `npx curb check` until it reports no errors.
3. Play the conversation: `npx curb say --new "<first caller line>"`, then one
   `npx curb say "<next line>"` per turn.
4. Read every turn, not just the reply: did the model read the right skill,
   call the right tool with the right input, and stay out of tools that should
   still be locked? The `[context added]` lines show what each call changed.
5. Fix, then repeat from step 2, replaying the conversation from `--new`.
6. When it works, keep it as a scenario, and run `npx curb test` so every
   earlier scenario still passes.

When the text behaves, boot `npm run dev` and listen: timing, interruptions
and voice are only audible on a real call ([The preview](./preview.md)).

## Next steps

- [Deploying](./deploying.md): put the agent live.
- [Improve from real calls](./improve-from-calls.md): fix an agent from a call that went wrong.
