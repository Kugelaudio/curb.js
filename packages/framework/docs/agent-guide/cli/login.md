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
| `--no-open` | Only prints the sign-in URL, to open in a browser on the same machine |

## How it ends

The browser ends on a page of the web app that says whether the sign-in worked: `/cli/login/result`.
The CLI holds the browser's answer until the login is stored, so a login it could not store shows
as failed in the browser too. With `--url`, a web app that does not have that page shows its own "not
found" there. The login itself still completes, and the terminal says how it ended.

A link that does not belong to the running `curb login`, or that comes back without a code, gets a
small page from the CLI itself, on `127.0.0.1`.

## Version history

| Version | Changes |
|---|---|
| v1.19.0 | `--no-open` no longer says it is opening a browser |
| v1.18.0 | The browser ends on a page of the web app |
| v1.11.9 | Replaces the key in `.env` for a KugelAudio project |
| v1.3.4 | `curb login` introduced |
