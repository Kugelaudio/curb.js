# Tools

A tool is what the model can call. Render a `<Tool>` in a skill, and it exists while that skill is
loaded. Add one to the claim skill:

```tsx
// src/agent/report-claim/skill.tsx
import { Instruction, Text, Tool, createAgentStore, z } from "curb";

const useClaim = createAgentStore<{ claim?: string; open: (claim: string) => void }>("claim", (set) => ({
  open: (claim) => set({ claim }),
}));

export default function ReportClaim() {
  const { claim, open } = useClaim();
  return (
    <>
      <Instruction>Ask what happened and when, then call open_claim.</Instruction>
      <Text>{claim ? `Claim opened: ${claim}.` : "No claim is open yet."}</Text>
      <Tool
        name="open_claim"
        description="Open a claim."
        schema={z.object({ what: z.string(), when: z.string() })}
        onSubmit={({ what, when }) => {
          open(`${what}, ${when}`);
          return { ok: true, message: "Opened." };
        }}
      />
    </>
  );
}
```

Until the model reads `/report-claim`, `open_claim` is not in the request at all
([What the model receives](./what-the-model-receives.md)).

The model reads `message` and `data`. A message on `ok: false` is an instruction to the model,
so say what to do next.

## Props

```tsx
<Tool
  schema={z.object({
    email: z
      .string()
      .email("Email address is invalid. Ask the user for a corrected email address.")
      .describe("Customer email address."),
  })}
  name="submit_property_damage_claim"          // snake_case verb, unique across the agent
  description="Submit a property damage claim intake."
  success="Property damage claim intake was accepted."
  onSubmit={(input) => ({ ok: true, data: input })}
/>
```

- `schema` is a Zod object, and the model gets its JSON Schema: lists, nested
  objects, `.nullable()` and `.optional()`, enums, number ranges, string formats
  and `.regex()` patterns, and every `.describe()` at any depth (before or after
  `.optional()`). `onSubmit` gets the parsed, typed value, so give a tool the shape
  it needs instead of a string to split:

  ```tsx
  schema={z.object({
    room: z.string().describe("The guest's room number."),
    items: z
      .array(
        z.object({
          name: z.string().describe("A dish or drink from the menu."),
          quantity: z.number().int().min(1).describe("How many."),
        }),
      )
      .min(1)
      .describe("Everything the guest ordered."),
  })}
  ```

  A `.default()` field may be left out. A refusal names where a nested problem is
  (`items.0.quantity: ...`); write validation messages as next-step instructions.
  A recursive schema or a type JSON cannot carry (`z.date()`, `z.bigint()`) is an
  authoring error; a date is `z.iso.date()` or `z.iso.datetime()`.
- `onSubmit` returns a `ToolResult`: `{ ok: boolean, message?, data? }`.
  Schema validation failures are generated automatically from the Zod
  messages; for handler-level failures return `{ ok: false, message }` or
  throw `ToolInputError`. Rendered `<ErrorMessage>` content becomes new
  context the model reads on its next step. Any other exception is logged on
  the server, and the model gets `{ ok: false }` with a generic "internal
  error" message instead of the raw error, so write `ToolInputError`
  messages for anything the model can fix.
- Tools inside `<GlobalTools>` exist from the first turn, whichever skills
  are loaded; tools inside a skill exist only while that skill is loaded.
- `tryWith` is optional input the preview's **Try** form opens with, typed from
  the schema, so trying a tool that needs real demo data takes one click; the
  model never sees it:

  ```tsx
  <Tool
    schema={verifySchema}
    name="verify_customer"
    description="Check the customer number and year of birth."
    tryWith={{ customerNumber: "K-482913", birthYear: "1985" }}  // a customer your demo data knows
    onSubmit={verify}
  />
  ```
- **Tool as an object.** The inline form above is best for showcasing a tool
  where it lives. To keep a tool next to the code that backs it, define it with
  `defineTool` (fully typed, like `defineAgent`) and pass it via `def`:

  ```tsx
  const submitClaim = defineTool({
    name: "submit_property_damage_claim",
    description: "Submit a property damage claim intake.",
    schema: z.object({ email: z.string().email().describe("Customer email address.") }),
    success: "Property damage claim intake was accepted.",
    onSubmit: (input) => ({ ok: true, data: input }),  // input is typed from the schema
  });

  // …in the tree:
  <Tool def={submitClaim} />        // equivalently: <Tool {...submitClaim} />
  ```

  Both compile to the same tool. The object supports every inline variant:
  `schema` + `onSubmit`, `onSubmit` alone, or `onCall`; you can also type an
  object by hand with the exported `ToolProps` type instead of `defineTool`.

## Calling your own API from a tool

```tsx
// .env.example lists ORDER_API_URL, such as https://shop.example.com/api/ (with the final "/").
async function orderApi(path: string): Promise<Response> {
  const base = process.env.ORDER_API_URL;
  if (!base) throw new Error("ORDER_API_URL is not set");
  return fetch(new URL(path, base), { signal: AbortSignal.timeout(5_000) });
}

const UNREACHABLE = "The order system is not answering. Tell the caller and offer to try again in a moment.";

<Tool
  schema={z.object({ order: z.string().min(1).describe("Order number, such as A-1234.") })}
  name="look_up_order"
  description="Look up the status of an order."
  onSubmit={async ({ order }) => {
    let response: Response;
    try {
      response = await orderApi(`orders/${encodeURIComponent(order)}`);
    } catch (error) {
      console.error("look_up_order: no answer from the order API", error);
      return { ok: false, message: UNREACHABLE };
    }
    if (response.status === 404) {
      throw new ToolInputError(`There is no order ${order}. Ask the caller to read the number again.`);
    }
    if (!response.ok) {
      console.error(`look_up_order: the order API answered ${response.status}`);
      return { ok: false, message: UNREACHABLE };
    }
    return { ok: true, data: await response.json() };
  }}
/>
```

- Read the base URL, and any key, from an env var listed in `.env.example`, so
  whoever runs or deploys the agent knows to set it.
- `new URL(path, base)` keeps the base's path only when the base ends with `/`
  and the path does not start with one: `new URL("orders/7", "https://shop.example.com/api")`
  is `https://shop.example.com/orders/7`, without `/api`.
- Give every request a timeout (`AbortSignal.timeout`): while a tool waits, the
  caller hears silence.
- Turn a failed request into `{ ok: false, message }` the model can say to the
  caller, and log the real error with `console.error`. An empty `catch {}`
  hides why calls fail.
- Throw `ToolInputError` for input the caller must fix, such as an order number
  that does not exist.

## Call an HTTPS API with a secret

A tool can call any HTTPS API on the internet (see
[what a running agent can reach](https://docs.kugelaudio.com/hosted-agents/how-it-runs#what-a-running-agent-can-reach)). Keep the
API's credential in a variable on the agent, and read it only inside the tool. This
example asks a calendar API for free slots with an app-only credential, one that belongs
to your application rather than to a person.

1. Put the credential in `.env`, which `npm run dev` reads:

   ```bash
   CALENDAR_CLIENT_ID=...
   CALENDAR_CLIENT_SECRET=...
   ```

   Send it to the agent with `npx curb secrets push`, or set it on the agent's
   **Variables** page.
2. Add the names to `curb.requiredRuntimeSecrets` in `package.json`. A version whose
   required variables are not set on the agent never goes live, so a forgotten secret
   fails the deploy rather than a call.

   ```json
   {
     "curb": {
       "requiredRuntimeSecrets": [
         "CALENDAR_CLIENT_ID",
         "CALENDAR_CLIENT_SECRET"
       ]
     }
   }
   ```

3. Read the variables in the tool, each time it runs:

   ```tsx
   import { defineTool, z } from "curb";

   // An app-only token from the calendar's sign-in server (OAuth client credentials).
   async function calendarToken(): Promise<string> {
     const clientId = process.env.CALENDAR_CLIENT_ID;
     const clientSecret = process.env.CALENDAR_CLIENT_SECRET;
     if (!clientId || !clientSecret) throw new Error("CALENDAR_CLIENT_ID or CALENDAR_CLIENT_SECRET is not set");
     const response = await fetch("https://login.example.com/oauth2/token", {
       method: "POST",
       body: new URLSearchParams({
         grant_type: "client_credentials",
         client_id: clientId,
         client_secret: clientSecret,
       }),
     });
     if (!response.ok) throw new Error(`Calendar token request failed with HTTP ${response.status}`);
     const { access_token } = (await response.json()) as { access_token: string };
     return access_token;
   }

   export const findFreeSlots = defineTool({
     name: "find_free_slots",
     description: "Find the free appointment slots on one day.",
     schema: z.object({
       date: z
         .string()
         .regex(/^\d{4}-\d{2}-\d{2}$/, "Ask which day, and pass it as YYYY-MM-DD.")
         .describe("The day, as YYYY-MM-DD."),
     }),
     onSubmit: async ({ date }) => {
       const response = await fetch(`https://calendar.example.com/v1/free-slots?date=${date}`, {
         headers: { Authorization: `Bearer ${await calendarToken()}` },
       });
       if (!response.ok) return { ok: false, message: "The calendar is not answering. Offer to call back later." };
       const { slots } = (await response.json()) as { slots: string[] };
       return { ok: true, data: { slots } };
     },
   });
   ```

   Render it in the skill that books appointments with `<Tool def={findFreeSlots} />`.

Keep the secret out of everything the model reads:

- Never put a secret in the system prompt, an instruction, a skill's text, or a tool's
  result or message. The model reads all of them, and it may say aloud anything it reads.
- Keep it out of error messages and logs: what your agent prints goes to its logs. An
  error the tool throws reaches the model only as a generic failure.
- Read it from `process.env` inside the tool, as above, never when the file loads. A
  hosted agent may load your files before its variables are set.

## Tools the framework provides

Three tools exist without being authored, and you should not write your own
versions of them:

| Tool | When the model has it | What it does |
|---|---|---|
| `read_skill` | whenever the current context has skill links | loads a skill's instructions and tools |
| `skip_turn` | always | ends the turn with no reply at all ("hold on", the user thinking out loud) |
| `end_call` | only during a live voice call | says its `goodbye` to the caller and hangs up |

`end_call` is the one to know about when you write a voice agent's prompts.
Its one input, `goodbye`, is the closing line: the session says it once the
call ran, and the transcript records it as the agent's reply. As before any
tool call, Curb holds back the newest sentence the model writes in that step
and drops it; sentences before that one were already said. An empty `goodbye`
is refused like any invalid input, and the call stays up. The
call disconnects the moment the goodbye has finished playing, so it is never
cut off mid-word. It is absent from typed chat sessions, where there is no call to
hang up, and the framework's spoken-style rules teach it only while it is
present, including when NOT to use it (never to escape a hard question, never
while something is still open). Add domain reasons to end a call in your own
prompt if you have them; do not restate the mechanics.

## Next steps

- [State and conditional tools](./state.md): make a tool appear only when it should.
- [Confirmations](./confirmations.md): have the caller approve an action first.
