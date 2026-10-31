import framework from '../../packages/framework/package.json'
import { pageUrl } from './guide'

export const CREATE_COMMAND = 'npm create curb.js .'

/** `>=22.12.0` as a person says it: 22.12. */
export const NODE_FLOOR = framework.engines.node.replace(/^>=(\d+\.\d+)\.\d+$/, '$1')

/** What the hero's button copies: a prompt that starts a coding agent on Curb. It links to the docs rather than repeating them. */
export function agentPrompt(site: URL): string {
  const url = (path: string) => new URL(path, site).href
  return `Help me build a voice AI agent with Curb.

Curb is an open-source framework for building voice AI agents in React. Components decide what the agent knows and can do, and Curb handles speech, turn-taking and interruptions. It runs on LiveKit Agents.

Your first step: ask me what the agent should do. Then read the docs, create the project and build it.

Docs, to read before you write code:
- ${url('/llms.txt')}: every docs page, with a link to its Markdown
- ${url('/llms-full.txt')}: the whole guide on one page
- ${url(pageUrl('readme'))}: the docs for people
- node_modules/curb/docs/agent-guide/: the guide for the installed version, once the project exists. Start with README.md, and trust it over the website.

Start:
1. Check that \`node --version\` is ${NODE_FLOOR} or newer.
2. In an empty folder (make one if this folder has files in it), run \`${CREATE_COMMAND}\`. It asks nothing and installs the dependencies.
3. Follow the AGENTS.md it writes there, and replace the demo agent in the project with mine.

Check every change:
- \`npx curb check\`: type-checks src/ and runs the diagnostics. Fix every error and warning.
- \`npx curb say "<what a caller says>"\`: runs one caller turn and prints the reply, tool calls and context change.
- \`npx curb test\`: runs the conversation scenarios in src/**/*.scenario.ts.
- \`npx curb dev\`: the browser preview with chat and voice, on http://127.0.0.1:4000 by default.

Keys: never ask me for a key in this chat, and never put one in a command or a tool call. Before your first \`npx curb say\`, run \`npx curb login\` in the project: it opens my browser once to sign in, and the default agent needs no key. Any other key goes in .env, which I fill in myself.`
}
