<div align="center">
  <a href="https://curbjs.com"><img alt="Curb" src="https://curbjs.com/og.png?v=3" width="360"></a>
  <p><strong>Voice agents your coding agent can build and improve.</strong></p>
  <p>Describe the agent you want. Your coding agent builds it, talks to it, and improves it. Run it on your own servers, or let KugelAudio host it.</p>
  <a href="https://www.npmjs.com/package/curb.js"><img alt="npm version" src="https://img.shields.io/npm/v/curb.js.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://curbjs.com/docs/installation/"><img alt="Node.js version" src="https://img.shields.io/node/v/curb.js.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img alt="License" src="https://img.shields.io/npm/l/curb.js.svg?style=for-the-badge&labelColor=000000"></a>
</div>

## Quickstart

You need Node.js 22.12 or newer, on Linux or macOS, or on Windows through WSL.

```bash
npm create curb.js my-agent
cd my-agent
npx curb login         # sign in once in the browser
npm run dev            # open http://127.0.0.1:4000
```

`npm run dev` opens the **preview**, where you talk to your agent: type, or press **Start call**
and speak. The starter agent is **Juno**, a personal assistant. Ask her "how does this work?",
then make `src/agent/agent.tsx` your own.

## Your first agent

A receptionist for a bike workshop, in `src/agent/agent.tsx`:

```tsx
import { useState } from "react";
import { Agent, GlobalTools, Skill, Skills, SystemPrompt, Tool, defineAgent, z } from "curb";
import { kugelaudio } from "curb/providers";

function App() {
  const [booked, setBooked] = useState<string>();

  return (
    <Agent llm={kugelaudio.llm()} stt={kugelaudio.stt()} tts={kugelaudio.tts()}>
      <SystemPrompt>
        You are Mia, the receptionist at Parkside Bikes. Keep your replies short.
      </SystemPrompt>

      {booked ? `Booked: ${booked}.` : "Free slots: Tuesday 9:00, Thursday 11:00."}

      <GlobalTools>
        <Tool
          name="book_repair"
          description="Book a repair appointment in a free slot."
          schema={z.object({ slot: z.string() })}
          onSubmit={({ slot }) => {
            setBooked(slot);
            return { ok: true, message: `Booked for ${slot}.` };
          }}
        />
        {booked && (
          <Tool
            name="cancel_booking"
            description="Cancel the caller's appointment."
            onCall={() => {
              setBooked(undefined);
              return { ok: true, message: "Cancelled." };
            }}
          />
        )}
      </GlobalTools>

      <Skills>
        <Skill path="/prices">Repair prices</Skill>
      </Skills>
    </Agent>
  );
}

export const agent = defineAgent({ app: App });
```

Whatever `<Agent>` renders is what the model knows and can do right now. `cancel_booking` exists
only once a slot is booked, so the model cannot call it before. `/prices` is a
[skill](https://curbjs.com/docs/agents-and-skills/): the model opens it when the caller asks what a
repair costs.

## How it works

You write the agent as React components:

- who it is, in a system prompt
- what it can do, as tools: functions with typed input
- what it knows, in skills and plain markdown
- conversations to keep as tests

Curb runs everything else:

- speech-to-text, the LLM and text-to-speech, each swappable in one line
- turn-taking, interruptions and pauses on a live call
- the model's request on every turn, with only the instructions and tools your state allows
- a preview where you talk to the agent and see what the model saw

The defaults run speech-to-text, the LLM and text-to-speech on KugelAudio, so
`curb login` is all the setup you need. Flags to `npm create curb.js` pick
Anthropic, OpenAI, Azure, Deepgram, ElevenLabs, Cartesia or any OpenAI-compatible
endpoint instead.

> **The package is `curb.js`, not `curb`.** `curb` on npm is an unrelated templating
> package, so `npm i curb` installs the wrong thing. Start with `npm create curb.js`
> rather than `npm i curb.js`: the project depends on the framework through an alias,
> `"curb": "npm:curb.js@<version>"`, and your code imports from `"curb"`.

## Documentation

The docs live on [curbjs.com](https://curbjs.com/docs/):

- [Installation](https://curbjs.com/docs/installation/): create a project and talk to it.
- [How Curb works](https://curbjs.com/docs/how-it-works/): from a React render to a spoken reply.
- [Agents and skills](https://curbjs.com/docs/agents-and-skills/): structure what an agent knows.
- [Tools](https://curbjs.com/docs/tools/): give it things to do.
- [Providers](https://curbjs.com/docs/providers/): swap the LLM, speech-to-text or text-to-speech.
- [Testing](https://curbjs.com/docs/testing/): simulate conversations before they reach a caller.
- [Self-hosting](https://curbjs.com/docs/hosting/): run an agent on your own servers.

## License

Curb is licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
Copyright 2026 KugelAudio GmbH. Built by [KugelAudio](https://kugelaudio.com). Third-party
components and their licenses are listed in `THIRD_PARTY_NOTICES.md` in this package.
