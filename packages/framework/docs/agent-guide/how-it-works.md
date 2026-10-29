# How it works — the renderer

The short version: **curb is a real React renderer.** Just like `react-dom`
takes a React tree and targets the browser DOM, curb takes your React tree and
targets an LLM's context. Same React, same components, hooks, and state, a
different render target.

## A renderer on top of React

React itself is two halves: the library you write components with, and a
*reconciler* that turns those components into a tree of host nodes and keeps
that tree in sync as state changes. `react-dom` plugs a browser-specific host
into the reconciler; React Native plugs in a native-view host. curb plugs in
its own host (via `react-reconciler`) whose "host nodes" are not DOM elements
but **semantic context nodes**: an instruction, a fact, a tool, a skill link,
a gate.

So when you write:

```tsx
<Instruction>Take the order.</Instruction>
<Tool name="add_drink" schema={…} onSubmit={…} />
```

there is no DOM and no HTML. The reconciler builds a tree of those semantic
nodes, and a compile step walks it into the two things a model actually needs:

```text
React JSX -> semantic node tree -> { system prompt + knowledge, tool definitions }
```

That compiled output is what gets sent to the LLM.

## Why a renderer, and not string templating

Because context management is state management. What the model may know and do
at a given moment is a function of application state, and React is the best
tool there is for "UI as a function of state." By making context a render:

- **State drives the agent for free.** When state changes, the tree
  re-renders, so the prompt and the tool surface for the model's next step are
  already different. No manual prompt assembly.
- **Gating is structural.** A tool that is not rendered does not exist for the
  model. You gate a capability by conditionally rendering it, exactly like
  hiding a button in a UI, not by adding "do not do X" to a prompt.
- **Composition and reuse work.** Skills are components; shared state is a
  store; patterns are just more components. The same mental model as any React
  app.

## The loop

1. A message arrives (typed, or spoken via streaming STT).
2. The current tree compiles to context + tools; the model is called. A
   conversation starts at the agent level, `agent.tsx` alone (system prompt,
   skills index, the tools every skill has); a skill joins once the model
   reads it.
3. The model's tool calls run your `onSubmit` handlers, which update state.
4. State change re-renders the tree, so the context and tools are already
   updated for the model's next step. `read_skill` (from `<Skill>` links)
   loads a skill's content into the tree the same way.
5. The reply streams back (sentence by sentence into TTS on voice).

One message gets up to 8 model steps (`defineAgent({ maxSteps })`). A few rules
decide what the caller hears:

- **Curb holds back the newest sentence before a tool call.** A step's
  sentences are said while the model writes them, each once the next one
  starts. When the step calls a tool, the sentence still held is dropped: a
  lone "Let me check that." in front of a tool call is never spoken or
  recorded, but when the model writes two or more sentences before one, all
  but the last were already said. The answer comes in the step after the
  result. For `end_call` the model passes its closing line as the tool's
  `goodbye`, and the session says it once the call ran, in full, before the
  call hangs up.
- **The transcript holds what was said.** What the model reads back next turn
  is exactly what the caller heard, and the steps of one reply are joined with
  a space.
- **An empty step is asked again once.** A model that ends a turn with no words
  and no tool call gets a second try; a second empty answer ends the turn with
  an `empty_reply` error.
- **A turn that cannot answer says so in the agent's language.** A provider
  error, a timeout, an empty reply twice, or running out of steps
  (`step_limit`) ends with a short fixed line in the agent's language (TTS
  language, else STT language, else English; de, en, fr, it, es, pt, nl, pl
  and ro have wording). The real cause goes to the turn's error event and the
  developer log. The transcript does not record the line, because the model
  never said it.
- **A missing LLM key stops the session before it starts.** A session whose
  LLM has no key in the environment fails with an `AgentAuthoringError` naming
  the variable (for example `KUGELAUDIO_API_KEY`), instead of apologizing on
  every turn.

The preview shows the same tree, rendered on the server under Node, as
interactive UI. See [preview.md](./preview.md) for how tools become forms,
gates become cards, and a conversation exposes transcript, audio, and rewind.

## Dates and time

Every LLM request carries one line with today's date, the time (24-hour) and
the time zone, then the next 14 days as weekday and date, in the agent's
language:

```text
Heute ist Freitag, 23. Oktober 2026, 17:51 Uhr (Europe/Berlin). Die nächsten Tage: Sa 24. Okt., So 25. Okt., …
```

The time zone is `defineAgent({ timeZone: "Europe/Berlin" })`, an IANA name,
and defaults to `"UTC"`. A name `Intl` does not know is an
`AGENT_INVALID_AUTHORING_PROP` error. The line is built fresh for every request
and opens the current context the model reads last; it is never rendered into
your tree, so it causes no context events. The model can resolve "tomorrow" or
"next Tuesday" from it, so you do not need a date tool or a date in your
prompt.
