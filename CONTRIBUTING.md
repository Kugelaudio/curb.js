# Contributing

Thanks for helping improve Curb.

Everyone taking part in this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## How this repository works

Curb is developed here, in the open. Pull requests are reviewed and merged in this repository.
Each merge to `main` that changes a published package is released as a preview, and a maintainer
cuts stable releases.

- **Questions and ideas** go to [Discussions](https://github.com/Kugelaudio/curb.js/discussions):
  how to do something with Curb, or an idea you want to talk through before it becomes an issue.
- **Issues** are for bugs, feature requests and docs problems. Pick the form that fits on
  [New issue](https://github.com/Kugelaudio/curb.js/issues/new/choose). To report a bug, follow
  [Reporting a bug](packages/framework/docs/agent-guide/reporting-a-bug.md).
- **Pull requests** are welcome too. The title is the changelog line, written for someone
  using Curb: `fix: ...`, `feat: ...`, or `feat!: ...` for a breaking change.
- **Security problems** never go in a public issue, discussion or pull request; see
  [Security](#security).

## Making a change

1. Open an issue first for anything larger than a small fix, so we can agree on
   the approach before you spend time on it.
2. Fork the repository, clone your fork and create a branch for the change. Run `npm install` once
   at the root; [`AGENTS.md`](AGENTS.md) lists every command and what the tests cover.
3. Keep a pull request to one change, and add or update tests for it.
4. Run the tests locally. The exact commands are in
   [`.github/workflows/test.yml`](.github/workflows/test.yml), which runs on
   every pull request.
5. Push the branch to your fork and open a pull request against `main`. Fill in the template, and
   write `Closes #<issue>` in the body when it closes an issue.

## What happens to your pull request

- **CI waits for a maintainer.** On a pull request from a fork, a maintainer approves the workflow
  runs before they start, so the checks show as waiting until then. They run on GitHub-hosted
  runners with no access to this repository's secrets.
- **Every check must pass:** `pr-rules` checks the title and body, `test` runs the suites the change
  affects, and `gate` passes only when everything it needs passed.
- **Only maintainers merge,** and always as a squash: the whole pull request becomes one commit on
  `main` that takes its title. Push fixes for review comments to the same branch; there is no need
  to squash or force-push yourself.

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
dist-tag `preview`, with a matching git tag. It never moves `latest`. To start one without a
merge, run `gh workflow run publish.yml --ref main -f channel=preview`.

To cut a stable release:

1. Open **Actions > publish > Run workflow** on `main`, or run
   `gh workflow run publish.yml --ref main -f channel=stable -f semver=minor -f dry_run=true`.
2. Pick the `stable` channel and a `semver`: `patch`, `minor` or `major`.
3. With `dry_run` on, the run does everything except publish, tag and release. Its summary shows
   the release notes.
4. Run it again with `dry_run` off. It tags `v<version>`, publishes `curb.js`, `create-curb.js` and
   `create-curb` to `latest`, and creates the GitHub Release.

`create-kugelaudio` is the same package under a third name. The repository variable
`CREATE_KUGELAUDIO` decides what a run does with it: unset, it is not published; `preview`, it goes
to the `preview` dist-tag on either channel and its `latest` stays; `release`, it follows the run.

The tag comes first because it is the one step that can become impossible: GitHub can refuse
`GITHUB_TOKEN` a ref on a commit whose workflow files differ from `main`'s, so a merge that changes
a workflow during a run can end in a 403 that no rerun clears. What to do depends on the job that
failed:

- **`tag`:** nothing was published. After a 403 a rerun cannot help, so start a new run from `main`,
  which plans the same version on the newer commit. A preview also starts over with the next merge.
- **`publish`:** use **Re-run failed jobs** within 7 days, while the tarballs are kept. It skips the
  tag and every package npm already holds. If the publish can never succeed, the tag stays, because
  `v*` tags cannot be deleted: that version is skipped, and the notes of the next stable release
  start after it.
- **`release`:** use **Re-run failed jobs**.
- **`installed`:** the version is out and cannot be taken back, so the fix is a new release.

The version comes from the tags and npm, so nothing in the repository is bumped.
The notes come from the commit subjects since the last stable tag (`cliff.toml`).

## Security

Please do not report security problems in public issues, discussions or pull requests. Report them
privately through
[Report a vulnerability](https://github.com/Kugelaudio/curb.js/security/advisories/new), or email
hello@kugelaudio.com if you cannot use GitHub's form. [SECURITY.md](SECURITY.md) says which
versions are supported, what is in scope and what to expect back.

## License

By contributing, you agree that your contributions are licensed under the
[Apache-2.0 License](LICENSE) that covers this repository.
