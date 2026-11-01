# Who speaks first

| `firstTurn` | How a conversation opens |
|---|---|
| `"user"` (default) | The agent waits for the caller. |
| `"agent"` | A call opens with one short greeting the model writes after the caller joins. The instruction behind it is framework-generated and hidden from the preview transcript. |
| `{ say: "..." }` | Every conversation opens with exactly that line, with no model call: a call speaks it, typed chat in the preview shows it, `curb say` and `curb test` start with it. |

Use `{ say }` when the opening words must not vary, for example a notice the
law requires before an AI assistant talks to someone. A greeting the model
writes cannot guarantee wording; this line is said as written:

```tsx
export const agent = defineAgent({
  app: MyApp,
  firstTurn: {
    say: "Ich bin Clara, die digitale Assistentin von Beispiel GmbH. Ich bin eine KI und kann Fehler machen. Wie kann ich helfen?",
  },
});
```

The line is the agent's first message in the conversation, so the model knows
it has already greeted and answers the caller's first words instead of
greeting again. On a call it is spoken with interruptions off, like the
`"agent"` greeting: the caller hears all of it, and a message typed meanwhile
is answered once it has played.

`say` can also be a function of the session info the conversation has when it
opens: `caller.*` on a call, and `client.*`, the page info. It gets a
read-only record and returns the words. Return words for every session,
including one without the key it reads:

```tsx
firstTurn: {
  say: ({ "client.event": event }) =>
    typeof event === "string"
      ? `Ich bin Clara, die digitale Assistentin von Beispiel GmbH. Schön, dass Sie vom ${event} kommen.`
      : "Ich bin Clara, die digitale Assistentin von Beispiel GmbH.",
},
```

`client.*` is what the web page the agent is embedded in says about itself
(the event it advertises, the campaign it came from). It is untrusted input
from that page, like a form field: use it to choose words, never to decide
what the caller may see or do. Every route holds it to the same limits: a key
is a letter followed by up to 39 letters, digits or underscores, and a value is
a string of at most 256 characters. To try it locally, see
[Testing](./testing.md) ("Page info: `client.*`").

`defineAgent` refuses a `say` with no words (`AGENT_INVALID_AUTHORING_PROP`).
A function that returns none, or throws, is reported when the conversation opens, and the
conversation goes on without the line. In a typed conversation the error appears in the preview and
the first message still gets its answer.

A phone call has no page to show a notice on. To tell a caller that the call is recorded, use
`firstTurn: { say }` for exact words, or `firstTurn: "agent"` and put the rule in `<SystemPrompt>`,
where the model says it in its own words.

## Next steps

- [Knowing the caller](./knowing-the-caller.md): what `client.*` holds, and where it comes from.
