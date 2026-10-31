# Overriding the LiveKit pipeline

A Curb call runs on a LiveKit `AgentSession`. This example changes that pipeline in the two ways
Curb has:

- **Edit it.** [`src/agent/pipeline.ts`](./src/agent/pipeline.ts) goes to
  `defineAgent({ pipeline })` and applies on `curb dev`, `curb start` and a built artifact. It
  gives callers longer to finish a turn, answers one question without the model, spells a word
  out for the voice and logs the agent's state.
- **Write your own.** [`src/own-session.ts`](./src/own-session.ts) is a LiveKit worker that builds
  the whole session itself. It replaces `curb start`, and it runs none of what Curb's session
  adds: the opening line, the silence check-in, transfers, provider swaps and the call report.

Start with the first. Everything runs on one `KUGELAUDIO_API_KEY`, from `npx curb login` or `.env`.

```bash
npx curb check
npx curb test
npm run dev
```

The worker of your own also needs `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`:

```bash
npm run own-session
```

The guide page walks through both:
[Override the LiveKit pipeline](https://curbjs.com/docs/livekit-pipeline/).
