# Curb

Curb is a React framework for production voice agents. You write the agent as a tree of
components, and Curb renders that tree into what the model gets on each turn: its context and
its tools. When your state changes, the next request changes with it. A tool your code does not
render is not in the request, so the model cannot call it.

Curb also runs the rest of the call: speech to text, text to speech, turn-taking and
interruptions, a browser preview, and a test runner that plays whole conversations with no
microphone.

## How to use the docs

The docs have four parts, plus a [Glossary](./glossary.md) and a changelog:

- **Getting Started**: read in order. It takes you from an empty folder to a finished insurance
  agent, one feature at a time.
- **Guides**: one task per page, such as handing a call to a person. Read the one you need.
- **API Reference**: one page per component, hook, function, provider and command, with its
  signature, an example and its version history.
- **Architecture**: how Curb works underneath, for when you want the full picture.

Press `/` to search, or read any page as Markdown from the link beside it. For a coding agent,
[llms.txt](/llms.txt) lists every page, and the same guide ships inside the `curb` package at
`node_modules/curb/docs/agent-guide/`, matched to the installed version.

## What you should know first

The docs assume you know React and TypeScript. You do not need to know anything about speech:
Curb runs that part, and the [Voice](./voice.md) page shows what you can change.

You need Node.js 22.12 or newer. A new project runs on KugelAudio with one sign-in. You can use
other providers for every part of the pipeline, and you can host the agent yourself.

## The core idea

```tsx
export default function ReportClaim() {
  const [verified, setVerified] = useState(false);
  if (!verified) return <>
    <Instruction>Ask for the policy number.</Instruction>
    <Tool name="verify_policy" … />
  </>;
  return <>
    <Instruction>Ask what happened.</Instruction>
    <Tool name="open_claim" … />
  </>;
}
```

Until the policy is verified, `open_claim` does not exist for the model, whatever the caller
says. [What the model receives](./what-the-model-receives.md) shows the real requests.

## Next steps

- [Installation](./installation.md): create your first agent.
- [How Curb works](./how-it-works.md): the renderer and the turn loop.
- [Connecting to a running agent](./connecting.md): how your app and your backend talk to an agent.
