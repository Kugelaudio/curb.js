# Example projects

Five complete projects show the larger patterns, each with scenarios you can run:

| Project | What it shows | Guide |
|---|---|---|
| `human-handoff` | Put a caller through to a person, with a way out | [Human handoff](./human-handoff.md) |
| `complex-handoffs` | Hand over by code, to a skill with its own voice, or to a person with a note | [Complex handoffs](./complex-handoffs.md) |
| `orchestration` | Steps, confirmations and what runs next | [Step-by-step procedures](./procedures.md) |
| `pipeline` | Change language, voice or model during a call | [Mid-call changes](./mid-call-changes.md) |
| `livekit-pipeline` | Edit the LiveKit pipeline or write your own | [Override the LiveKit pipeline](./livekit-pipeline.md) |

## Where they are

Every project is in [`examples/`](https://github.com/Kugelaudio/curb.js/tree/main/examples) in the
Curb repository:

```bash
git clone https://github.com/Kugelaudio/curb.js
cd curb.js
npm install
cd examples/livekit-pipeline
npx curb check
```

Each guide above shows the code that matters, so you can also copy it into a project of your own.
Add a scenario for each behaviour you keep ([Testing](./testing.md)).
