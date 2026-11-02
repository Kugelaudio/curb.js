# `curb build`

Bundles the project into `.curb/standalone`, starts the finished artifact on its own and renders every
skill to prove it runs ([Self-hosting](../hosting.md#built-artifact-curb-build)).

```bash
npx curb build [--out <dir>] [--no-verify] [--emit-layers <dir>] [--dependency-layer <file>]
```

## Options

| Option | What it does |
|---|---|
| `--out <dir>` | Another output directory |
| `--no-verify` | Skips starting the artifact |
| `--emit-layers <dir>` | Also records the dependency layer split, for a hosted builder |
| `--dependency-layer <file>` | Builds only the app layer from that descriptor. Exits 75 when the project reaches past the recorded inputs |

## Example

```bash
npx curb build --out dist
```

## Version history

| Version | Changes |
|---|---|
| v1.1.0 | `curb build` introduced |
