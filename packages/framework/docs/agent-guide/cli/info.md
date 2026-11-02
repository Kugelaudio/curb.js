# `curb info`

Prints what a bug report needs: the versions of Curb, Node and npm, the OS and architecture, the
project's `curb` dependency, its LLM, STT and TTS providers, and whether each expected environment
variable is set. Paste the output into the issue ([Reporting a bug](../reporting-a-bug.md)).

It prints variable names only, never a value, and it starts nothing: the providers are read from the
source, so one set by anything but a direct call such as `tts={kugelaudio.tts()}` shows as `set in code`.
Outside a project it says so and prints the versions.

```bash
npx curb info
```

## Version history

| Version | Changes |
|---|---|
| v1.15.0 | `curb info` introduced |
