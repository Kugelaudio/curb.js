# Reporting a bug

This is the one standard for a Curb bug report, for people and for coding agents. Do not use it for
a security problem: follow [Security](https://github.com/Kugelaudio/curb.js/blob/main/CONTRIBUTING.md#security) instead.

## What a report holds

Every report has these four headings:

```markdown
## What happened

## How to reproduce

## What you expected

## Output of npx curb info
```

- **Run `npx curb info` in the project** and paste what it prints: the versions, the OS, the project's
  `curb` dependency, its providers, and which expected environment variables are set, by name only
  ([CLI](./cli.md)).
- **Keep the reproduction as small as possible.** Remove everything from the project that the bug
  does not need.
- **Use `npx curb conversations` when it helps.** `npx curb conversations --last 1` prints the failing
  conversation with every tool call and result. Paste only the part that shows the bug.

## Before you post

An issue is public. Remove keys, phone numbers, caller names and transcripts of real calls.

## If you are a coding agent

1. Confirm the fault is in Curb, not in the project. Reproduce it, run `npx curb check`, and check
   what you expected against this guide.
2. Show the person the whole report, and get their yes before you file it.
3. File it with the second command below.

## Filing it

In a terminal, this opens the template:

```bash
gh issue create --repo Kugelaudio/curb.js --template "Bug report" --label bug
```

`--template` needs a terminal and cannot be combined with `--body-file`. Without a terminal, as a
coding agent usually is, write the report with the four headings to a file and pass it:

```bash
gh issue create --repo Kugelaudio/curb.js --title "<what goes wrong>" --label bug --body-file report.md
```

Without `gh`, open a [new issue](https://github.com/Kugelaudio/curb.js/issues/new/choose) and choose **Bug report**.

## Next steps

- [Testing](./testing.md): reproduce a bug with `curb say` and `curb test`.
- [CLI](./cli.md): every command and its options.
