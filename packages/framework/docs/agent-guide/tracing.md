# Tracing

Curb reports what a call does as [OpenTelemetry](https://opentelemetry.io/) spans. Set up any
OpenTelemetry backend in your project and it receives them, with how long each part took. Curb
registers nothing itself: with no OpenTelemetry SDK running, a span costs nothing and goes nowhere.

## What you get

On a voice call, the call is one span, from its start to its end, and everything that lasts
inside it is a span under it:

| Span | From, to | Attributes |
| --- | --- | --- |
| `invoke_agent <agent>` | The call, from before the session starts until it has closed | `gen_ai.operation.name` (`invoke_agent`), `curb.call.channel` (`phone` or `web`, set once the caller has joined), `curb.call.direction` when the host names it |
| `curb.skill <path>` | A stay in a skill, from entering it to the next skill, the agent level, or the end of the call | `curb.skill.path`, `curb.skill.title` |
| `curb.procedure <title>` | A `<Procedure>`, from entering the context until its last step is completed, it leaves the context, or the call ends | `curb.procedure.title`, `curb.procedure.steps`, `curb.procedure.step` (the step it is on), `curb.procedure.completed` |
| `curb.transfer` | A transfer, from the request until nobody answered, or until an answered one is over | `curb.transfer.outcome` (`answered`, `no_answer`, `busy`, `failed`, `refused`), `curb.transfer.ended` for an answered one (`resumed`, `ended_call`, `call_ended`), `error.type` (`transfer_failed`) when the dial failed |
| `execute_tool <name>` | A tool run, from the handler's start to its result | `gen_ai.operation.name` (`execute_tool`), `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`, `curb.skill.path` when a skill owns the tool, `curb.tool.ok` |

Every span also carries `gen_ai.agent.name` (the agent's id) and, once the conversation is
recorded, `gen_ai.conversation.id`.

The call's span starts in the context that is active when the call starts. It is the root of its
trace unless the host already runs the call inside a span of its own, as a `curb start` worker
does for each job: there the call's span is a child of that span.

Moments are events on the span they happen in: `step_completed` on a procedure (with
`curb.procedure.step` and `curb.procedure.step_title`), `handed_off` on a transfer when its
target is on the line. A tool run that changes the active skill also says so on its own span,
as `curb.skill.entered` or `curb.skill.exited`.

A span that failed has an error status and an `error.type`:

| What failed | `error.type` | Also on the span |
| --- | --- | --- |
| A tool answered `ok: false` | `tool_error` | |
| A tool's handler threw | the error's class, such as `TypeError` | an `exception` event with `exception.type`, without the message |
| A transfer's dial failed | `transfer_failed` | |
| The call's session could not start | the error's class | an `exception` event with the message |

A transfer nobody answered, or one to a busy line, is an outcome and not an error. A call that
never ran (an unknown tool, invalid input, or one held for the caller's yes) has no span. No span
carries what was said, a tool's arguments or result, or a phone number. The message of an error a
tool threw can quote the caller, so only its class is on the span and the message stays in the
log.

Outside a voice call (a typed conversation in `curb dev`, `curb say`) there is no call span, and
no skill, procedure or transfer span: only tool runs are traced, as children of whatever span is
active when they run.

On a voice call the same backend also receives the LiveKit Agents pipeline's own spans
(`agent_turn`, `llm_node`, `tts_node` and more). A tool run stays under the pipeline span that
asked for it when that span is part of the call's trace, and goes directly under the call
otherwise, so it never ends up in a trace of its own. LiveKit sets `gen_ai.conversation.id` on
its own spans to its own id of the call, which is not Curb's: group a call's spans by their
trace.

## Send spans to a backend

Start the SDK in a module of its own and import it first from `src/agent/agent.tsx`, so it runs
before the first call in every way the agent runs (`curb dev`, `curb start`, a built artifact):

```ts
// src/instrumentation.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

new NodeSDK({
  serviceName: "booking-agent",
  traceExporter: new OTLPTraceExporter(), // reads OTEL_EXPORTER_OTLP_ENDPOINT
}).start();
```

```tsx
// src/agent/agent.tsx
import "../instrumentation";
import { defineAgent } from "curb";
```

```bash
npm install @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
```

Any backend that accepts OTLP works the same way: set `OTEL_EXPORTER_OTLP_ENDPOINT` and its
headers in `.env`.

An exporter sends spans in batches, a few seconds after they end. A `curb start` worker and a
built artifact serve a call in a process that exits when the call is over, so when a call ends
there, Curb asks the tracer provider you registered to send what it holds, and waits up to three
seconds for it. A backend that cannot be reached does not hold the call's end any longer than
that.

## Write your own

A span processor sees every span as it ends. Use one to send exactly what you want to your own
analytics:

```ts
// src/instrumentation.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

// `analytics` stands for your own client.
const toolTimes: SpanProcessor = {
  onStart() {},
  onEnd(span: ReadableSpan) {
    if (span.attributes["gen_ai.operation.name"] !== "execute_tool") return;
    const [seconds, nanos] = span.duration;
    analytics.capture("tool_run", {
      conversation: span.attributes["gen_ai.conversation.id"],
      agent: span.attributes["gen_ai.agent.name"],
      tool: span.attributes["gen_ai.tool.name"],
      ok: span.attributes["curb.tool.ok"],
      ms: seconds * 1000 + nanos / 1e6,
    });
  },
  async forceFlush() {},
  async shutdown() {},
};

new NodeSDK({ serviceName: "booking-agent", spanProcessors: [toolTimes] }).start();
```

`onEnd` runs inside the call, so keep it quick: queue the event and send it in the background.

The same processor can pick any other span by its name, for example how far callers get in a
procedure:

```ts
onEnd(span: ReadableSpan) {
  if (!span.name.startsWith("curb.procedure ")) return;
  analytics.capture("procedure", {
    conversation: span.attributes["gen_ai.conversation.id"],
    title: span.attributes["curb.procedure.title"],
    completed: span.attributes["curb.procedure.completed"],
    step: span.attributes["curb.procedure.step"],
    of: span.attributes["curb.procedure.steps"],
  });
},
```

## Turn it off

Delete the import, or set `OTEL_SDK_DISABLED=true` on a deployment to stop the SDK without a code
change. Curb's spans then go nowhere again.

## What the voice pipeline's spans hold

The LiveKit Agents spans carry what was said, the model's input and output, and the caller's phone
number, in attributes whose names contain `pii`. Curb's own spans carry none of that. To send
your backend only timings and other non-content attributes, give LiveKit a way to add its own
span processor to your provider, and tell it not to allow that data:

```ts
// src/instrumentation.ts
import { telemetry } from "@livekit/agents";
import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

const livekit = new telemetry.FanoutSpanProcessor();
new NodeSDK({
  serviceName: "booking-agent",
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter()), livekit],
}).start();

telemetry.setTracerProvider(trace.getTracerProvider(), {
  allowPii: false,
  registerSpanProcessor: (processor) => livekit.add(processor),
});
```

`allowPii: false` alone does nothing: without `registerSpanProcessor` LiveKit cannot add the
processor that removes the data, and says so in a warning when the agent starts.
