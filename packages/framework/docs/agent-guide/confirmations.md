# Confirmations

A tool that books, sends, pays or cancels should run only after the caller has
said yes to exactly what will happen. Give it `confirm`: the question read back
to the caller, built from the validated input, in the agent's language.

Only for such actions. To repeat a name or a number back so the caller can correct
it, say it in the reply: a `confirm` tool makes the caller's next turn the answer to
its question, so a caller who simply goes on with the next detail leaves the tool
waiting and unconfirmed.

```tsx
<Tool
  schema={bookSchema}
  name="book_meeting"
  description="Book the chosen slot."
  confirm={(input) => `${input.start} for ${input.email}, is that right?`}
  onSubmit={async (input) => ({ ok: true, message: `Booked for ${input.start}.` })}
/>
```

1. The model calls `book_meeting`, and `onSubmit` does not run. The input is
   validated as for any call, the caller hears the `confirm` question word for
   word, and the turn ends there. The model's tool result says that nothing has
   happened yet.
2. The caller's next words are checked against that question with one short
   call on the agent's own LLM, which answers yes, no or unclear:
   - **Yes:** `onSubmit` runs and the model answers from its result. The
     transcript records the call with the words that confirmed it.
   - **No,** or a changed detail: nothing runs, and the model is told so. It
     handles the correction; calling the tool again reads the new details back.
   - **Unclear,** or the check failed: nothing runs, the question stays open,
     and the model asks once more.
3. While the question is open, the model's context shows
   `Waiting for the caller to confirm: "…"`. Calling the tool again replaces
   the open question; holding another `confirm` tool does too, and the model is
   told that the replaced action will not run.

The model cannot run a `confirm` tool itself: only the caller's yes on a later
turn does, in preview chat, local voice, hosted calls and tests alike.

- Only words that arrived after the caller heard the question answer it: in
  chat and tests as soon as it is said, on a call once it played to its end.
  Input already waiting, and the framework's silence follow-up, do not; a turn
  the caller cancels before the question is said asks nothing.
- On a call, a caller who speaks before the question played to its end has not
  been asked: their words drop it, and the model is told to call the tool again
  so the whole question is said.
- A yes runs the tool from the skill that asked. If that skill no longer owns
  the tool's name, nothing runs and the model is told.
- A step that asks never hangs up: an `end_call` in the same step is refused,
  and its goodbye is not said.
- Rewinding, or reopening a stored conversation, to just after the question
  keeps it open. Rewinding anywhere else drops it.
- A confirmed action is not replayed when a conversation is reopened or
  rewound; the preview names it as not replayed.
- Limit: when the model writes two or more sentences before the call in the
  same step, all but the last are said before the question. The tool's
  description already tells the model not to claim success, and nothing runs
  without the yes.

When you write one:

- Name what the caller must check (date, time, email, amount), so that a plain
  yes means "do exactly this".
- The question is said word for word. Build it only from the input the tool
  sends, never from a free-text field the model fills, such as a summary, so
  the yes approves exactly what runs. A phone number, IBAN or plate the tool
  sends belongs in its read-back.
- Throw `ToolInputError` in `confirm` to send the model back for better input,
  for example a slot that cannot be booked.
- Do not also ask for the confirmation in your prompt. The model is told that
  calling the tool asks the caller.
- If `onSubmit` fails after the yes (`{ ok: false }` or a thrown error), the
  model learns it like any failed tool call.
- `confirm` works on both `onSubmit` variants (`schema`, or `<Field>` children),
  inline or in `defineTool`.

## Next steps

- [Testing](./testing.md): keep the confirmation as a scenario.
