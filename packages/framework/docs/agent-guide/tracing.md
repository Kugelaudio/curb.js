# Tracing

Curb reports what a call does as [OpenTelemetry](https://opentelemetry.io/) spans. Set up any
OpenTelemetry backend in your project and it receives them, with how long each part took. Curb
registers nothing itself: with no OpenTelemetry SDK running, a span costs nothing and goes nowhere.

## What you get

| Span | When | Attributes |
| --- | --- | --- |
| `execute_tool <name>` | Every tool run, from the handler's start to its result | `gen_ai.operation.name` (`execute_tool`), `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`, `gen_ai.agent.name` (the agent's id), `gen_ai.conversation.id` once the conversation is recorded, `curb.skill.path` when a skill owns the tool, `curb.tool.ok` |

A tool whose result has `ok: false` ends its span with an error status and `error.type`
(`tool_error`). A call that never ran (an unknown tool, invalid input, or one held for the caller's
yes) has no span. A span never carries the tool's arguments or its result.

A tool span is a child of whatever span is active when the tool runs. On a voice call the same
backend also receives the LiveKit Agents pipeline's own spans (`agent_turn`, `llm_node`, `tts_node`
and more), so you can see how long the caller waited and which part of it was your tool.

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

## Turn it off

Delete the import, or set `OTEL_SDK_DISABLED=true` on a deployment to stop the SDK without a code
change. Curb's spans then go nowhere again.

## What the voice pipeline's spans hold

The LiveKit Agents spans can carry what was said and the model's input and output. To send your
backend only timings and other non-content attributes, register the provider through LiveKit's
`telemetry.setTracerProvider(provider, { allowPii: false })` from `@livekit/agents`.
