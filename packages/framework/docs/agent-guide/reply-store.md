# Reply store

A reply store keeps the model replies a test has had before, looked up by the exact request. A
test whose requests are unchanged gets its replies from the store and calls no model. The store
functions of `curb/testing` are on the [Testing API](./testing-api.md#reply-store) page.

This page is for whoever runs a remote store: a server that `remoteReplyStore` reads and writes, so
that several machines share their stored replies. Curb documents the protocol; any server that
speaks it works.

## Remote store protocol

```text
GET  {base}/replies/{key}     200 gzip JSON | 404
PUT  {base}/replies/{key}     201 | 200 (already there) | 403 (read-only) | 413 (over 1 MiB)
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
| v1.30.0 | Protocol documented |
