# `defineTool`

Types the props of a [`<Tool>`](../components/tool.md) outside JSX. It returns what you pass.

```ts
import { defineTool } from "curb";

function defineTool(config: ToolActionProps): ToolActionProps;
function defineTool<TSchema extends z.ZodObject, TResult extends ToolResult>(
  config: ToolPropsWithSchema<TSchema, TResult>,
): ToolPropsWithSchema<TSchema, TResult>;
function defineTool(config: ToolPropsWithFields): ToolPropsWithFields;
```

With a `schema`, the tool's type keeps the schema and what `onSubmit` returns. A test that fakes
the tool ([`fake(tool, result)`](../testing-api.md#fake)) is checked against both, and a tool
named by its value (`called(issueRefund)`, `{issueRefund.name}` in an instruction) cannot be
misspelled.

## Example

```tsx
// src/agent/billing/tools.ts
export const issueRefund = defineTool({
  name: "issue_refund",
  description: "Refund an order.",
  schema: z.object({ order: z.string() }),
  onSubmit: async ({ order }) => ({ ok: true, data: { order, refunded: 49 } }),
});

// src/agent/billing/skill.tsx
<Tool {...issueRefund} />
```

A test of the skill imports the same value. The fake's result is checked against what `onSubmit`
returns, so `curb check` refuses a fake of the wrong shape:

```ts
// src/agent/billing/billing.scenario.ts
import { fake, scenario } from "curb/testing";
import * as Billing from "./skill.js";
import { issueRefund } from "./tools.js";

export default scenario({
  start: { skills: [Billing] },
  hermetic: true,
  turns: ["Please refund order A-1042."],
  fakes: [fake(issueRefund, { ok: true, data: { order: "A-1042", refunded: 49 } })],
  expect: ({ called }) => [called(issueRefund, { order: "A-1042" })],
});
```

## Version history

| Version | Changes |
|---|---|
| v1.30.0 | Generic over the input schema and the result of `onSubmit` |
| v0.1.2 | `defineTool` introduced |
