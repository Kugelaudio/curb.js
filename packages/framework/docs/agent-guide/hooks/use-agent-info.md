# `useAgentInfo`

All the call's info, one value with a selector, or the keys a skill declares. Which keys exist is
in [How a call opens](../voice-sessions.md#how-a-call-opens). The agent re-renders when a selected
value changes.

```ts
import { useAgentInfo } from "curb";

function useAgentInfo(): AgentInfo;
function useAgentInfo<T>(selector: (info: AgentInfo) => T): T;
function useAgentInfo(meta: SkillMeta): { readonly [key in keyof z.output<typeof meta.info>]?: ... };
```

Given a skill's `meta`, it returns only the keys `meta.info` declares, each parsed by its schema.
A key that is absent or does not fit reads `undefined`. When a required key is missing as the skill
opens, a test run fails and a real call logs `SKILL_INFO_MISSING` and goes on.

## Example

```tsx
function Caller() {
  const number = useAgentInfo((info) => info["caller.phoneNumber"]);
  return number ? <Text>The caller's number is {String(number)}.</Text> : null;
}
```

```tsx
export const meta = {
  title: "Billing",
  info: z.object({ "order.id": z.string(), "order.note": z.string().optional() }),
} satisfies SkillMeta;

export default function Billing() {
  const info = useAgentInfo(meta); // { "order.id"?: string; "order.note"?: string }
  return <Text>{`The order is ${info["order.id"] ?? "not known yet"}.`}</Text>;
}
```

A test that starts inside such a skill gives its keys in `start.info`; `curb check` reports a
required key it leaves out (`SCENARIO_INFO_MISSING`):

```ts
export default scenario({
  start: { skills: [Billing], info: { "order.id": "A-1042" } },
  turns: ["Why was I charged twice?"],
});
```

## Version history

| Version | Changes |
|---|---|
| v1.30.0 | `useAgentInfo(meta)` added |
| v0.1.2 | `useAgentInfo` introduced |
