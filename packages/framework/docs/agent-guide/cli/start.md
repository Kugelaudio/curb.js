# `curb start`

Runs the LiveKit voice worker in production mode ([Self-hosting](../hosting.md)). With
`CURB_MANAGEMENT_ADDR` and `CURB_MANAGEMENT_TOKEN`, it also serves host protocol v1 for its calls.

```bash
npx curb start
```

Before the worker registers, it runs the [startup check](../hosting.md#startup-check). An
agent with a missing or refused key, or a model or voice its provider does not have, stops
with exit code 78 and one line naming the setting:

```text
curb: startup check failed: KUGELAUDIO_API_KEY is not set, and the agent's providers need it. Run `npx curb login` in the project, or set KUGELAUDIO_API_KEY to an API key from the dashboard. A hosted agent gets it from the platform.
```

## Version history

| Version | Changes |
|---|---|
| v1.29.0 | Runs the startup check before the worker registers |
| v0.1.2 | `curb start` introduced |
