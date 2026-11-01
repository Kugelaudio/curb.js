<div align="center">
  <a href="https://curbjs.com"><img alt="Curb" src="https://curbjs.com/og.png?v=2" width="360"></a>
  <p><strong>The framework for production voice agents.</strong></p>
  <p>Dynamic prompting with full control, in plain code you own. Your coding agent can build, test, and simulate conversations before it ships.</p>
  <a href="https://www.npmjs.com/package/curb.js"><img alt="npm version" src="https://img.shields.io/npm/v/curb.js.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://curbjs.com/docs/installation/"><img alt="Node.js version" src="https://img.shields.io/node/v/curb.js.svg?style=for-the-badge&labelColor=000000"></a>
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img alt="License" src="https://img.shields.io/npm/l/curb.js.svg?style=for-the-badge&labelColor=000000"></a>
</div>

curb.js gives you a working voice agent out of the box. You write what it
knows and what it can do, as React components.

- **Voice is done.** Speech, turn-taking and interruptions are handled for you.
- **State changes the agent.** Tools and knowledge appear and disappear as
  your state changes, like UI in a React app.
- **Bring any model.** Use any speech-to-text, text-to-speech or LLM provider,
  hosted or self-hosted. Swapping one is a single line.
- **See every turn.** The dev preview shows exactly what the model saw, every
  tool call and every audio clip.

## Quickstart

You need Node.js 22.12 or newer.

```bash
npm create curb.js my-agent
cd my-agent
npx curb login         # sign in once in the browser
npm run dev            # open http://127.0.0.1:4000
```

> **The package is `curb.js`, not `curb`.** `curb` on npm is an unrelated templating
> package, so `npm i curb` installs the wrong thing. Start with `npm create curb.js`
> rather than `npm i curb.js`: the project depends on the framework through an alias,
> `"curb": "npm:curb.js@<version>"`, and your code imports from `"curb"`.

The defaults run speech-to-text, the LLM and text-to-speech on KugelAudio, so
`curb login` is all the setup you need. Flags to `npm create curb.js` pick
Anthropic, OpenAI, Azure, Deepgram, ElevenLabs, Cartesia or any OpenAI-compatible
endpoint instead.

Here is a complete skill, a coffee counter:

```tsx
import { useState } from "react";
import { z } from "zod";
import { Instruction, Tool } from "curb";

export default function Counter() {
  const [order, setOrder] = useState<string[]>([]);

  return (
    <>
      <Instruction>Take the customer's coffee order.</Instruction>

      {order.length === 0 ? "The order is empty." : `Current order: ${order.join(", ")}.`}

      <Tool
        name="add_drink"
        description="Add a drink to the order."
        schema={z.object({ drink: z.string() })}
        onSubmit={({ drink }) => {
          setOrder([...order, drink]);
          return { ok: true, message: "Added." };
        }}
      />

      {order.length > 0 && (
        <Tool
          name="place_order"
          description="Send the order to the bar."
          onSubmit={() => {
            setOrder([]);
            return { ok: true, message: "Order placed." };
          }}
        />
      )}
    </>
  );
}
```

Whatever the component renders is what the agent knows and can do right now.
`place_order` only exists once there is a drink in the order.

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
