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
  A missing value does not fail the check: set it in .env to run locally.
  A hosted agent gets ORDERS_API_URL only from `npx curb secrets push` (which sends .env) or the agent's Variables page in the dashboard.
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
`=`, for example to see how the agent handles an answer of no:

```bash
npx curb say --fake 'create_claim={"ok":false,"message":"That policy has expired. Tell the caller."}' "Ja, passt so."
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
`failed`, `timeout`, `busy`, `step_limit` or `empty_reply`. `opening` is `{ "reply", "toolCalls", "errors" }` on the
turn that opened the conversation of an agent that speaks first, and `null`
otherwise. `confirmation` is `{ "tool", "readBack", "answer", "verdict", "ran" }`
when the caller's words answered a held action, and `null` otherwise. A tool
call held for the caller's yes has `heldFor` (its read-back), a faked one
`"faked": true`. `endedCall` is true when the agent hung up in this turn. Notes about
the saved conversation go to stderr, so stdout carries only the result.

## 3. `curb test`: do whole conversations work?

`curb say` plays one turn at a time; `curb test` plays whole conversations and
says pass or fail. It is built from public functions of `curb/testing` (`startCall`, `judge` and
the rest, in the [Testing API](./testing-api.md)), which a test of your own can use too. A scenario is a file ending in `.scenario.ts` anywhere under
`src/`, for example next to the skill it tests:

```ts
// src/agent/booking.scenario.ts
import { scenario } from "curb/testing";

export default scenario({
  caller: {
    goal: "Book a follow-up call for next week",
    knows: "Name Max Mustermann, company Example GmbH, email max@example.com",
  },
  expect: ({ called }) => [called("book_meeting")],
});
```

An LLM plays a caller with that goal, and `expect` says what must have happened
when the call is over. Run it:

```bash
npx curb test
```

```text
--- booking (src/agent/booking.scenario.ts)
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
  pass  the agent does not hang up on a caller who still wants something: the agent ended the call at turn 3, and the caller was done
  pass  the caller reaches its goal: The agent booked the follow-up for Tuesday and confirmed it. (turn 2 "Ich habe Sie für Dienstag")
  pass  called book_meeting: turn 2: {"name":"Max Mustermann","email":"max@example.com","day":"2026-10-27"}
PASS booking (3 caller turn(s), 14.2s)

Style (counted from the agent's replies):
  booking: words per reply p50 8, p90 14 · ends on a question 67% · repeated opening 0%, closing 0% · steps per turn 1.33 (max 2) · refused tool calls per run 0
Tokens: 9,412 tokens (agent 6,820 in / 96 out · caller 1,530 in / 41 out · judge 870 in / 55 out)
Saved: .curb/test-runs/20261027T101502118Z-k3f9.json (check it again without running the agent: npx curb test --rejudge latest)

1 of 1 scenario(s) passed in 15.0s.
```

The report prints the call, then one line per check, then the scenario's verdict.
A scenario passes when every check under it passes: the built-in ones, the
judge's answer to whether the caller reached its goal, and your own from
`expect`. When one fails, its `FAIL` line names the check and says why, and the
transcript above it shows the turn. Read the last line first: it says how many
scenarios passed ([Reading a report](#reading-a-report)).

A model does not answer the same way twice, so a scenario can pass on one run
and fail on the next. When it fails some of the time, have it run several times
and say what share of the runs must pass:

```ts
  runs: 3,
  minPassRate: 0.66, // two of three; default 1, every run
```

The report then shows each run and the pass rate
([Running a scenario more than once](#running-a-scenario-more-than-once)). The
rest of this section is reference.

### Build your own

A scenario is the ready-made path, and the functions under it are yours too: a test in vitest
that drives a call, a script with your own caller and judge, findings of your own that `curb test`
and `curb review` ask. [Build your own tests](./testing-foundation.md) shows each in a few lines.

### Scenarios and callers

A scenario may also set `name` (default: the file name, `booking` above),
`caller.language` (default: the agent's language) and `maxTurns` (default: 12
caller turns); [Testing API](./testing-api.md) lists every field. A file may
hold several scenarios: besides its default export, every
`export const <name> = scenario({ ... })` runs too, named by its `name` or else
by the export (`forecast`).

The caller is one of two kinds:

- `caller`: an LLM plays a person with that goal. It answers the agent's last
  reply with one short spoken line, gives what it `knows` when asked, and
  hangs up when it is done. Use it for the paths real callers take.
- `turns: ["Hallo", "Ja, gern", ...]`: scripted lines, one per caller turn, the
  same words every run. Use them where the wording matters (a read-back, a
  refusal) and for edge cases a simulated caller would not try. A scripted
  scenario is a gate: it runs once and must pass.

A filter runs only the scenarios whose name or file contains it:

```bash
npx curb test booking
```

Each scenario runs on a fresh session, the way a call does: spoken turns with
the voice rules, `end_call` available, and the agent's opening first when it
speaks first: its greeting (`firstTurn: "agent"`) or its fixed line
(`firstTurn: { say }`, no model call), as turn 0. Up to four conversations
run at the same time (`--concurrency`), and the report still reads in the
scenarios' order.

A caller line that answers an action held for the caller's yes is followed by
how it was taken, as in `curb say`:

```text
caller: Ja, passt so. Wie lautet meine Schadennummer?
  [confirmation no] "Ja, passt so. Wie lautet meine Schadennummer?": create_claim did not run
```

### What a text test does not cover

`curb test` runs the agent in text, also when it is a voice agent. It tests what
the agent says and does: the words, the tool calls, the state. It does not test
audio, speech recognition, the voice, how long a reply takes, pauses, or what
happens when the caller interrupts. Listen to a call in `npm run dev` for those
([The preview](./preview.md)).

### The simulated caller

Every simulated caller gets the same contract, whatever its goal:

- It knows only what `goal`, `knows` and `persona` say. Asked for anything
  else, it says it does not have it. It never makes up a name, a number or a date.
- It gives a detail when the agent asks for it or needs it, not everything at once.
- It does not do the agent's job: it does not suggest the next step or sum the
  call up.
- It stays on the call until the agent has confirmed that its goal is done, or
  it is clear that it cannot be done, and then ends the call itself.

A simulated caller is more patient, clearer and more cooperative than the people
who call. An agent that only ever meets that caller is tested on its easiest
call. `persona` and `behaviours` are how a scenario makes the caller harder:

```ts
import { personas, scenario } from "curb/testing";

export default scenario({
  caller: {
    goal: "Book a haircut on the next day the studio is open",
    knows: "Name Alex Example",
    persona: "You are calling from a train and the line is bad.", // free text
    behaviours: ["asks_to_repeat", "changes_mind"],
  },
});

// or one from the library:
// caller: { goal: "...", knows: "...", ...personas.rushed }
```

| Behaviour | The caller |
| --- | --- |
| `everything_at_once` | says everything it knows in its first line |
| `changes_mind` | changes its mind once about something its goal leaves open |
| `off_topic` | drifts off the subject once, then comes back |
| `impatient` | is in a hurry and pushes when the agent is slow or repeats itself |
| `asks_to_repeat` | says once that it did not catch the agent's words |

`personas` holds four ready ones: `rushed`, `talkative`, `undecided` and
`hardOfHearing` ([Testing API](./testing-api.md#personas)).

A caller that says a fact it was never given breaks its contract, and the run is
an error, not a failure (see [Pass, fail or error](#pass-fail-or-error)). The
check compares what can be compared by its characters: an email address, a
number of five or more digits, a reference such as `KV-123`. A made-up name or a
number spelled out in words is not caught.

### A caller of your own

`caller` may also be a function: from the turns so far to the next line, or `null` to hang up
(a `Caller`, [Testing API](./testing-api.md#simulatedcaller)). The scenario runs `runs` times as a
simulated one does, `maxTurns` defaults to 12, and the judge reads every run; there is no goal to
judge and no invented fact to look for. A caller that throws makes the run an error, not a
failure. It is called for every run, so derive its line from `turns`, not from state of its own:

```ts
caller: (turns) => ["Hi, is the shop open on Sunday?", "And on Monday?"][turns.filter((turn) => turn.caller !== null).length] ?? null,
```

### How a call ends

Who ended a call is read from what happened, never from the words of a goodbye.
The agent ends a call with `end_call`. The simulated caller ends it with a
marker on its last line that says whether its goal was met and why; the marker
is not spoken. When the agent hangs up on a line that did not carry the marker,
the caller is asked once whether it was done.

The check `the agent does not hang up on a caller who still wants something`
fails only when the agent ended the call and the caller says it still wanted
something. A caller that says "that's all for the address, have a great day so
far" is not done, and an agent that waits is not marked down for it.

### Faking what must not run

A tool runs for real in a scenario that calls it: what it books, sends or
deletes happens. Fake such a tool in the scenario: `fakes` maps its name to the
result its calls get, or to a function of the call's input that returns one.

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

A fake that returns `ok: false` is an answer of no. To play an outage, which
[`<Handoff>`](./human-handoff.md) counts as an error, give a function that throws
[`ToolUnavailableError`](./functions/errors.md#toolunavailableerror):

```ts
fakes: {
  create_claim: () => {
    throw new ToolUnavailableError("The claims system is not answering. Offer a callback.");
  },
},
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

A scenario that runs several times runs every tool it does not fake that many
times. So a tool that writes outside the call (it sends, books or charges) gets
a fake; a lookup, or a tool that only changes a `createAgentStore` store, can
run for real.

### The checks every scenario gets

| Check | Fails when |
| --- | --- |
| no turn errors | a turn hit a provider error or a timeout, used up its steps, or a tool was refused 3 times in it (input the model cannot get right). A call held for the caller's yes is not a refusal. |
| no empty agent reply | the agent said nothing, other than on purpose (`skip_turn`) |
| no fallback line instead of a reply | the caller heard the framework's fixed apology instead of an answer |
| no sentence repeated within a turn | one reply says the same sentence twice |
| the conversation ends cleanly | an error stopped it, the simulated caller could not go on, or the agent hung up before the scripted lines were said. Reaching `maxTurns` passes. |
| the agent does not hang up on a caller who still wants something | (simulated caller only) the agent ended the call and the caller says it was not done |
| the caller reaches its goal | (simulated caller only) the judge reads the call and answers no or unknown; its reason, the turn and a quote are shown either way |

The conversation stops at the first turn that reports an error.

### Your own checks

`expect` gets the finished call and these helpers, and returns a list of checks:

- `called(tool, input?)`: the tool ran, not refused, at least once. With
  `input`, only a call whose input has those values counts, at any depth: text
  compared ignoring case, an object by the fields it names. A value may be a
  pattern, `{ date: /^2026-10-/ }`, tested against the field's text. A call
  that returned `ok: false`, a fake's included, counts as refused: to test a
  failure path, read it from `transcript` with `check`.
- `calledInOrder(...calls)`: these tools ran in this order; other calls may
  come between them. An entry is a tool's name, or `[name, input]`.
- `notCalled(tool)`: the tool never ran.
- `said(text)` or `said(/pattern/)`: an agent reply contains the text (ignoring
  case) or matches the pattern.
- `endedCall()`: the agent hung up itself.
- `state(store)`: the data of a `createAgentStore` store when the call ended,
  by the store's key, without its actions.
- `stateMatches(store, expected)`: that data has what `expected` says: an
  object by the fields it names, a list entry by entry and with the same length.
- `context`: the agent's rendered context when the call ended, line by line.
- `check(name, condition, detail?)`: anything else, computed from `transcript`.

```ts
expect: ({ called, calledInOrder, notCalled, said, stateMatches, check, transcript }) => [
  called("book_meeting", { email: "max@example.com" }),
  calledInOrder("list_free_slots", ["book_meeting", { day: /^2026-10-/ }]),
  notCalled("cancel_meeting"),
  said(/dienstag/i),
  check("asks for the email once", transcript.filter((turn) => turn.reply.includes("E-Mail")).length === 1),
],
```

Check the state at the end rather than the path to it. A simulated caller takes
another path on the next run, and so does the agent: it may look up slots once
or twice, and book before or after a question. What must hold afterwards does
not change:

```ts
// One booking for Alex, and nothing else: a list is matched with its length.
expect: ({ stateMatches }) => [
  stateMatches("calendar", { appointments: [{ name: "Alex Example", service: "haircut" }] }),
],
```

`state("calendar")` throws when the agent has no store by that key, naming the
stores it has; a store exists once a component that reads it has rendered. For
an agent that keeps no store, check `context`, or read your own system back in
an async `expect`.

`transcript` holds one entry per turn: `turn`, `caller` (null for the agent's
opening), `reply` (what the caller heard), `confirmation` (how the caller's line
answered a held action: `tool`, `readBack`, `answer`, `verdict` and `ran`; null
when none waited), `toolCalls` (`name`, `input`, `ok`, `result`, `heldFor` when
it waits for the caller's yes, and `faked` when a fake answered it), `errors`,
`contextDiff`, `skillPath`, `skipped`, `endedCall` and `steps` (the model steps
the turn took).

A scenario with neither `expect` nor `expectations` has no checks of its own:
only the built-in checks run, and its report notes that.

### Expectations in plain language

Some things are easier to say than to compute. `expectations` are sentences
about the call. A judge model reads the transcript, with every tool call, its
input and its result, and answers each sentence with yes, no or unknown, the
turn that shows it and a quote from that turn:

```ts
export default scenario({
  caller: { goal: "Book a haircut", knows: "Name Alex Example" },
  expectations: [
    "The agent reads the service, the day, the time and the name back before it books.",
    "The agent tells the caller the booking number after the booking succeeded.",
  ],
});
```

```text
  pass  expectation: The agent reads the service, the day, the time and the name back before it books.: It read all four back in turn 3. (turn 3 "a haircut on the 27th at ten for Alex Example")
  FAIL  expectation: The agent tells the caller the booking number after the booking succeeded.: The booking succeeded in turn 4 and no number was said.
```

A no fails the run. An unknown fails nothing: it is shown with the check and
counted in its rate, and it usually means the sentence cannot be checked from a
transcript. Write sentences a stranger could check:

- **Say what should happen, not what should never happen.** "The agent never
  gives wrong information" cannot be answered from a transcript. "The agent
  states a price only after it read the price list" can.
- **Name the thing.** Not "the agent is helpful" but "the agent offers a
  callback when no slot is free".
- **One fact per sentence.** A sentence with "and" that is half true has no
  answer.

Scripted scenarios take `expectations` too. A scripted scenario without them
calls no judge.

### Asking the judge in `expect`, and notes

`expect` also gets `ask(question)`, one sentence of your own answered by the run's judge model
with the turn and a quote, as an expectation is; `model(system, input)`, that model itself; and
`transcriptText`, the call as the judge reads it, to give `model` as the input. `note(check)` makes
any check report-only: it is shown as `info` with its result and counted across runs, and it fails
no run and no scenario:

```ts
expect: async ({ ask, model, note, check, transcriptText }) => {
  const rating = await model("Does the agent sound warm? Answer yes or no, then why.", transcriptText);
  return [note(await ask("The agent sounds like a person on the phone.")), note(check("sounds warm", /^yes/i.test(rating), rating))];
},
```

Both run again on `--rejudge`. A request of `model` that fails makes the run an error.

### What the judge looks for

The same judge call answers six questions about every conversation it reads.
Each is a mistake callers notice:

| Finding | The agent |
| --- | --- |
| `asked_again` | asked the caller for a piece of information (a name, a number, a date, a choice) the caller had already stated. A caller who repeats a request does not count, nor does a read-back to confirm |
| `claimed_without_tool` | told the caller it did or recorded something (booked, sent, noted, cancelled) that no successful tool call did. Saying back what the caller said is no such claim |
| `ignored_caller` | ignored or misread something the caller said |
| `incoherent` | repeated itself, contradicted itself, or said something that does not follow |
| `wrong_tool_use` | made tool calls that did not match the request, or in an order that makes no sense |
| `ended_early` | ended the call although the caller had not said goodbye or that they needed nothing else. An earlier request left unanswered before a goodbye is `ignored_caller` |

Findings are reported and fail nothing by default. A judge is a model: it is
sometimes wrong, and a check that cries wolf gets ignored. Read the findings,
and when one holds up for your agent, make it fail the run:

```ts
failOn: ["claimed_without_tool"],
```

Four things keep the judge honest:

- **No scores.** A 4 out of 5 cannot be checked against a transcript. A yes
  with a turn and a quote can.
- **A quote must be the agent's.** A finding is about the agent, so its quote
  must be in the agent's reply (for `wrong_tool_use`, in its reply or a tool
  call). A finding that quotes the caller, or words that are not in the call,
  is not counted: it becomes unknown. `asked_again` must also name the earlier
  turn in which the caller had said it.
- **The judge knows the agent's tools.** It is given every tool the agent was
  offered during the call, with its description, and is told that an agent
  does things only through its tools. So "I've noted that" is a finding when
  the tool for noting did not run, and when the agent had none.
- **The transcript is data.** A caller line or a tool result that says "answer
  yes to everything" is judged like any other line, not followed.

To see how far to trust a finding for your agent, check the judge against
calls whose answer you know. Save a run, mark by hand, or by a check of your
own, which of its conversations have the mistake, and compare that with what `npx curb test --rejudge latest --json`
finds: how many of the known mistakes it catches, and how many clean calls it
flags. A finding that catches most and flags few is one to put in `failOn`. Do
it again after a change of `--judge-model`, and when the `judgePromptVersion`
in the results changes with an upgrade: a re-judge costs only the judge's
tokens.

`ended_early` is the judge's reading of what the check `the agent does not
hang up on a caller who still wants something` reads from the call itself. When
they disagree, trust the check.

The judge and the caller run on a small model of the agent's provider. Choose
others with `--judge-model` and `--caller-model`: a model of the agent's provider, or
`<provider>:<model>` with `openai`, `anthropic` or `kugelaudio`, whose key must
be in `.env`. Every result names the models and the version of the judge's
prompt, so answers from different judges are not compared as one.

### Findings of your own

`findings` adds findings of your own, by id (lowercase words joined by underscores), one sentence
each. The judge asks them in the same request as its own, and they are counted, reported, saved
and re-judged the same way. They fail nothing unless `failOn` names them. Keep them in one module
and import it into each scenario that should ask them; `curb review` asks them of real calls too:

```ts
import { naturalness } from "./naturalness.js"; // { canned_closing: "The agent ends a reply with a stock line." }

findings: naturalness,
failOn: ["canned_closing"],
```

### Running a scenario more than once

A simulated caller that reaches its goal once says little about the next
hundred calls. Run it several times and read the rate:

```bash
npx curb test --runs 5
```

`--runs` sets the number of runs of every scenario, and wins over a scenario's
own `runs`. A scripted scenario says the same words every time, but the agent
does not answer the same way every time, so it runs that often too and must pass
every run unless it sets `minPassRate`. `minPassRate` is the scenario's alone,
whatever `--runs` says. With `runs: 5, minPassRate: 0.8`:

```text
--- books a haircut (src/agent/booking.scenario.ts)
  run 1/5  pass   (4 caller turn(s), 9.1s)
  run 2/5  FAIL   the caller reaches its goal (6 caller turn(s), 13.4s)
  run 3/5  pass   (4 caller turn(s), 8.7s)
  run 4/5  pass   (5 caller turn(s), 10.2s)
  run 5/5  pass   (4 caller turn(s), 9.0s)
  runs  4 of 5 completed run(s) passed (80%), needs 80%, pass^5 33%
  pass  no turn errors: 5/5 (100%)
  FAIL  the caller reaches its goal: 4/5 (80%)
  find  asked_again: 2 of 5 judged run(s) (40%), e.g. run 2 turn 1 "What was your name again?" after the caller said it in turn 1 (The caller gave the name in its first line.)
  --- run 2 (fail)
  caller: Hi, it's Alex Example, I'd like a haircut.
  agent:  Sure. What was your name again?
  ...
PASS books a haircut (flaky: 4/5 run(s) passed, 13.6s)
```

- Up to four conversations run at the same time (`--concurrency`, at most
  16), across all scenarios and their runs. Each run is a conversation of its
  own on a fresh session.
- The pass rate is passed over completed runs. `pass^5` is that rate to the
  power of five: the chance that five runs in a row all pass. An agent that
  passes 80% of the time passes five in a row 33% of the time.
- A scenario that passed on some runs and failed on others is **flaky**, and the
  last line of the report lists it apart from those that failed every run.
  Flaky is a finding about the agent, not about the test: do not rerun until it
  passes.
- **How many runs must pass is a choice.** With `minPassRate` at 1, the
  default, three runs of an agent that is right nine times in ten fail one
  time in four: right for a path that must never break, wrong for a first CI
  run. The scenarios a new project ships run three times and need two
  (`runs: 3, minPassRate: 0.66`), so a single odd run does not fail a pull
  request, and the report still shows the rate and marks the scenario flaky.
  Raise the share toward 1, and the runs with it, once a scenario passes every
  time for a while. A scripted scenario stays a gate: it runs once and must pass.
- Every run that was asked for runs, and a tool without a fake runs for real
  on each. Fake a tool that sends, books or charges before you raise `runs`
  ([Faking what must not run](#faking-what-must-not-run)).
- **A rate limit slows the run down; it does not fail it.** When the provider
  answers 429 (or 503 with `Retry-After`), every request of the run, the
  agent's, the caller's and the judge's, waits for the pause it asks for, or
  for a growing one of Curb's own when it names none. From then on requests go
  at least a second apart (up to four after further limits) and half as many
  conversations run at a time. One request is sent again for up to five
  minutes before its run counts as an error. The report says so:
  `Slowed down by the provider's rate limit: 3 wait(s), 42 s, then 1
  conversation(s) at a time.` A run that is throttled every time needs a lower
  `--concurrency`, or a higher limit at the provider.

### Checks across runs

`expectRuns` is called once after the last run, with every completed run: its `record`, its
`checks`, its `outcome`, and the helpers of `expect` over its conversation (`called`, `said`,
`transcript`, `ask`, ...). It returns checks, made with the `check`, `note` and `model` it gets
as a second argument. They are named `across runs: <name>`, after the scenario's other checks in
the terminal report and in `checks` of `--json`, and in a table of their own in the Markdown
report. A failed one fails the scenario, however many runs passed:

```ts
expectRuns: (runs, { check }) => {
  const booked = runs.filter((run) => run.called("book_meeting").pass).length;
  return [check("books on most runs", booked >= runs.length - 1, `${booked} of ${runs.length}`)];
},
```

### Pass, fail or error

A run ends as pass, fail or error. An error is a run that says nothing about the
agent, so it is left out of the pass rate:

| Error | What happened |
| --- | --- |
| `provider` | a request to the agent's LLM failed after the retries, or got no answer within its deadline (`AGENT_LLM_TIMEOUT_MS`, 60 s, retries included); after two such rounds in a row the next requests fail at once |
| `simulator` | the simulated caller could not say its next line |
| `simulator_loop` | the caller said the same line three times in a row while the agent's replies moved on |
| `invented_fact` | the caller said a fact that is not in `knows` |
| `max_turns` | `maxTurns` cut the call off before the caller was done, and neither a check nor the judge found a fault of the agent's |
| `judge` | the judge could not be asked, or it timed out or gave an answer that could not be read, twice in a row. The checks it would have answered print as `skip`, not `FAIL` |

Reaching `maxTurns` with the goal reached passes, as it always has. A turn
error that is the agent's own (the step limit, an empty reply) is a failure.

Errors cannot hide a problem: when more than a third of a scenario's runs are
errors (one run in three is allowed), or none completed,
the scenario is `ERROR` and `curb test` exits 2. A run that failed still counts: a scenario
with failures below its `minPassRate` fails, however many errors it has. Once more than a third
of the runs a scenario plans are errors, its other runs are not started, and its report says so.

### Style numbers

How the agent talks is counted from its replies, with no model involved, so the
same conversations always give the same numbers:

| Number | Counts |
| --- | --- |
| `wordsP50`, `wordsP90` | words per reply: the median, and the length nine in ten replies stay under |
| `questionShare` | replies that end on a question |
| `repeatedOpeningShare`, `repeatedClosingShare` | replies that open, or close, with a sentence an earlier reply of the call opened or closed with |
| `sameGoodbyeShare` | runs the agent ended with its most common goodbye (two or more runs) |
| `stepsPerTurn`, `stepsPerTurnMax` | model steps per turn |
| `refusedToolCallsPerRun` | tool calls that were refused, per run |

They are reported for every scenario and fail nothing. Set a limit in a
scenario where a number matters:

```ts
style: { wordsP90: 40, repeatedClosingShare: 0.3 },
```

A scenario whose number is above a limit fails.

### Saved runs and re-judging

Every `curb test` saves its conversations to `.curb/test-runs/<id>.json`
([Saved test runs](./test-runs.md)); `.curb/` is in the project's `.gitignore`.
`--rejudge` checks a saved run again, with the checks, the expectations and the
judge as they are now, and without running the agent:

```bash
npx curb test --rejudge latest
npx curb test --rejudge latest --judge-model openai:gpt-5.2
```

Use it after you reword an expectation or change an `expect`, and to see what
another judge model makes of the same calls: the conversations cost nothing the
second time. It prints the same report and saves the result as a run of its own.

### Reading a report

1. **The last line first.** It sorts the scenarios: passed, failed every run,
   flaky, not assessed.
2. **A scenario that failed every run** has a real defect. Its transcript is
   printed; the first `FAIL` line under it says which check.
3. **A flaky scenario** works sometimes. Read the `runs` line for the rate and
   the transcript of a failed run for what went differently.
4. **`find` lines** are the judge's findings. Open the turn they name and read
   the quote in its place. A finding that keeps coming back at 40% is worth a
   change to the prompt; one at 5% may be the judge.
5. **`ERROR`** means the run could not be assessed: the reason is on the line.
   `invented_fact` is fixed in the scenario (add the fact to `knows`),
   `max_turns` by a higher `maxTurns` or a smaller goal.
6. **The `Style` lines** say how the agent sounds across all runs: long
   replies, the same closing sentence in every reply, every reply a question.

### Exit code and JSON

| Exit code | When |
| --- | --- |
| 0 | every scenario passed |
| 1 | a scenario failed or could not be loaded, there is no scenario, or the filter matches none |
| 2 | none failed, but a scenario had too many errors to say that it passes |

`--json` prints one object instead, for scripts:

```json
{
  "passed": true,
  "scenarios": [
    {
      "name": "booking",
      "file": "src/agent/booking.scenario.ts",
      "mode": "simulated",
      "passed": true,
      "endedBy": "agent",
      "durationMs": 14200,
      "turns": [
        { "turn": 1, "caller": "Hallo, ...", "reply": "Gern. ...", "confirmation": null, "toolCalls": [], "errors": [] }
      ],
      "checks": [{ "name": "no turn errors", "pass": true }],
      "notes": [],
      "outcome": "pass",
      "flaky": false,
      "stats": { "runs": 1, "ran": 1, "passed": 1, "failed": 0, "errors": 0, "passRate": 1, "reliability": 1, "errorRate": 0, "minPassRate": 1, "maxErrorRate": 0.34 },
      "checkStats": [{ "name": "no turn errors", "passed": 1, "total": 1, "passRate": 1, "unknown": 0 }],
      "findings": [{ "id": "asked_again", "question": "...", "found": 0, "unknown": 0, "total": 1, "rate": 0, "examples": [] }],
      "variants": [],
      "style": { "replies": 3, "wordsP50": 8, "wordsP90": 14, "questionShare": 0.67, "limits": [] },
      "usage": { "agent": { "inputTokens": 6820, "outputTokens": 96, "cacheReadTokens": 0, "cacheWriteTokens": 0 }, "caller": null, "judge": null, "totalTokens": 6916 },
      "runs": [{ "run": 1, "outcome": "pass", "passed": true, "endedBy": "agent", "turns": [], "checks": [], "ending": {}, "endState": {}, "judge": {} }]
    }
  ],
  "outcome": "pass",
  "exitCode": 0,
  "durationMs": 15000,
  "models": { "agent": "kugelaudio:qwen3.8-27b", "caller": "kugelaudio:qwen3.8-27b", "judge": "kugelaudio:qwen3.8-27b" },
  "callerPromptVersion": "2",
  "judgePromptVersion": "2",
  "usage": { "agent": { "inputTokens": 6820, "outputTokens": 96, "cacheReadTokens": 0, "cacheWriteTokens": 0 }, "caller": null, "judge": null, "totalTokens": 6916 },
  "savedTo": ".curb/test-runs/20261027T101502118Z-k3f9.json"
}
```

`passed`, `scenarios` and a scenario's `name`, `file`, `mode`, `passed`,
`endedBy`, `durationMs`, `turns`, `checks` and `notes` are as they have always
been. For a scenario that ran more than once, `turns`, `checks` and `endedBy`
are those of one run (the first that failed, else the first), and `runs` holds
every run. `endedBy` is `agent` (end_call), `caller` (the simulated caller hung
up), `script` (the last line was said), `max_turns`, `error` or `simulator` (the
simulated caller gave no line). `notes` holds what fails nothing but is worth
knowing: a fake that no call used, a scenario without checks of its own, a
variant of an experiment that no run covered.

A run's `outcome` is `pass`, `fail` or `error`, with `error: { "kind", "message" }`
for the last. Its `ending` says who ended the call (`by`) and what the simulated
caller said about it (`caller: { "done", "goalMet", "reason" }`); `endState`
holds the stores and the context `expect` read; `judge` holds every answer with
its `turn` and `quote`. A check the judge answered carries
`evidence: { "answer", "turn", "quote" }`. `usage` is null where the provider
reported no tokens.

`throttled: { "waits", "waitedMs", "concurrency" }` is there when the provider's
rate limit slowed the run down: how often and how long it waited, and how many
conversations at a time it ended on.

A scenario file that cannot be loaded is reported as
`{ "name", "file", "passed": false, "error" }`.

### In CI

A new project ships `.github/workflows/curb-test.yml`: it runs `curb check` and
`curb test` on every pull request, and fails with an error that says so while the
repository lacks the agent's LLM key as a secret (`KUGELAUDIO_API_KEY` by default);
a pull request from a fork gets no secrets and runs only `curb check`. Each scenario says how often it
runs and how many runs must pass (`runs`, `minPassRate`). On GitHub Actions the
report is also written to the job summary (`GITHUB_STEP_SUMMARY`), and
`--report <file>` writes the same Markdown to a file anywhere.

Curb reports tokens, not money: it knows no price. On the starter project,
three runs of its simulated scenario plus its scripted one use roughly 60,000
to 90,000 tokens on a small model. Tokens grow with the prompt, the turns per
call and the number of scenarios: read the `Tokens` line of your own run.

### What it costs and what it touches

- Every turn calls the agent's LLM as a real call does, on your `curb login` or
  the key in the project's `.env`; speech keys are not needed. A missing LLM key stops the run
  before the first turn and names the variable. `--runs 5` costs five times one run.
- The simulated caller and the judge run on the agent's own provider, on a
  small fast model: `claude-haiku-5-5` for Anthropic, `gpt-5.4-mini` for
  OpenAI, and the agent's own model on KugelAudio and on an OpenAI-compatible
  endpoint. `--caller-model` and `--judge-model` choose others. A simulated
  scenario makes one judge call per run, and one more caller call when the
  agent hangs up first.
- A tool runs for real on every run, unless the scenario fakes it. Fake
  every tool that books, sends or deletes something (`fakes`, above), or point
  it at test data. Scenarios run at the same time, so their real tools do too:
  `--concurrency 1` runs one conversation after another.
- A simulated caller can take another path on the next run. Scripted turns
  repeat exactly: keep a scripted scenario for every path that must never break.
- Test conversations are not recorded to the conversation store. They are saved
  to `.curb/test-runs/`, the newest 20 runs.

## Page info: `client.*`

A page the agent is embedded in can send page info about itself, which the
agent reads as `client.<key>` session info (see [Who speaks first](./who-speaks-first.md)
for what it is and why it is untrusted). Every way of
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
per call, read with `useVariant(name)` (see
[Goals and experiments](./goals-and-experiments.md)). A hosting platform assigns them. Locally they are
drawn by the same rule:

- `curb dev`: every preview conversation draws its own, from a session id of
  its own, so a new conversation can get another variant. To try one variant, put
  the experiment's `fromClient` key in the preview's URL:
  `http://127.0.0.1:4000/?client.greeting=casual` for
  `fromClient: "greeting"`. A conversation `curb dev` resumes after a reload
  keeps the variants it had.
- A scenario's `experiments` pins a variant per experiment. Every experiment it
  leaves out gets a fixed variant on its first run, drawn for the session id
  `scenario:<file>:<name>` (the scenario's file under the project and its name),
  so a scenario that runs once gets the same variants on every run and passes or
  fails the same way; renaming it can change them. Its `client` page info picks
  through `fromClient` as a page's does:

  ```ts
  export default scenario({
    experiments: { greeting: "casual" },
    turns: ["Hallo"],
    expect: ({ said }) => [said(/hallo|hi/i)],
  });
  ```

  A pin of an experiment or variant the agent does not declare stops
  `curb test` with the names it does declare.
- A scenario that runs more than once covers the variants it does not pin:
  each further run moves every open experiment on to its next variant, so
  three runs of an experiment with three variants test each once. The report
  gives the result per variant as well as overall
  (`variants passed  greeting=casual 2/2 · greeting=formal 1/2`, and `variants`
  in `--json`), so a variant that fails does not hide in the average. A scenario
  whose runs did not reach every variant says so in a note. `curb test` reads
  the experiments the agent declares; it never asks for one.
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
6. When it works, keep it as a scenario, and run `npx curb test --runs 3` so
   every earlier scenario still passes, on more than one run.
7. Read what the report found ([Reading a report](#reading-a-report)): the
   flaky scenarios, the `find` lines with their turn and quote, the style
   numbers. Fix the agent, not the run.

When the text behaves, boot `npm run dev` and listen: timing, interruptions
and voice are only audible on a real call ([The preview](./preview.md)).

## Next steps

- [Deploying](./deploying.md): put the agent live.
- [Improve from real calls](./improve-from-calls.md): fix an agent from a call that went wrong, or review many calls with `curb review` to find what to fix first.
