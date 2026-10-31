# Complex handoffs

One agent, three kinds of handoff, each one enforced by what is rendered rather than by the
prompt:

1. **Into a specialist skill, by code.** `verify_customer` calls `useRouter().push`, so the
   model gets the contract skill as the result of its own tool call.
2. **Between skills with another voice.** `/contract` and `/cancellation` have their own `tts`
   on the `<Skill>` link, and the customer's data follows in a shared store.
3. **To a person, with what was said so far.** `/advisor` records a note, then transfers. A
   failed transfer unlocks the callback tool, so the model cannot promise one without it.

`src/agent/agent.tsx` holds the store and the skills index, and every skill has a folder. The
person picking up hears nothing from Curb, so the note goes to your own system before the
transfer: here `send.toHost`, which reaches a host that reads the call's events stream.

```bash
npx curb check
npx curb test
```

This is one agent. There is no agent-to-agent handoff between two deployed agents except a
phone transfer to the other agent's number.
