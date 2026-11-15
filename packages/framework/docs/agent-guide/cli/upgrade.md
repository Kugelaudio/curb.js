# `curb upgrade`

Updates the project's `curb` dependency to the latest version on npm ([Upgrading](../upgrading.md)).
It takes no version and refuses any other argument; to pin one, run
`npm install curb@npm:curb.js@<version>`.

When the new version needs a newer `react` or `react-dom` than the project's `package.json` allows,
it raises them to the version's peer range first and says so. If the install fails, `package.json` is
restored, React included.

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
| v1.23.0 | Raises `react` and `react-dom` to what the new version needs |
| v1.16.0-preview.1 | Reads npm only |
| v1.15.0 | `--preview` added |
| v0.1.2 | `curb upgrade` introduced |
