# Upgrading

Update Curb from the project folder:

```bash
npm run upgrade
```

This runs `curb upgrade`, which points the project's `curb` dependency at the latest published
version and reinstalls. The guide in `node_modules/curb/docs/agent-guide/` updates with it, so a
coding agent always reads the docs of the version it builds on. If the install fails, `package.json`
is restored and nothing changes.

To see whether a newer version exists without changing anything:

```bash
npx curb upgrade --check
```

`curb dev` also prints one line when a newer version is published.

## After an upgrade

Run `npx curb check`. When a change affects your project, a diagnostic says what to do, with a stable
code and a fix ([Diagnostics](./diagnostics.md)). Then run `npx curb test`, and read the
[release notes](https://github.com/Kugelaudio/curb.js/releases) for breaking changes.

## Next steps

- [Guides](./examples.md): what to build next.
