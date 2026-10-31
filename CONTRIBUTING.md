# Contributing

Thanks for helping improve Curb.

## How this repository works

Curb is developed here. Pull requests are reviewed and merged in this repository. Each merge
to `main` that changes a published package is released as a preview, and a maintainer cuts
stable releases.

- **Issues** are welcome: bugs, missing features, unclear docs. To report a bug, follow
  [Reporting a bug](packages/framework/docs/agent-guide/reporting-a-bug.md).
- **Pull requests** are welcome too. The title is the changelog line, written for someone
  using Curb: `fix: ...`, `feat: ...`, or `feat!: ...` for a breaking change.

## Making a change

1. Open an issue first for anything larger than a small fix, so we can agree on
   the approach before you spend time on it.
2. Keep a pull request to one change, and add or update tests for it.
3. Run the tests locally. The exact commands are in
   [`.github/workflows/test.yml`](.github/workflows/test.yml), which runs on
   every pull request.

## What we ask of you

- Using AI to help is welcome, but you open the pull request: review and understand every change
  in it.
- Trivial pull requests still take a maintainer's time, so bundle them with a real change.
- Features start as an issue.

## Branches, commits and pull requests

Merges are squashed and the commit on `main` takes the pull request's title, so the title is
the one message that lasts. The `pr-rules` check enforces the title and body.

- **Title:** `type(scope)!: subject`. The scope and `!` are optional. The type is one of
  `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `ci` or `chore`. The subject starts with
  a lowercase letter and has no trailing period. The whole title is at most 100 characters.
  Dependabot alone may capitalise the subject, since its titles always start with `Bump`.

  ```text
  feat(framework): add a hook that runs after a call
  fix: keep the conversation after a reload
  docs(examples): add a README to livekit-pipeline
  feat(framework)!: rename the session store option
  ```

- **Body:** say what changes and why. The template's headings and checklist do not count, so
  fill them in rather than deleting them.
- **Commits:** commit messages on a branch are not checked and do not reach `main`. Write them
  however helps you; only the title has rules. Branch names have no rules either.

## Cutting a release

Previews need nothing: every merge that changes `packages/framework` or
`packages/create-curb.js`, beyond their docs, publishes `<next minor>-preview.<n>` to the npm
dist-tag `preview`, then pushes a matching git tag. It never moves `latest`. To start one without a
merge, run `gh workflow run publish.yml --ref main -f channel=preview`.

To cut a stable release:

1. Open **Actions > publish > Run workflow** on `main`, or run
   `gh workflow run publish.yml --ref main -f channel=stable -f semver=minor -f dry_run=true`.
2. Pick the `stable` channel and a `semver`: `patch`, `minor` or `major`.
3. With `dry_run` on, the run does everything except publish, tag and release. Its summary shows
   the release notes.
4. Run it again with `dry_run` off. It publishes `curb.js` and `create-curb.js` to `latest`, tags
   `v<version>`, and creates the GitHub Release.

If a run fails after verification, use **Re-run failed jobs**: each step skips what is already
done. The version comes from the tags, npm and the CDN, so nothing in the repository is bumped.
The notes come from the commit subjects since the last stable tag (`cliff.toml`).

## Security

Please do not report security problems in public issues. Use
**Security > Report a vulnerability** on this repository, or email
hello@kugelaudio.com.

## License

By contributing, you agree that your contributions are licensed under the
[Apache-2.0 License](LICENSE) that covers this repository.
