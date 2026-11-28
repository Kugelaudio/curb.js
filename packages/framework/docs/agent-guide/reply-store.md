# Reply store

A reply store keeps the model replies a test has had before, looked up by the exact request. A
test whose requests are unchanged gets its replies from the store and calls no model, so running
`curb test` again after a change costs only the scenarios the change reaches. The store functions
of `curb/testing` are on the [Testing API](./testing-api.md#reply-store) page.

## What `curb test` does

`curb test` keeps a store on by default. Each request of the agent, the simulated caller and the
judge is answered from the store when it holds a reply for exactly that request, and sent to the
model otherwise; the reply that comes back is stored for next time. Each scenario's report says
where its replies came from:

```text
  replies  stored
  replies  live from turn 2 (system prompt changed)
```

A request is the same when its role (agent, caller or judge), model and settings, system prompt,
messages, tools and run number are. So a change to a skill's instructions makes the scenarios
that open that skill live from the turn that reads it, and leaves the others stored. Once one
request of a call is new, the rest of that call goes to the model too.

Two things keep a request the same from one run to the next:

- **A fixed clock.** The agent sees the scenario's `now`, else `CURB_TEST_NOW`, else
  2026-06-03T15:00:00Z, instead of the real time ([the date and a fixed
  clock](./what-the-model-receives.md#the-date-and-a-fixed-clock)).
- **Replies per run.** A scenario with `runs: 5` stores five replies to its first request, one per
  run, so a stored scenario still plays five conversations.

Errors, cut-off replies and replies stopped at the output limit are never stored.

| Flag | What it does |
|---|---|
| `--live` | No store and the real clock: every request goes to the model |
| `--dry` | Calls no model: says which scenarios would go live, from which turn, and why |
| `--max-tokens <n>` | Starts no live request once the live ones used `n` tokens; exit code 3 |

The flags are on the [`curb test`](./cli/test.md#the-reply-store) page. `curb say`, `curb review`
and `curb dev` use no store.

## Where it lives

The local store is a folder outside the project, one gzip file per reply:

```text
~/.cache/curb/replies/v1/<first two characters of the key>/<key>.json.gz
```

`CURB_REPLY_STORE_DIR` names another folder, and `$XDG_CACHE_HOME/curb/replies` is used when
`XDG_CACHE_HOME` is set. A file never changes once written. Delete the folder to start empty; a
damaged file counts as a miss. Nothing of it belongs in git.

A stored reply holds what the model answered, and the request's key, which is a hash: the
request itself (prompt, messages, tool results) is not kept.

## In CI

A CI job starts with an empty folder, so it calls the model for every request unless it brings the
store back. A new project's `.github/workflows/curb-test.yml` does that with the Actions cache:

```yaml
      - name: Restore the reply store
        uses: actions/cache/restore@v6
        with:
          path: ~/.cache/curb/replies
          key: curb-replies-${{ github.run_id }}-${{ github.run_attempt }}
          restore-keys: curb-replies-
      - run: npx curb test
      - name: Save the reply store
        if: always()
        uses: actions/cache/save@v6
        with:
          path: ~/.cache/curb/replies
          key: curb-replies-${{ github.run_id }}-${{ github.run_attempt }}
```

The restore takes the newest store any earlier run saved, and the save keeps this run's under a key
of its own, also when a scenario failed. A second run of the same commit then reports every
scenario `stored` and its Tokens line reads `0 live`. A scheduled or `main` job that should
measure the real model runs `npx curb test --live`.

## Sharing a store

Several machines share their replies through a remote store: set `CURB_REPLY_STORE_URL` (and
`CURB_REPLY_STORE_TOKEN`), and `curb test` asks the local store first, then the remote one, and
copies a remote hit into the local folder. Curb ships no server; the protocol below is what one
speaks.

## Remote store protocol

This part is for whoever runs a remote store: a server that `remoteReplyStore` reads and writes.
Any server that speaks it works.

```text
GET  {base}/replies/{key}     200 gzip JSON | 404
PUT  {base}/replies/{key}     201 | 200 (already there) | 409 (being written) | 403 (read-only) | 413 (over 1 MiB)
Authorization: Bearer <token>
```

`CURB_REPLY_STORE_URL` is `{base}`, and `CURB_REPLY_STORE_TOKEN` is the token. `remoteReplyStore({
url, token })` takes them in code.

### Keys

`{key}` is 64 lowercase hex characters: the sha256 of the request's canonical JSON. A server treats
it as an opaque name and never computes it. A request is never sent to the server, only its key.

### `GET {base}/replies/{key}`

| Status | Body | Meaning |
|---|---|---|
| `200` | the stored reply, gzip JSON (`Content-Type: application/json`, `Content-Encoding: gzip`) | The server holds a reply for `key` |
| `404` | none | The server holds none |

### `PUT {base}/replies/{key}`

The body is the reply as gzip JSON, with the same headers as a `GET` answer. A stored reply never
changes: a second `PUT` of a key the server holds keeps the first reply.

| Status | Meaning |
|---|---|
| `201` | Stored |
| `200` | The server already holds a reply for `key`; it kept that one |
| `409` | Another write of the same `key` is in progress. Curb treats it like `200`: the reply will be there, and the test never fails because of it |
| `403` | The token may read but not write |
| `413` | The body is over 1 MiB |

### The stored reply

```json
{
  "v": 1,
  "key": "<the key>",
  "model": "<provider>:<model>",
  "createdAt": "2026-10-30T15:00:00.000Z",
  "usage": { "inputTokens": 1200, "outputTokens": 80 },
  "response": {}
}
```

`v` is the format, `1`. `key` is the key it is stored under. `model` is the model that answered.
`createdAt` is when it was stored. `usage` is the tokens the request used, or `null`. `response` is
the reply as the model client received it. A server stores the body as it came and need not read
it.

### Failures

A failed or refused request never fails a test. Curb then uses its local store, or else calls the
model, and says so once per run. Any other status, a timeout or a body that is not a stored reply
counts as a failure.

## Version history

| Version | Changes |
|---|---|
| v1.30.0 | `curb test` keeps replies in a local store by default, on a fixed clock unless `--live`; protocol documented |
