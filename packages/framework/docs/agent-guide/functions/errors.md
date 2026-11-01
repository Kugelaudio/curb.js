# Errors

The errors a project throws or catches, imported from `curb`.

| Error | Thrown when |
|---|---|
| `ToolInputError` | A handler refuses its input, with a message for the model |
| `isToolInputError` | Tests for that error |
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

## Version history

| Version | Changes |
|---|---|
| v1.2.6 | `MessageRefusedError` and `SettingsRefusedError` introduced |
| v1.1.0 | `HostUnavailableError` and `HostTimeoutError` introduced |
| v0.1.2 | `ToolInputError`, `isToolInputError` and `AgentAuthoringError` introduced |
