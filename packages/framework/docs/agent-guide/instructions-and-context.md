# Instructions and context

Three things put words in front of the model:

| Component | Use it for |
|---|---|
| `<SystemPrompt>` | Who the agent is, once, at the top of `<Agent>`. It stays the same for the whole call |
| `<Instruction>` | What to do, such as "Ask for the policy number" |
| `<Text>` or plain JSX text | Facts the model reads, such as what the policy covers |

Keep instructions and facts separate. Long documents go in `context/` as Markdown, and a skill
renders one with `<Text src="policy/coverage-basics.md" />`. The file reaches the model in full
while its skill is loaded, so split documents by topic and put each in the skill that needs it.

## Write several lines

Write a system prompt, instruction or text that runs over several lines as ONE
template literal inside the component:

```tsx
<Instruction>{`
  Collect the caller's details before you promise anything.

  ## Order
  - name
  - phone number
  - what happened
`}</Instruction>
```

Plain JSX text cannot carry that structure. The JSX transform joins JSX text
onto one line before Curb ever sees it, so paragraphs, `## ` headings and `- `
lists written as JSX text reach the model as one run-on sentence. `curb check`
warns about it (`AGENT_PROSE_JSX_TEXT`) and shows the template-literal rewrite.

The compiler removes the indentation all lines share and the blank lines at the
start and end, and keeps the rest: paragraphs, headings, lists, line breaks and
`${...}` values. That holds in `<SystemPrompt>`, `<Instruction>` and `<Text>`,
inline `<Skill>` links included. Text that fits on one line, JSX or string,
compiles exactly as before.

The model gets the system prompt as written. In its context each multi-line
instruction or text stays one entry, with its continuation lines indented under
it:

```text
instruction: Collect the caller's details before you promise anything.

  ## Order
  - name
  - phone number
  - what happened
```

The preview shows the same text formatted, headings and lists included. Keep a
block in one literal: a one-line text written next to it becomes a paragraph of
its own.

## Next steps

- [Voice](./voice.md): choose how the agent hears and speaks.
