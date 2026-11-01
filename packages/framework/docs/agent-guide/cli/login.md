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

## Version history

| Version | Changes |
|---|---|
| v1.11.9 | Replaces the key in `.env` for a KugelAudio project |
| v1.3.4 | `curb login` introduced |
