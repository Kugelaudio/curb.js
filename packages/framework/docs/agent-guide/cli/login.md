# `curb login`

Signs in to KugelAudio in the browser. The login is stored in `~/.config/curb/`, and a project then runs
on it with no key in `.env`. A `KUGELAUDIO_API_KEY` you set wins.

```bash
npx curb login [--url <web>] [--no-open]
```

## Options

| Option | What it does |
|---|---|
| `--url <web>` | Another app URL |
| `--no-open` | Only prints the sign-in URL |

## How it ends

The browser ends on a page of the web app that says whether the sign-in worked: `/cli/login/result`.
The CLI holds the browser's answer until the login is stored, so a failure in the terminal is a
failure in the browser too. With `--url`, a web app that does not have that page shows its own "not
found" there. The login itself still completes, and the terminal says how it ended.

A link that does not belong to the running `curb login`, or that comes back without a code, gets a
small page from the CLI itself, on `127.0.0.1`.

## A browser on another machine

When stdin is a terminal, `curb login` also prints a second URL. Open it in any browser, allow the
sign-in, and paste the code it shows into the waiting terminal. Whichever arrives first wins: the
browser on this machine or the pasted code. Paste it only into a terminal where you ran `curb login`
yourself, and never share it. A code from another sign-in is refused, and the terminal keeps waiting.
Cancelling in that browser cannot reach the terminal, so press Ctrl+C there. With `--url`, a web app
without this mode refuses the second URL; the first still works.

Without a terminal (CI, a coding agent's pipe), there is no second URL and nothing is read from stdin.

## Version history

| Version | Changes |
|---|---|
| v1.17.0 | The browser ends on a page of the web app, and a code can be pasted from a browser on another machine |
| v1.11.9 | Replaces the key in `.env` for a KugelAudio project |
| v1.3.4 | `curb login` introduced |
