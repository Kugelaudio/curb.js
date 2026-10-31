# Human handoff

A support line that puts the caller through to a person, and offers a callback when nobody
answers. It shows the smallest honest handoff: `<TransferCallTool>` for the transfer and a
tool of your own for the path where it fails.

- `src/agent/agent.tsx`: the whole agent.
- `src/agent/handoff.scenario.ts`: the failed transfer, played without dialing anyone.

```bash
npx curb check
npx curb test
```

A transfer needs a hosted phone call: in `curb dev`, `curb say` and on a browser call it is
refused with `transfer_unsupported_session`, so the scenario fakes `transfer_call`.
