# `curb upgrade`

Updates the project's `curb` dependency to the latest version on npm ([Upgrading](../upgrading.md)).
It takes no version and refuses any other argument; to pin one, run
`npm install curb@npm:curb.js@<version>`.

```bash
npx curb upgrade [--check] [--preview]
```

## Options

| Option | What it does |
|---|---|
| `--check` | Only reports |
| `--preview` | Takes the newest preview |

## Example

```bash
npx curb upgrade --check
```

## Version history

| Version | Changes |
|---|---|
| v1.16.0-preview.1 | Reads npm only |
| v1.15.0 | `--preview` added |
| v0.1.2 | `curb upgrade` introduced |
