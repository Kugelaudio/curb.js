# Knowing the caller

A call often starts with something already known: the number that dialed in, the page the caller
came from, the email of a logged-in visitor. Use it so the agent does not have to ask.

| Hook | What it reads | Can you trust it |
|---|---|---|
| `useAgentInfo()` | What the call knows: `caller.phoneNumber`, `call.direction` and more ([the full list](./voice-sessions.md#how-a-call-opens)) | Yes, the framework or your host set it |
| `useClient()` | What the caller's page said, the `client.*` keys | No, anyone can edit a link |

## `client.*` is written by the page

`useClient()` reads these keys as one object without the prefix,
`const { email, event } = useClient()`; a key the page did not send is `undefined`.
Whoever can edit a link or a page can set `client.*` to anything, so:

- Use it to prefill and to skip a question the page already answered (a logged-in
  visitor's email), never for access, identity or prices. No locked branch, skill, tool
  or account data depends on a `client.*` value; to know who the caller is, ask, or check
  in a tool against your own system.
- Treat it as untrusted text. Look a value up in a table you own rather than rendering it,
  so an unknown value renders nothing. When you do render one, quote it, keep it short, and
  render only the keys the agent needs.
- It may be absent: a visitor from another page, a link without its parameters, a context
  the host refused. The agent must work without it.

```tsx
import { Text, useClient } from "curb";

// Your own words for the events your links name. Any other value renders nothing.
const EVENTS: Record<string, string> = {
  "webinar-11-04": "the webinar on 4 November",
  "webinar-11-17": "the webinar on 17 November",
};

export function EventContext() {
  const { event } = useClient();
  const words = EVENTS[event ?? ""];
  return words ? <Text>The caller came from the page of {words}. Mention it in the greeting.</Text> : null;
}
```

With `firstTurn: "agent"` the agent greets once the caller is there. With
`firstTurn: { say }` it opens with exactly that line instead, with no model call, written
from the info above when `say` is a function ([Agents and skills](./agents-and-skills.md), "Who speaks
first"). Neither opening can be interrupted: the caller hears the whole opening line, speech
during it is not taken as a turn, and a message typed during it is answered once it has
played. A call attached to a conversation that already has turns (typing in the preview
before starting the call) does not open it with the line again.

## Tell the agent which event a call comes from

Attendees of a webinar click a call link, and the agent should know which webinar they come
from without asking. Name the event in the link, let the widget pass it on, and let the agent
look it up.

1. Make the call page from [the call link recipe](./web-calls.md#send-a-call-link-in-a-chat-or-an-email)
   and add `data-context-params="event"` to its widget tag. The widget then copies the page
   address's `event` parameter into the call's context (see
   [Tell the agent where a call comes from](./web-calls.md#tell-the-agent-where-a-call-comes-from)):

   ```html
   <script src="YOUR_WIDGET_SCRIPT"
     data-agent="YOUR_WIDGET_ID"
     data-position="inline"
     data-size="lg"
     data-label="Start the call"
     data-context-params="event"
     async></script>
   ```

2. Send each event's attendees their own link, such as
   `https://example.com/call?event=webinar-11-04` for one webinar and
   `https://example.com/call?event=webinar-11-17` for the next. Keep email addresses, names
   and anything else personal out of the link: whoever has the link can read it, and the
   context is stored with the call. To tell attendees apart, add a token that means something
   only to your own systems, such as `&t=8f3k2q`, and name it too:
   `data-context-params="event,t"`.

3. In the agent, map the event ids of your links to your own words, and render the sentence
   for the one the call came from. `useClient()` reads the call's context; its `event` is the
   link's `event`:

   ```tsx
   import { Text, useClient } from "curb";

   // Your own words for the events your links name. Any other value renders nothing.
   const WEBINARS: Record<string, string> = {
     "webinar-11-04": "our webinar on getting started",
     "webinar-11-17": "our webinar on advanced setups",
   };

   export function WebinarContext() {
     const { event } = useClient();
     const webinar = WEBINARS[event ?? ""];
     return webinar ? (
       <Text>The caller comes from {webinar}. Mention it in your greeting and answer questions about it.</Text>
     ) : null;
   }
   ```

   Render `<WebinarContext />` inside `<Agent>` in `src/agent/agent.tsx`, after
   `<SystemPrompt>`.

The agent knows the event from its first sentence. Anyone can edit a link, so the event is a
hint and never a reason to unlock anything: a value your table does not know renders nothing,
and the agent talks as it would without one.

## Pass what you already know (a logged-in user)

A visitor who is logged in on your website should not have to spell their email address
for the agent. Give the widget what your page already knows, and let the agent use it
instead of asking.

1. On the page, set the widget's `context` property once you know who is logged in, and set
   it to `null` when they log out:

   ```js
   customElements.whenDefined('kugelaudio-agent').then(() => {
     document.querySelector('kugelaudio-agent').context = { email: user.email, name: user.name }
   })
   ```

   The next call to start carries it (see
   [Tell the agent where a call comes from](./web-calls.md#tell-the-agent-where-a-call-comes-from)).
   The property stays in the page's memory and is never written into its HTML, so a session
   recording, which captures the HTML, does not capture the address. For the same reason, keep
   personal details out of the tag's `data-context`, even on a page rendered on the server.

2. In the agent, `useClient()` reads the call's context, each key without the `client.`
   prefix. Tell the model the address so it does not ask:

   ```tsx
   import { Instruction, useClient } from "curb";

   export function KnownCaller() {
     const { email } = useClient();
     // Text from the page: only something shaped like an address gets in.
     if (!email || !/^[^\s@"]+@[^\s@"]+$/.test(email)) return null;
     return <Instruction>{`The caller is logged in with the email address "${email}". Use it and do not ask for it.`}</Instruction>;
   }
   ```

   Render `<KnownCaller />` inside `<Agent>` in `src/agent/agent.tsx`, after
   `<SystemPrompt>`. Without an address it renders nothing, and the agent works as before.

3. Try it locally. `--client` gives the conversation the context a page would send:

   ```bash
   npx curb say --new --client email=max@example.com "Hi"
   ```

   Continue with a request that needs the address: the agent uses max@example.com instead of
   asking for it.

The page sets the context, and anyone who controls the page can change it. Use it to prefill
and to skip questions, never as proof of who the caller is or to unlock their account's data;
to act on an account, check the caller in a tool against your own system. Send only what the
agent needs: the context is stored with the call.

## Next steps

- [Calls from your website](./web-calls.md): how a page passes this context.
- [Who speaks first](./who-speaks-first.md): use it in the greeting.
