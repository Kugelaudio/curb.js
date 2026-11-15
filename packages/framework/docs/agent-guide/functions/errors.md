# Errors

The errors a project throws or catches, imported from `curb`.

| Error | Thrown when |
|---|---|
| `ToolInputError` | A handler refuses its input, with a message for the model |
| `isToolInputError` | Tests for that error |
| `ToolUnavailableError` | A handler finds what it depends on not working, with a message for the model |
| `isToolUnavailableError` | Tests for that error |
| `AgentAuthoringError` | The agent is authored wrongly, with a code and a fix |
| `MessageRefusedError` | A message was refused by the app or the host |
| `HostUnavailableError` | `askHost` found no host connected |
| `HostTimeoutError` | `askHost` got no answer in time |
| `SettingsRefusedError` | A settings update is not allowed or not valid |

## `ToolInputError`

```ts
class ToolInputError extends Error {
  constructor(message: string, options?: { data?: unknown });
}
```

The model reads the message and can ask the caller again.

```ts
import { ToolInputError } from "curb";

throw new ToolInputError("That policy number has eight digits.");
```

## `ToolUnavailableError`

```ts
class ToolUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown });
}
```

Throw it when the tool cannot do its work because something behind it is not working: the API
does not answer, the database is down. The model reads the message, so say what to do next. The
`cause` is logged and never reaches the model.

```ts
import { ToolUnavailableError } from "curb";

try {
  response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
} catch (error) {
  throw new ToolUnavailableError("The order system is not answering. Offer to try again in a moment.", { cause: error });
}
```

How it differs from the other ways a tool fails:

| The handler | The model reads | [`<Handoff>`](../human-handoff.md) counts it as | On the tool's [span](../tracing.md) |
|---|---|---|---|
| returns `{ ok: false, message }` | your message | a failed attempt | `error.type` `tool_error` |
| throws `ToolInputError` | your message | a failed attempt | `error.type` `tool_error` |
| throws `ToolUnavailableError` | your message | an error | `error.type` `ToolUnavailableError` |
| throws anything else | a fixed "internal error" line | an error | the error's class |

## Version history

| Version | Changes |
|---|---|
| v1.22.0 | `ToolUnavailableError` and `isToolUnavailableError` introduced |
| v1.2.6 | `MessageRefusedError` and `SettingsRefusedError` introduced |
| v1.1.0 | `HostUnavailableError` and `HostTimeoutError` introduced |
| v0.1.2 | `ToolInputError`, `isToolInputError` and `AgentAuthoringError` introduced |
