# {{APP_NAME}}

A voice agent built with **curb.js**: React renders the agent's prompt, knowledge and tools
instead of HTML. It starts as **Mara**, a customer support agent for a made-up online shop. The company, the sample data and the policies are
made up: replace them with your own.

## Run it

Sign in with `npx curb login`; there is no key to copy. Every curb command in this folder then
runs on your login. Prefer an API key (CI, a server)? Set `KUGELAUDIO_API_KEY` in `.env`.

```bash
npx curb login            # sign in in the browser; Curb uses your login
npm run dev               # preview, chat and voice on http://127.0.0.1:4000
npx curb check            # types, render and warnings
npx curb say "Hello"      # one caller turn in the terminal, no browser
npx curb test             # the conversations in src/agent/*.scenario.ts, pass or fail
```

## Try it

- **"Where is order NW-1002?"** The `find_order` tool reads the order list and Mara answers from it.
- **"My backpack arrived damaged."** Mara opens the returns skill, whose policy is `context/returns.md`, and opens a ticket with `open_ticket`.
- **"I want to talk to a person."** The `hand_over_to_team` tool exists only once a ticket is open, so Mara cannot offer it before.

## Where things live

- `src/agent/agent.tsx`: the agent, where every conversation starts: its providers
  (`<Agent llm stt tts>`), system prompt, skills index, and its tools.
- `src/agent/<name>/skill.tsx`: one folder per skill, opened only when the conversation needs it.
- `context/`: markdown the skills read. Edit it and the agent's answers change live.

## Test it

`src/agent/*.scenario.ts` holds conversations that `npx curb test` plays in text: one with
scripted caller lines, which must always pass, and one with a simulated caller that a second
model plays. `npx curb test --runs 3` plays each three times and reports how often
it passed, what a judge found and how the agent talks. Text tests do not cover audio, timing or
interruptions: listen to a call in `npm run dev` for those.

`.github/workflows/curb-test.yml` runs `curb check` and `curb test` on every pull request, and
fails until the repository has `KUGELAUDIO_API_KEY` as a secret (Settings > Secrets and variables > Actions).

## Deploy to KugelAudio

```bash
npx curb login
npx curb secrets push
npx curb deploy
```

`deploy` prints the playground URL where you can call the live agent. Your `.env` is never
uploaded; `secrets push` sends its values and prints only their names.

## Learn more

`AGENTS.md` briefs coding agents (and you) on the rules; `CLAUDE.md` imports it for Claude Code.
The full guide is in `node_modules/curb/docs/agent-guide/`.
