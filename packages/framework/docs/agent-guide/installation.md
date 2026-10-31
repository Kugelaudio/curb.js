# Installation

Create an agent and talk to it. You need Node.js 22.12 or newer and a KugelAudio account.

## Create a project

```bash
mkdir insurance-agent && cd insurance-agent
npm create curb.js .
```

The installer asks which provider runs each part of the pipeline. Keep the defaults, and the whole
agent runs on KugelAudio with one sign-in.

Create the project in the folder itself rather than in a subfolder: a coding agent started there
then loads the project's `.mcp.json`, `CLAUDE.md` and `AGENTS.md`.

## Sign in

```bash
npx curb login
```

This opens your browser once. There is no key to copy, and every Curb command in the project then
uses your login. For CI or a server, set `KUGELAUDIO_API_KEY` in `.env`; it wins over the login.

## Talk to it

```bash
npm run dev
```

The preview opens on `http://127.0.0.1:4000` with Juno, the demo agent of a new project. Type to it,
or press **Start call** and talk. Beside the conversation, the Context panel shows what the model
has right now ([The preview](./preview.md)).

## Next steps

- [Project structure](./project-structure.md): what the installer created.
- [Agents and skills](./agents-and-skills.md): replace Juno with your own agent.
