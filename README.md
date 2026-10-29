<div align="center">
  <h1>curb.js</h1>
  <p><strong>The React framework for voice agents.</strong></p>

<a href="https://kugelaudio.com"><img alt="Made by KugelAudio" src="https://img.shields.io/badge/MADE%20BY%20KugelAudio-000000.svg?style=for-the-badge&labelColor=000000"></a>
<img alt="Status: pre-release" src="https://img.shields.io/badge/STATUS-PRE--RELEASE-E8590C.svg?style=for-the-badge&labelColor=000000">

  <p>
    <a href="#quickstart"><strong>Quickstart</strong></a> ·
    <a href="#how-an-agent-is-built"><strong>How it works</strong></a> ·
    <a href="#the-dev-loop"><strong>The dev loop</strong></a> ·
    <a href="#deploy-to-kugelaudio"><strong>Hosted by KugelAudio</strong></a> ·
    <a href="#status"><strong>Status</strong></a>
  </p>
</div>

---

curb.js gives you a working voice agent out of the box. Your job is the
**context**: what the agent knows, what rules it follows, and what it can do.

- **The voice agent ships ready.** Speech, turn-taking, and handling
  interruptions are the framework's job.
- **You write the context as a small React app.** Components render the
  agent's instructions, knowledge, and tools.
- **State changes the agent.** As your state changes, tools and knowledge
  appear, disappear, or swap out, exactly like UI elements in a normal
  React app.
- **Bring any model.** curb.js is the framework; the models are your choice.
  Speech-to-text and text-to-speech from KugelAudio, Azure, Deepgram,
  ElevenLabs, Cartesia, OpenAI or any LiveKit plugin, and any Anthropic, OpenAI
  or OpenAI-compatible LLM (including self-hosted). Swap one in a single line.
- **It's a real React renderer.** Like react-dom targets the browser,
  curb.js targets the agent's context: components become what the model
  sees. The same tree renders as UI in the dev preview, where you talk to
  the agent and debug every turn, tool call, and audio clip.

> **Don't want to run infrastructure?** KugelAudio hosts curb agents for you:
> deploy from the CLI, and get phone numbers, scaling, and call logs included.
> [Deploy on KugelAudio →](https://kugelaudio.com) · [How hosting works](#hosting)

Here is a complete skill, a coffee counter. Drop it into
`src/agent/counter/skill.tsx` of a fresh project, link it from the agent's
`<Skills>` list, and talk to it:

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

It's just a React component. Whatever it renders is what the agent knows and
can do at that moment. Notice the last block: checkout only exists once the
order has a drink in it. You control the agent the way a React UI controls
what a user can click.

## Quickstart

Curb needs Node.js 22.12 or newer: `create-curb-app` and the `curb` CLI both
refuse an older Node with an `UnsupportedNodeVersion` error. CI tests Node 22
and 24 on Linux, the supported platform. macOS is used for day-to-day
development but is not tested in CI, and Windows is not tested.

Start the installer:

```bash
npm create kugelaudio my-agent
```

It walks you through the voice pipeline: pick a provider per slot, paste
another provider's API key once (with links to where to get it), and it
scaffolds the project, writes your `.env`, and installs:

```text
  1. Speech-to-text   KugelAudio (Kugel Ear)
  2. LLM              KugelAudio · qwen3.8-27b
  3. Text-to-speech   KugelAudio · kugel-3.5
```

The defaults run the whole agent on KugelAudio (its EU-hosted LLM, Kugel Ear and Kugel
TTS). Sign in with `npx curb login`; there is no key to copy, and every curb command in
the project then runs on your login. A `KUGELAUDIO_API_KEY` in `.env` or the environment
(an API key from the dashboard, for CI or a server) works too and wins over the login.
Anthropic, OpenAI and any OpenAI-compatible endpoint stay one pick away.

Then run it:

```bash
cd my-agent
npx curb login         # sign in in the browser; Curb uses your login
npm run dev            # everything on http://127.0.0.1:4000
```

This opens the **preview**: a web app where you meet your agent. Type into
the conversation, or press **Start call** and talk: both land in the same
thread. The conversation title opens restorable preview history, so you can
start another thread and return to the original transcript and agent state.
The scaffolded demo is **Juno**, a personal assistant: put tasks on her list,
tell her things to remember, and ask "how does this work?".

> Not on npm yet. For now, scaffold from a checkout of this repo:
> `npm install` once at the root, then `npm run new -- ~/my-agent`.

Voice works out of the box: in `npm run dev` a call runs over the page's own
connection to the dev server, so there is nothing else to install or start.
Several agents can run side by side; if 4000 is taken the preview simply
moves to 4001. Set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`
to run calls through your own LiveKit deployment instead.
Providers beyond the defaults (OpenAI or any OpenAI-compatible LLM endpoint;
Deepgram, ElevenLabs, Cartesia, OpenAI for speech) are offered in the
installer, and missing keys only disable their own feature. The startup log
tells you what's off.

To update an existing project to the newest framework release, run
`npm run upgrade` inside it: it repoints the `curb` dependency at the latest
published tarball and reinstalls. The dev server also prints a one-line notice
when an update is out. Projects scaffolded from a repo checkout update via git
instead.

To host the actual voice agent, add your deployed LiveKit project's
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`, then run
`npm start` as a long-running process. This starts the production LiveKit
worker without the preview. Configure LiveKit room or SIP dispatch to target
the worker's name: `CURB_AGENT_NAME` when set, otherwise the project's package
name.

## Hosting

A curb agent runs anywhere Node runs, with your own LiveKit deployment and your
own provider keys; no hosted platform is involved. `npx curb build` turns a
project into one self-contained directory. Run it as a LiveKit worker, or start
it as a managed runner (`CURB_MANAGEMENT_ADDR` + `CURB_MANAGEMENT_TOKEN`) that
your own orchestrator places calls on over a small, versioned HTTP protocol
with a published JSON Schema. See
[packages/framework/docs/hosting.md](packages/framework/docs/hosting.md) for the
ways to run an agent and the full host protocol v1 reference.

### Deploy to KugelAudio

Prefer not to run LiveKit, workers, and telephony yourself? KugelAudio hosts curb
agents: every deploy is built and verified, then goes live behind a playground link,
with phone numbers, call logs, and scaling handled for you.
**[Deploy on KugelAudio →](https://kugelaudio.com)**

Sign in once and deploy from the project root:

```bash
npx curb login          # browser sign-in; session and project keys in ~/.config/curb/
npx curb secrets push   # every .env variable onto the agent's production environment (names printed, never values)
npx curb deploy         # pack, upload, build, go live; prints the playground URL
npx curb logout         # revoke and delete the stored session and project keys
```

The first `deploy` or `secrets push` picks or creates the hosted agent and saves it in
`.curb/link.json`. See
[packages/framework/docs/deploy.md](packages/framework/docs/deploy.md) for flags, what is
uploaded, and the limits.

## Why it works well

- **You always know what the model sees.** The entire context (prompt, facts,
  tools) is the output of one render, and the dev preview shows it to you for
  every single turn. No prompt strings scattered across files.
- **Skills work like pages.** Each `skill.tsx` is one topic the agent opens
  when the conversation goes there. Only a few stay loaded at once, so an
  agent with 50 skills still sends a small, cacheable prompt.
- **Conversation behavior is built in.** On top of
  [LiveKit agents](https://github.com/livekit/agents-js) (WebRTC, voice
  activity detection, turn endpointing), curb agents stay quiet while a
  caller thinks out loud, check in after a long pause, and handle being
  talked over: the history is corrected to the words that were actually
  spoken, so the agent knows exactly where it was cut off.
- **You can see why anything happened.** Every message's exact audio is one
  click away, a complete call can be replayed or downloaded, any conversation
  can be rewound to an earlier turn, and one click copies a transcript
  formatted for a coding agent, so Claude Code or Cursor can improve your
  agent from a real conversation.

## How an agent is built

Everything you write lives in `src/agent/`. Three kinds of files:

```text
my-agent/
  src/agent/
    agent.tsx          # who the agent is, and where every conversation starts:
                       # prompt, voice, model, skill index
    counter/skill.tsx  # one skill per topic, like pages, opened when needed
    menu/skill.tsx
  context/menu.md      # plain markdown the agent can know
```

**A skill is a component plus a one-line description** the model uses to
decide when to go there. Here is a complete file-backed skill, a café menu:

```tsx
import { Instruction, Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Menu",
  description: "The Curb Café menu: drinks, sizes, prices.",
};

export default function Menu() {
  return (
    <>
      <Instruction>Answer menu questions from the menu below.</Instruction>
      <Text src="menu.md" />
    </>
  );
}
```

That `<Text src="menu.md" />` line is the whole knowledge story: the menu is
a markdown file. Edit it, save, and the agent knows the new prices. No code,
no re-deploy, hot-reloaded in dev.

**The agent itself is a few lines in `agent.tsx`:**

```tsx
import { Agent, Skill, Skills, SystemPrompt, defineAgent } from "curb";
import { kugelaudio } from "curb/providers";

function App() {
  return (
    // Providers are props. Optional: these are the defaults (plus Azure speech-to-text).
    <Agent llm={kugelaudio.llm()} tts={kugelaudio.tts({ voice: 1072, language: "en" })}>
      <SystemPrompt>
        You are Kona, the barista at Curb Café. Be warm and quick, one or
        two sentences per reply.
      </SystemPrompt>
      <Skills>
        <Skill path="/counter" description="Use for coffee orders.">The counter</Skill>
        <Skill path="/menu" description="Menu questions: drinks, sizes, prices.">Menu</Skill>
      </Skills>
    </Agent>
  );
}

export const agent = defineAgent({ app: App });
```

A conversation starts at the agent level: the prompt and the skill index are
in context from the first turn, and a skill joins only when the conversation
needs it. The prompt is exactly what you write. In voice sessions the framework
appends its own spoken-reply rules at runtime (short turns, no markdown out
loud, when to stay silent, how to behave after being interrupted), so every
agent sounds like a person on a call without you writing those rules.

From here it grows like any React app:

- **Shared state**: `createAgentStore` (Zustand-style) makes state like the
  order visible to every skill; rendering from it is what gates tools.
- **`<Gate>`**: content and tools locked behind a credential check
  (an email, an order number). Locked means *not rendered*.
- **`<Procedure>`**: an ordered workflow the agent must walk step by step.
- **`<Mcp>`**: plug in a remote MCP server (Linear, Notion, …); its tools
  join the agent's tools, OAuth handled in the preview.
- **`useAgentInfo`**: data from outside the conversation, like the caller's
  phone number, readable from any component.

## The dev loop

`npm run dev` serves the preview on one port. It renders the agent's context
as an interactive UI: tools become forms you can fill in and submit yourself,
a `<Gate>` becomes a login card, a `<Procedure>` a stepper whose button
advances it, knowledge a set of documents. Everything the model can do, you
can do by clicking, and the agent's state changes the same way. Around it:

- **One conversation, typed or spoken**: **Start call** attaches voice to
  the same thread, with live transcription, tool calls you can open, per-message
  audio, rewind to any turn; hang up and keep typing.
- **Restorable conversation history**: start another conversation, then
  switch back to its complete transcript and live agent state from the header.
- **Synchronized call replay**: the preview records the microphone and agent
  audio together, preserving pauses, overlap, and interruptions. Play or scrub
  the timeline to reveal messages at the moment they happened, or download the
  complete call as one WAV. When a user speaks or types over the agent,
  generated text that was not spoken is visibly muted after the interruption
  marker.
- **Context inspector**: the exact compiled context, turn by turn, with the
  diff each tool call caused.
- **Diagnostics**: `curb check` validates the whole agent (unreachable
  skills, duplicate tools, missing descriptions …) with concrete fixes.
- **Copy for coding agent**: a coding-agent-ready transcript of the conversation,
  with your skill map attached.
- Every conversation is recorded to a local JSON-lines file, `.data/conversations.jsonl` (`npx curb conversations`).

## Repository layout

An npm workspace, structured like Next.js:

```text
curb.js/
  packages/framework/          # the framework (published as "curb")
  packages/create-curb-app/    # the scaffolder
  examples/insurance-agent/    # a bigger real-world demo (claims, gate, procedure)
  examples/ops-agent/          # an MCP-heavy example
```

```bash
npm install     # once, at the repo root
npm run dev     # the insurance example on http://127.0.0.1:4000
npm test        # framework test suite
```

## Status

curb.js is in active development ahead of a first public release: APIs may
still move and the packages are not yet on npm. Production LiveKit workers
are scaffolded; SIP trunks and dispatch rules are configured in LiveKit.
Feedback from early builds is very welcome.

Built by [KugelAudio](https://kugelaudio.com). Agents speak with
[Kugel TTS](https://kugelaudio.com) by default, and every provider is
swappable.

## License

curb.js is licensed under the [Apache License 2.0](LICENSE).
Copyright 2026 KugelAudio GmbH. Third-party components and their licenses are
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
