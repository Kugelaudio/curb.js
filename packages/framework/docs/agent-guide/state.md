# State and conditional tools

Curb's main idea is on this page: what the model can do follows your state. Lock a tool behind a
check, and the model cannot route around it, because the locked tool is not in its request.

## Local state

`useState` works as it does in any React component. A skill's state lasts as long as the skill is
loaded ([Skill lifecycle](./skill-lifecycle.md)). This is the claim skill with one switch:

```tsx
// src/agent/report-claim/skill.tsx
import { useState } from "react";
import { Instruction, Tool, z } from "curb";

export default function ReportClaim() {
  const [verified, setVerified] = useState(false);
  if (!verified) return <>
    <Instruction>Ask for the policy number.</Instruction>
    <Tool
      name="verify_policy"
      description="Check the policy number."
      schema={z.object({ policy: z.string() })}
      onSubmit={() => { setVerified(true); return { ok: true, message: "The policy is verified." }; }}
    />
  </>;
  return <>
    <Instruction>Ask what happened and when, then call open_claim.</Instruction>
    <Tool
      name="open_claim"
      description="Open the claim."
      schema={z.object({ what: z.string(), when: z.string() })}
      onSubmit={() => ({ ok: true, message: "Claim opened." })}
    />
  </>;
}
```

The real requests of this skill are on [What the model receives](./what-the-model-receives.md#when-state-changes-the-tools-change).

## State that lasts the whole call

Keep state in a store when other skills need it, or when it must survive a skill unloading.

```tsx
// agent.tsx
export const useStore = createAgentStore<{
  procedureComplete: boolean;
  completeProcedure: () => void;
}>("insurance", (set) => ({
  procedureComplete: false,
  completeProcedure: () => set({ procedureComplete: true }),
}));

// property-damage/skill.tsx
const procedureComplete = useStore((s) => s.procedureComplete);
return procedureComplete ? (
  <Tool name="submit_property_damage_claim" … />
) : (
  <Text>Claim intake is locked: complete the claim procedure first. The submission unlocks afterwards.</Text>
);
```

This is the framework's core invariant pattern: the model **cannot route
around** a rule enforced by conditional rendering, because the locked tool is
absent from its context. Always pair a lock with text that tells the model
how to unlock it. Diagnostics do not read that text: `AGENT_POSSIBLY_LOCKED_BRANCH` flags a
branch that can never render, and a conditional `<Skill>` link that is the only way out of a
skill with no tool.
Every action your prompt or a tool result offers the caller needs its tool
rendered in that state: a result that offers a callback while no callback tool
is rendered makes a promise the model cannot keep.

`useAgentInfo((info) => info["caller.phoneNumber"])` reads host-injected
session info (e.g. caller ID on the voice bridge), selector-based. `useClient()` reads the
`client.*` keys without the prefix (`const { email } = useClient()`). They come from the
caller's page and are forgeable: prefill with them, but never lock a branch like the one
above on them (see [Knowing the caller](./knowing-the-caller.md#client-is-written-by-the-page)).
`useVariant(name)` reads the call's variant of an experiment (`experiment.<name>`; see
[Goals and experiments](./goals-and-experiments.md)).

## Unlock a tool only after a check

```tsx
import { Text, Tool, createAgentStore, z } from "curb";

const useAuth = createAgentStore<{ verified: boolean; verify: () => void }>("auth", (set) => ({
  verified: false,
  verify: () => set({ verified: true }),
}));

export default function Account() {
  const { verified, verify } = useAuth();
  return verified ? (
    <Tool name="read_balance" description="Read the balance." onCall={async () => ({ ok: true, data: { balance: 42 } })} />
  ) : (
    <>
      <Text>Locked: ask for the PIN and call check_pin.</Text>
      <Tool
        name="check_pin"
        description="Check the caller's PIN."
        schema={z.object({ pin: z.string() })}
        onSubmit={({ pin }) => {
          if (pin !== "1234") return { ok: false, message: "Wrong PIN. Ask once more." };
          verify();
          return { ok: true };
        }}
      />
    </>
  );
}
```

`read_balance` is not in the request until the check passes, so the model cannot call it,
whatever a caller says. Tell the model how to unlock what is locked.

**Unlock after a check** (a verified email, a PIN): there is no gate component. Render
it with state, as in [State that lasts the whole call](#state-that-lasts-the-whole-call): a tool that
checks and sets a store flag, a locked text that says how to unlock, and the content,
tools and `<Skill>` links once the flag is set. A `<Skill>` link rendered only then can
be discovered and loaded only after the check.

## Next steps

- [Instructions and context](./instructions-and-context.md): write what the model reads.
- [Knowing the caller](./knowing-the-caller.md): what a call already knows.
