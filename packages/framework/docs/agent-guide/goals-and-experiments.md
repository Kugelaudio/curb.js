# Goals and experiments

Goals work with any host that reports them. `curb build` writes goals and experiments into the
bundle (`curb.bundle.json`), and the host reports per call which goals it reached and which variant
it had. On KugelAudio, the results appear in the dashboard; hosting there is in closed alpha and
switched on per organization.

A goal says what counts as a successful call, for example "the caller booked a slot". An
experiment splits calls between variants of your agent, for example a formal and a casual
greeting, so you can see which variant reaches your goals more often. You declare both in
your agent's code, next to the agent itself, and they go live with your next
[deployment](./deploying.md).

## Declare goals and experiments

Add `goals` and `experiments` to `defineAgent` in `src/agent/agent.tsx`:

```tsx
import { defineAgent } from "curb";

export const agent = defineAgent({
  app: BookingAgent,
  goals: {
    booked: { description: "The caller booked a webinar slot", tool: "book_slot" },
    felt_easy: {
      description: "Booking felt easy",
      judge: "The caller says booking with the assistant was easy or pleasant.",
    },
  },
  experiments: {
    greeting: {
      description: "Formal vs casual opening",
      variants: { formal: 1, casual: 1 },
      fromClient: "greeting",
    },
  },
});
```

A goal is one of two kinds:

- **Tool goal** (`tool`): reached when the agent ran that tool during the call and the
  tool succeeded. Name one of your agent's tools. `npx curb check` warns when no tool of
  your agent has that name.
- **Judge goal** (`judge`): a sentence describing what should be true of the conversation,
  1 to 1000 characters. After the call, a language model reads the transcript and decides
  whether the sentence is true of the call. See [How judge goals are judged](#how-judge-goals-are-judged).

An experiment lists 2 to 6 variants, each with a weight from 1 to 100. The weights are
relative: `{ formal: 1, casual: 1 }` gives each variant half the calls, and
`{ formal: 1, casual: 3 }` gives `casual` three calls in four. Each call gets one variant
of every experiment when it starts and keeps it until it ends. The same call always gets
the same variant, so you can trace any call back to the variant it had.

The limits:

- Goal, experiment and variant names start with a lowercase letter and have at most 40
  lowercase letters, digits and underscores, such as `booked` or `casual_v2`.
- At most 20 goals and 5 experiments per agent.
- A `description` is optional and holds at most 200 characters. It is for the people
  reading the results; the agent never sees it.

`npx curb check` reports goals and experiments outside these limits and names every
problem, and a deployment with them fails to build, so a mistake never reaches a live call.

### How judge goals are judged

Shortly after a call ends, a language model hosted in the EU, at Scaleway in Paris, reads
the call's transcript and answers whether your sentence is true of the call: yes
(**Reached**) or no (**Not reached**), with a one-sentence reason such as "The caller said
booking with the assistant was easy." The call's page shows the reason with the result.

The model receives only the transcript and your sentence: nothing else about the call,
your agent or your project. Each call is judged once, and its result does not change later.

- The model judges from the transcript alone, and the caller's words in it are what speech
  recognition heard. Write the sentence about what was said in the conversation; to check
  that something happened, such as a booking, use a tool goal.
- The call's conversation has to be stored. A call whose conversation is not stored has no
  transcript to judge, and its judge goals are **Not evaluable**.
- For a very long call the model reads the first 10,000 and the last 30,000 characters of
  the transcript, about forty minutes of conversation in total.
- When the model cannot answer for a call (it did not answer in time, it was unavailable, or
  its answer could not be read), that goal is **Not evaluable** for the call and the reason
  says why. It never counts as **Not reached**, and the call's other goals are decided as
  usual.

## Use the variant in your agent

`useVariant` returns the variant the current call got, so the agent can behave
differently per variant:

```tsx
import { Instruction, useVariant } from "curb";

function Greeting() {
  return useVariant("greeting") === "casual" ? (
    <Instruction>Greet the caller casually and use their first name when you know it.</Instruction>
  ) : (
    <Instruction>Greet the caller formally.</Instruction>
  );
}
```

Render it inside your `<Agent>`, like any other instruction. The variant is set before the
agent's first words, so the greeting can depend on it. `useVariant` returns `undefined` for
an experiment your agent does not declare.

## Choose a variant from the page

`fromClient` names a key of the context your web page passes to the call. When the call's
context has that key and its value is one of the experiment's variants, the call gets that
variant instead of a random one. Any other value is ignored and the call gets a variant by
weight as usual.

With `fromClient: "greeting"`, a widget tag with `data-context-params="greeting"` lets a link
choose the variant: `https://example.com/call?greeting=casual` always starts a call with the
casual greeting. Use this to send one audience to one variant, or to try a variant yourself
on the live agent. How a page passes context is in
[Tell the agent where a call comes from](./web-calls.md#tell-the-agent-where-a-call-comes-from).

## Try each variant locally

Every conversation in `npx curb dev` gets its own variants, chosen the same way as on a live
call, so a new conversation can get another variant. To try one variant, add the
experiment's `fromClient` key to the preview's address:

```text
http://127.0.0.1:4000/?client.greeting=casual
```

In a test scenario, `experiments` fixes the variant for that conversation. An experiment the
scenario leaves out gets a fixed variant chosen from the scenario's file and name, so the same
scenario runs with the same variants every time:

```ts
import { scenario } from "curb/testing";

export const casualGreeting = scenario({
  experiments: { greeting: "casual" },
  turns: ["Hallo, ich möchte einen Termin buchen."],
  expect: ({ called }) => [called("book_slot")],
});
```

Keep one scenario per variant for every conversation that has to work in each of them, and
run them with `npx curb test`.

## See the results

The dashboard shows goals and experiments; you change them only in code.

- Each call on your agent's **Calls** page shows the variant it got in every experiment
  and, shortly after the call ends, the result of every goal. The calls table has a
  **Goals** column and an **A/B test** filter that lists only the calls of one variant.
- The agent's **Goals** page shows each goal of the live version with how it is checked and
  how often calls reached it over the last 30 days, the same rates for every version, and
  for each experiment the share of calls, the number of calls and the goal rates of every
  variant.

Each rate comes with a 95% range. While the ranges of two variants or versions overlap,
the page says there are too few calls to tell them apart rather than naming a winner.
Calls whose goals are not judged or not evaluable are left out of the rates and counted
beside them.

A goal's result is one of:

| Result | Meaning |
|---|---|
| Reached | A tool goal's tool ran and succeeded during the call, or the model answered yes to a judge goal. |
| Not reached | The tool did not run or every run of it failed, or the model answered no to a judge goal. |
| Not judged | A judge goal of a call that ended before judging was available. |
| Not evaluable | The call's conversation is not stored, so there is nothing to evaluate it against, or the model could not answer for this call. The reason says which. |

Changing a goal or an experiment takes effect with the next deployment. Calls keep the
results and variants they had, so the calls of an earlier deployment still show what they
were measured against.

## What is allowed

- A goal has exactly one of `tool` or `judge`. A `tool` goal is reached when the agent ran that tool and it
  succeeded; `curb check` warns (`AGENT_GOAL_TOOL_NOT_DECLARED`) when no `<Tool>` has that name. A `judge`
  goal is a criterion of 1 to 1000 characters.
- An experiment has 2 to 6 variants with whole-number weights from 1 to 100.
- Names of goals, experiments and variants are a lowercase letter, then up to 39 lowercase letters,
  digits or underscores. An agent has at most 20 goals and 5 experiments, and a `description` holds at
  most 200 characters. `defineAgent` refuses anything else (`AGENT_INVALID_AUTHORING_PROP`), naming
  every problem.

`useVariant` returns `undefined` for an experiment the agent does not declare, and in `curb say` and `curb start`, which assign no variants. The
variant is the session info `experiment.<name>`, so a `firstTurn: { say }` function reads it as
`info["experiment.greeting"]`.

## Next steps

- [Deploying](./deploying.md): how goals and experiments reach a live agent, and what hosted deploys accept today.
- [After-call code](./after-call-code.md): act on the goal results of each call.
- [Testing](./testing.md): keep one scenario per variant.
