# `curb run`

Runs a script of your own with the project loaded, as `curb dev` loads it: TypeScript and JSX, the
project's `.env`, and the key of `npx curb login`. A script that imports `curb/testing` drives the
project's agent, so a test harness of your own runs the same way locally and in CI
([Testing API](../testing-api.md)).

```bash
npx curb run <script> [args...]
```

The script gets the arguments after its path in `process.argv`, as `node` would give them; options
after the path are the script's own, `--help` included. Its TypeScript and JSX, and those of the
files beside it, are compiled as the project's are.

## Exit codes

The script's: what it sets with `process.exitCode` or `process.exit(code)`, else 0. A script that
throws prints the error and exits 1.

## Example

```ts
// scripts/naturalness.ts
import { inParallel, report, saveRun, scriptedCaller, startCall, converse, ask } from "curb/testing";

const lines = ["I'd like to book a haircut.", "My kitchen is flooded."];
const records = await inParallel(lines, async (line) => converse(await startCall(), scriptedCaller([line])), { concurrency: 2 });
const checks = await inParallel(records, async (record) => [await ask(record, "The agent sounds like a person on the phone.")], { concurrency: 2 });
saveRun(records, { name: "naturalness", checks });
process.exitCode = report(lines.map((line, index) => ({ name: line, checks: checks[index] })));
```

```bash
npx curb run scripts/naturalness.ts
```

## Version history

| Version | Changes |
|---|---|
| v1.25.0 | `curb run` introduced |
