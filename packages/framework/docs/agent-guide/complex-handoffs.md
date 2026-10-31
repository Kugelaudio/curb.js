# Complex handoffs

Project: `examples/complex-handoffs`. One agent, several kinds of handoff, each enforced by
what is rendered.

**Into a skill, by code.** The skill arrives as the result of the tool that opened it:

```tsx
const router = useRouter();

<Tool
  name="verify_customer"
  description="Look the caller up by their customer number."
  schema={z.object({ customerNumber: z.string() })}
  onSubmit={({ customerNumber }) => {
    const customer = CUSTOMERS[customerNumber];
    if (!customer) return { ok: false, message: "No customer has that number." };
    setCustomer(customer);
    router.push("/contract");
    return { ok: true };
  }}
/>
```

**To a skill with its own voice.** Props on the link apply while that skill is active, and a
store carries the customer across:

```tsx
<Skill path="/cancellation" description="Use when the caller wants to cancel." tts={kugelaudio.tts({ language: "en", voice: 1072 })}>
  Cancellation
</Skill>
```

**To a person, with a note, and a fallback.** Curb has no whisper: the person who picks up hears
nothing from the agent, and sees the number of the line that dials them, not the caller's. So send
the note ahead of the transfer. A failed transfer renders the callback tool:

```tsx
const transfer = useTransferCall();
const send = useSend();

<Tool
  name="hand_to_advisor"
  description="Record why the caller needs a person, then put them through."
  schema={z.object({ summary: z.string().describe("What the caller needs, in one sentence.") })}
  onSubmit={async ({ summary }) => {
    send.toHost("handoff.note", { customerId: customer?.id, summary });
    const { outcome } = await transfer({ to: "+493098765432", announce: "One moment, I am putting you through." });
    if (outcome === "answered") return { ok: true };
    setTransferFailed();
    return { ok: false, message: `The transfer ended as ${outcome}: nobody took the call.` };
  }}
/>
```

`send.toHost` puts the note on the call's **Data** tab on KugelAudio, and on the events stream of
your own host. With no host it is dropped with a warning. Neither reaches a person on a phone: to
do that, call your own system from the tool (a ticket, a text message) before the transfer.

There is no agent-to-agent handoff between two deployed agents, other than a phone transfer to
the other agent's number.

## Next steps

- [Human handoff](./human-handoff.md): the transfer itself, and every outcome.
- [App messages](./app-messages.md): what `send.toHost` can carry.
