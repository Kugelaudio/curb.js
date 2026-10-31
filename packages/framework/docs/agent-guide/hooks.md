# Hooks

Hooks read the call and act on it, imported from `curb`. Use `useState` and `useEffect` from `react`,
as in any React project.

| Hook | What it gives you |
|---|---|
| `useRouter` | Load a skill from code |
| `useRoutePath` | The current skill's path |
| `useAgentInfo` | Everything the call knows |
| `useClient` | What the caller's page said |
| `useSession` | The active providers, and this call's identity |
| `useVariant` | This call's variant of an experiment |
| `useSend` | Send a message to the page or the host |
| `useMessage` | Handle a message from the page or the host |
| `useTransferCall` | Put the caller through to a number |

A hook made by [`createAgentStore`](./functions.md#createagentstore) holds state that lasts the
whole call.

## `useRouter`

```ts
const { push } = useRouter();
```

`push(path)` loads a skill and makes it active, from code. Use it when a tool's result decides what
comes next ([Complex handoffs](./complex-handoffs.md)).

## `useRoutePath`

```ts
const path = useRoutePath();
```

The active skill's path, or `""` before the model has read a skill.

## `useAgentInfo`

```ts
const info = useAgentInfo();
const number = useAgentInfo((info) => info["caller.phoneNumber"]);
```

All the call's info, or one value with a selector. Which keys exist is in
[How a call opens](./voice-sessions.md#how-a-call-opens). The agent re-renders when a selected value
changes.

## `useClient`

```ts
const client = useClient();
```

What the caller's page said, the `client.*` values without the prefix. Anyone can edit a link, so it
is never proof of identity ([Knowing the caller](./knowing-the-caller.md)).

## `useSession`

```ts
const { settings, call } = useSession();
```

| Value | What it is |
|---|---|
| `settings` | The effective providers |
| `call.sessionId` | The host's id for this call. On a LiveKit worker, the room name; in `curb dev`, the preview conversation's id |
| `call.scratchDir` | A writable directory of this call's own, removed when the call ends. Not set in `curb dev` |

`call` is set on every route. Read a call's identity here, never from `process.env`: a runner that
serves several calls has one environment for all of them.

## `useVariant`

```ts
const greeting = useVariant("greeting");
```

This call's variant of an experiment, or `undefined` where no variants are assigned
([Goals and experiments](./goals-and-experiments.md)).

## `useSend`

```ts
const send = useSend();
```

| Method | What it does |
|---|---|
| `toClient(key, payload?)` | Sends to the caller's page. A phone call has no page, so it is dropped with a warning |
| `toHost(key, payload?)` | Sends to the host. With no host, it is dropped with a warning |
| `askHost(key, payload?, { timeoutMs? })` | Sends to the host and resolves with its reply's payload. Rejects with `HostUnavailableError`, or `HostTimeoutError` after `timeoutMs` (10000) |

See [App messages](./app-messages.md).

## `useMessage`

```ts
useMessage("cart.updated", {
  from: "client",
  schema: z.object({ total: z.number() }),
  onMessage: ({ total }) => setTotal(total),
});
```

Handles every message with that key for as long as the component is mounted.

| Option | Type | What it does |
|---|---|---|
| `from` | `"client"` or `"host"` | Who may send it |
| `schema` | Zod schema | A payload it refuses is answered `invalid_payload` and never reaches `onMessage` |
| `onMessage` | `(payload, meta) => unknown` | What it returns is the reply to a client's `ask` |

## `useTransferCall`

```ts
const transfer = useTransferCall();
const { outcome, code, message, transferId } = await transfer({ to: "+493012345678" });
```

| Option | Type | Default | What it does |
|---|---|---|---|
| `to` | `string` | | The number in international format |
| `ringTimeoutSeconds` | `number` | `30` | How long it rings, 10 to 60 seconds |
| `announce` | `string` | none | Said to the caller before it dials |
| `onEnded` | decision or function | the agent takes the call back | What happens when the person hangs up and the caller stays ([When the person hangs up](./human-handoff.md#when-the-person-hangs-up)) |

`outcome` is `answered`, `no_answer`, `busy`, `failed` or `refused`. It never rejects for an outcome,
and throws `TypeError` for a bad request. See [Human handoff](./human-handoff.md).

## Next steps

- [Functions](./functions.md): `defineAgent`, stores and errors.
- [Components](./components.md): what an agent renders.
