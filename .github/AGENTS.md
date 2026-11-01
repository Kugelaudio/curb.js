# Workflow rules

For anything under `.github/workflows/`:

- **Prefer `pull_request` over `pull_request_target`.** `pull_request_target` runs with this
  repository's secrets and a write token on behalf of a fork, so it must never check out or run
  the pull request's code.
- **Set minimal `permissions` per job.** Keep the workflow default at `contents: read`, and grant
  anything more on the one job that needs it.
- **Pin third-party actions to a commit SHA,** with the version in a trailing comment:
  `uses: actions/checkout@<sha> # v6.1.0`. A tag can be moved; a SHA cannot.
- **Keep forks off self-hosted runners.** A job on one takes its `runs-on` from the fork-safe
  expression in `test.yml`, which sends a fork's pull request to a GitHub-hosted runner. Never skip a
  job for a fork instead: gate passes a skipped job. `scripts/workflow-safety.test.mjs` enforces this.
- **Set `persist-credentials: false` on every checkout.** Only a step that runs `git push` needs the
  token left behind; the tag and release jobs call the API and do not check out.
- **Add `concurrency` where runs supersede each other,** and cancel only what a newer run replaces.
  A push to `main` and a release must always finish.
