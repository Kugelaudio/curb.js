# Upgrading

Update Curb from the project folder:

```bash
npm run upgrade
```

This runs `curb upgrade`, which points the project's `curb` dependency at the latest version on npm
and reinstalls. The guide in `node_modules/curb/docs/agent-guide/` updates with it, so a coding agent
always reads the docs of the version it builds on. When the new version needs a newer React than
the project allows, `react` and `react-dom` are raised with it. If the install fails, `package.json` is restored
and nothing changes.

To see whether a newer version exists without changing anything:

```bash
npx curb upgrade --check
```

`curb dev` also prints one line when a newer version is published.

## Try a preview

Every code change to Curb is published as a preview on npm before it reaches a stable release. Move a
project to the newest one with:

```bash
npx curb upgrade --preview
```

`--check` works here too. The project stays on that preview until you run this again or a newer
stable version comes out, which `npm run upgrade` then installs. To go back to the latest stable
version sooner:

```bash
npm install curb@npm:curb.js@latest
```

## Move an older project to npm

Curb is published to npm only, so a project that depends on `npm:curb.js@<version>` gets every
update, and a repo-linked `file:` dependency updates with git. `curb upgrade` stops on any other
`curb` dependency, such as a tarball URL, and names this command, which changes the dependency:

```bash
npm install curb@npm:curb.js@latest
```

Use `@preview` for the newest preview.

## Hosted deploys

Hosted deploys accept a project that installs Curb from npm.

## After an upgrade

Run `npx curb check`. When a change affects your project, a diagnostic says what to do, with a stable
code and a fix ([Diagnostics](./diagnostics.md)). Then run `npx curb test`, and read the
[release notes](https://github.com/Kugelaudio/curb.js/releases) for breaking changes.

## Changes to `curb test` in v1.30

Two changes can make `curb test` behave differently on a project that passed before:

- **A reply store is on by default, and the clock is fixed.** `curb test` answers a request it saw
  before from `~/.cache/curb/replies` instead of the model, so a second run with nothing changed
  calls no model. The agent sees a fixed date and time (a scenario's `now`, else `CURB_TEST_NOW`,
  else 2026-06-03T15:00:00Z) instead of the real clock. A scenario that relied on today's date
  gives `now`; `npx curb test --live` runs as before, with no store and the real clock
  ([Reply store](./reply-store.md)).
- **A fake for a tool the agent does not have is an error.** A `fakes` entry whose name is no tool
  of the agent, a misspelled name most often, stops the scenario before the first turn with
  `[CURB_TEST_UNKNOWN_FAKE]`, which names the tools there are; it used to be a note. Correct the
  name, or pass the tool's `defineTool` value to [`fake`](./testing-api.md#fake) so TypeScript
  checks it. `curb check` reports the same scenario as `SCENARIO_UNKNOWN_TOOL`.

## Next steps

- [Guides](./examples.md): what to build next.
