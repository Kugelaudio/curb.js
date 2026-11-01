# {{APP_NAME}}

A voice agent built with **curb.js**: React renders the agent's prompt, knowledge and
tools instead of HTML. It starts as **Juno**, a demo personal assistant, so you can try
the framework before you change anything.

## Run it

Sign in with `npx curb login`; there is no key to copy. Every curb command in this folder
then runs on your login: KugelAudio's EU-hosted LLM thinks, Kugel Ear listens and Kugel TTS
speaks. A deployed agent gets its access from KugelAudio. Prefer an API key (CI, a server)?
Set `KUGELAUDIO_API_KEY` in `.env`; it wins over the login. Another provider's key goes in
`.env` too, which `npm create curb.js` already wrote.

```bash
npx curb login            # sign in in the browser; Curb uses your login
npm run dev               # preview, chat and voice on http://127.0.0.1:4000
npx curb check            # types, render and warnings
npx curb say "Hallo"      # one caller turn in the terminal, no browser
```

## Meet Juno

Type or talk in the preview:

- **"Put buy milk on my list."** The `add_task` tool updates shared state, and the task
  list in Juno's context changes with it.
- **"What do you know about me?"** Juno reads the about-you skill, whose profile is
  `context/about-you.md`. Edit the file and ask again.
- **"Wrap up my day."** The `wrap_up_day` tool exists only once a task is done, so with
  nothing done she cannot.
- **"How do you work?"** Juno explains how she is built.

## Where things live

- `src/agent/agent.tsx`: the agent, where every conversation starts: its providers
  (`<Agent llm stt tts>`), system prompt, skills index, and the task list with its tools.
- `src/agent/<name>/skill.tsx`: one folder per skill, opened only when the conversation
  needs it.
- `context/`: markdown the skills read.

## Deploy to KugelAudio

Hosted deploys do not accept a project that installs Curb from npm yet, and this project does.
Today it runs locally with `npm run dev` and goes live on your own servers: see
`node_modules/curb/docs/agent-guide/hosting.md`. Once hosted deploys accept it:

```bash
npx curb login
npx curb secrets push
npx curb deploy
```

`deploy` prints the playground URL where you can call the live agent. Your `.env` is
never uploaded; `secrets push` sends its values and prints only their names. Details:
`node_modules/curb/docs/agent-guide/deploying.md`.

## Learn more

`AGENTS.md` briefs coding agents (and you) on the rules; `CLAUDE.md` imports it for
Claude Code. `.mcp.json` connects Claude Code to your KugelAudio account (sign in from
`/mcp`) and to the KugelAudio docs. The full guide is in
`node_modules/curb/docs/agent-guide/`.
