# Upgrading

Update Curb from the project folder:

```bash
npm run upgrade
```

This runs `curb upgrade`, which points the project's `curb` dependency at the latest version on npm
and reinstalls. The guide in `node_modules/curb/docs/agent-guide/` updates with it, so a coding agent
always reads the docs of the version it builds on. If the install fails, `package.json` is restored
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

Hosted deploys do not accept a project that installs Curb from npm yet.

## After an upgrade

Run `npx curb check`. When a change affects your project, a diagnostic says what to do, with a stable
code and a fix ([Diagnostics](./diagnostics.md)). Then run `npx curb test`, and read the
[release notes](https://github.com/Kugelaudio/curb.js/releases) for breaking changes.

## Next steps

- [Guides](./examples.md): what to build next.
