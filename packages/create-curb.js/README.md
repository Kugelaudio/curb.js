<div align="center">
  <a href="https://curbjs.com"><img alt="Curb" src="https://curbjs.com/og.png?v=2" width="360"></a>
  <h1>create-curb.js</h1>
  <p><strong>The framework for production voice agents.</strong></p>
  <p>Dynamic prompting with full control, in plain code you own. Your coding agent can build, test, and simulate conversations before it ships.</p>
  <a href="https://www.npmjs.com/package/create-curb.js"><img alt="npm version" src="https://img.shields.io/npm/v/create-curb.js.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://curbjs.com/docs/installation/"><img alt="Node.js version" src="https://img.shields.io/node/v/create-curb.js.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img alt="License" src="https://img.shields.io/npm/l/create-curb.js.svg?style=for-the-badge&labelColor=000000"></a>
</div>

`create-curb.js` creates a Curb voice agent in one command. You need Node.js 22.12 or newer.

```bash
npm create curb.js my-agent
cd my-agent
npx curb login         # sign in once in the browser
npm run dev            # open http://127.0.0.1:4000
```

`npx curb login` signs you in once in your browser. `npm run dev` gives you a link to talk to your
agent. Run `npm create curb.js .` to create the project in an empty folder instead.

The framework's package is `curb.js`, not `curb`, which is unrelated. The project depends on it
through an alias, `"curb": "npm:curb.js@<version>"`, so your code imports from `"curb"`.

## Providers

The defaults run speech-to-text, the LLM and text-to-speech on KugelAudio with one sign-in. Nothing
is asked: flags after `--` pick other providers, and their API keys are read from the environment.

```bash
npm create curb.js my-agent -- --llm anthropic --tts elevenlabs
```

| Flag | Providers |
| --- | --- |
| `--stt` | `kugelaudio`, `azure`, `deepgram`, `elevenlabs`, `openai` |
| `--llm` | `kugelaudio`, `anthropic`, `openai`, `openai-compatible` |
| `--tts` | `kugelaudio`, `cartesia`, `elevenlabs`, `openai` |

`npm create curb.js -- --help` lists every option.

## Previews

To try the newest preview, create the project with `npm create curb.js@preview my-agent`.

## Documentation

- [Installation](https://curbjs.com/docs/installation/): create a project and talk to it.
- [Project structure](https://curbjs.com/docs/project-structure/): what the installer created.
- [All docs](https://curbjs.com/docs/) on curbjs.com.

## License

Licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
Copyright 2026 KugelAudio GmbH. Built by [KugelAudio](https://kugelaudio.com).
