# After-call code

`afterCall` and `afterEvaluation` are two functions in your agent's code that run once a call is
over. Use them to update a CRM, send a summary or file a ticket. They live in your project, deploy
with your agent and read the same variables.

## Add a hook

Add one or both to `defineAgent` in `src/agent/agent.tsx`:

```tsx
import { defineAgent } from "curb";

export const agent = defineAgent({
  app: BookingAgent,
  goals: {
    booked: { description: "The caller booked a slot", tool: "book_slot" },
  },

  // Right after the call: the transcript and the call data are final.
  afterCall: async (call) => {
    console.log(`Call ${call.id} took ${call.duration_seconds} s`);
  },

  // Once the goals are judged: the same call, with the results.
  afterEvaluation: async (call) => {
    const booked = call.goals?.find((goal) => goal.name === "booked");
    console.log(`Booked: ${booked?.status}`);
  },
});
```

| Hook | Runs | `call.goals` |
|---|---|---|
| `afterCall` | Right after the call, on `call.ended` | `null` |
| `afterEvaluation` | Once the [goals](./goals-and-experiments.md) are judged, on `call.evaluated` | An array, `[]` when the agent has no goals |

Both run for every call, including one that failed, so check `call.status` when that matters. A
hook runs apart from the call: nothing it does reaches the caller, and a hook that fails does not
affect the call.

A hook is a plain async function, not a React component, so it cannot use `useVariant` or any
other React hook.

## What a hook receives

A hook is called with `(call, event)`. `event` is the whole event, the same JSON a webhook receives,
and `call` is its `data.object`. Field names are `snake_case` and times are Unix seconds.

| Field | Meaning |
|---|---|
| `event.id` | Stays the same every time this event is run. Use it to [do the work once](#do-the-work-once) |
| `event.type` | `call.ended` for `afterCall`, `call.evaluated` for `afterEvaluation` |
| `call.id` | The call |
| `call.status` | `completed` or `failed` |
| `call.livemode` | `false` for a test call |
| `call.direction`, `call.channel` | How the call came in, such as `inbound` and `sip` |
| `call.started_at`, `call.ended_at`, `call.duration_seconds` | When it ran, `null` for a call that never started |
| `call.client` | What the caller's page passed to the call, `{}` when nothing |
| `call.experiments` | The variant of each [experiment](./goals-and-experiments.md), `{}` when none |
| `call.transcript` | `{ complete, turns }`, where each turn has `role`, `text` and `created` |
| `call.call_data` | What the agent sent with `send.toHost`, as `{ name, payload }`. `payload` is `null` for a message too large to keep |
| `call.goals` | Each goal's `name`, `status` and `detail`. `status` is `reached`, `not_reached`, `not_judged` or `not_evaluable` |

`call.transcript` is `null` when the call stores nothing, and then `call.content` is `not_stored`
and `call.call_data` is `[]`. It is also `null` for a transcript too long to send, and then
`call.transcript_truncated` is `true`.

The types come from `curb`, for a hook in a file of its own:

```ts
import type { CallHook } from "curb";

export const logCall: CallHook = async (call, event) => {
  console.log(event.type, call.id);
};
```

## Do the work once

A hook can run more than once for the same event: a run that failed is run again, and in rare
cases a run that worked is too. Key the work on `event.id`, so the second run changes nothing:

```tsx
afterCall: async (call, event) => {
  const response = await fetch(`${process.env.CRM_URL}/calls`, {
    method: "POST",
    headers: { "idempotency-key": event.id, "content-type": "application/json" },
    body: JSON.stringify({ id: call.id, status: call.status }),
  });
  if (!response.ok) throw new Error(`The CRM answered HTTP ${response.status}`);
},
```

Throw when the work failed, so the run counts as failed and can be tried again.

## Time, retries and order

A run has 120 seconds. Past that it fails with `timeout`. A throw fails it too, with the thrown
error's message, which holds no stack trace and no value of the runner's environment.

On KugelAudio a run gets 3 attempts, the second after 30 seconds and the third 5 minutes later, and
a call's `afterEvaluation` starts after its `afterCall` has finished. There is no order between
different calls. After-call code needs a plan that includes it: on any other plan a hook does not
run, and its error says so.

On your own servers, your host decides when a hook runs and how often it is retried: see
[Hook runner](./hosting.md#hook-runner).

## Read your variables

A hook reads the agent's variables from `process.env`, as a tool does. Add the ones it needs to
`curb.requiredRuntimeSecrets` in `package.json`, so a forgotten one fails the deploy rather than a
run.

## Try it locally

`curb dev` and `curb say` never fire a hook, so a test conversation cannot write to your real CRM.
Run one yourself on a call you describe:

```bash
npx curb hook afterCall --call fixtures/call.json
```

The fixture can be a whole event, or only the fields your hook reads, and Curb fills in the rest:

```json
{ "status": "failed" }
```

The hook gets your `.env`, so point it at a test system. The last line says how the run ended, and
the exit code is 0 when it succeeded and 1 when it threw. To check a hook in a test of your own, use
[`runHook`](./testing-api.md#runhook).

## Next steps

- [Testing](./testing.md#hooks-curb-hook): `curb hook` and `runHook`.
- [Goals and experiments](./goals-and-experiments.md): what `afterEvaluation` reads.
- [Self-hosting](./hosting.md#hook-runner): run hooks from your own host.
