# Human handoff

A support line that puts the caller through to a person within opening hours, and takes a
callback request when nobody can answer. It shows `<Handoff>`: the transfer, the hours, the
callback request, and the handoff the framework makes on its own when tools keep failing.

- `src/agent/agent.tsx`: the whole agent.
- `src/agent/handoff.scenario.ts`: a handoff that reaches nobody, played without dialing anyone.

```bash
npx curb check
npx curb test
```

A transfer needs a hosted phone call: in `curb dev`, `curb say` and on a browser call it is
refused with `transfer_unsupported_session`, and `<Handoff>` offers a callback instead, which is
what the scenario checks.
