# `curb check`

Type-checks `src/` and runs the authoring checks. Exits 1 on errors ([Diagnostics](../diagnostics.md)).

```bash
npx curb check
```

## Version history

| Version | Changes |
|---|---|
| v1.19.0 | Fails `AGENT_VOICE_NOT_FOUND` when KugelAudio does not have a voice id the agent sets |
| v1.6.0 | Warns `AGENT_LITERAL_DATE` when text the model reads hard-codes a date |
| v1.4.33 | Type-checks the project and lists the variables an agent needs |
| v0.1.2 | `curb check` introduced |
