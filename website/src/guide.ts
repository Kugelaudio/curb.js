import { existsSync } from 'node:fs'

/** Every guide page in reading order. */
const ALL_PAGES = [
  { id: 'readme', file: 'README.md', title: 'Introduction', group: 'Getting Started', description: "Curb is a React framework for production voice agents: the tree you render becomes the model's context and tools. How these docs are organized." },
  { id: 'installation', file: 'installation.md', title: 'Installation', group: 'Getting Started', description: "Create a Curb project, sign in, talk to your agent and change it." },
  { id: 'project-structure', file: 'project-structure.md', title: 'Project structure', group: 'Getting Started', description: "What each file in a Curb project does, and where a skill lives." },
  { id: 'agents-and-skills', file: 'agents-and-skills.md', title: 'Agents and skills', group: 'Getting Started', description: "Write agent.tsx and your skills: what is in every request, and what the model opens when it needs it." },
  { id: 'tools', file: 'tools.md', title: 'Tools', group: 'Getting Started', description: "Give the agent actions: schemas, results, calling your own API and the tools Curb provides." },
  { id: 'state', file: 'state.md', title: 'State and conditional tools', group: 'Getting Started', description: "Keep state for the whole call, and render a tool only when it should exist." },
  { id: 'instructions-and-context', file: 'instructions-and-context.md', title: 'Instructions and context', group: 'Getting Started', description: "Write what the model reads: instructions, facts and files from context/." },
  { id: 'voice', file: 'voice.md', title: 'Voice', group: 'Getting Started', description: "Choose the LLM, speech-to-text and text-to-speech of an agent, and of each skill." },
  { id: 'testing', file: 'testing.md', title: 'Testing', group: 'Getting Started', description: "Test an agent from the command line: curb check, curb say and curb test." },
  { id: 'deploying', file: 'deploying.md', title: 'Deploying', group: 'Getting Started', description: "Put an agent live with curb deploy, or on your own servers." },
  { id: 'upgrading', file: 'upgrading.md', title: 'Upgrading', group: 'Getting Started', description: "Update Curb in a project, and what to do after an upgrade." },
  { id: 'human-handoff', file: 'human-handoff.md', title: 'Human handoff', group: 'Guides', description: "Put the caller through to a person, with a way out when nobody answers." },
  { id: 'complex-handoffs', file: 'complex-handoffs.md', title: 'Complex handoffs', group: 'Guides', description: "Hand over by code, to a skill with its own voice, or to a person with a note." },
  { id: 'confirmations', file: 'confirmations.md', title: 'Confirmations', group: 'Guides', description: "Hold an action until the caller says yes, with the exact question they hear." },
  { id: 'procedures', file: 'procedures.md', title: 'Step-by-step procedures', group: 'Guides', description: "Take the model through ordered steps, and unlock the last tool only when every step is done." },
  { id: 'who-speaks-first', file: 'who-speaks-first.md', title: 'Who speaks first', group: 'Guides', description: "Set who opens the call, and the exact words when they must not vary." },
  { id: 'mid-call-changes', file: 'mid-call-changes.md', title: 'Mid-call changes', group: 'Guides', description: "Change language, voice or model during a call, from the agent, the page or the host." },
  { id: 'livekit-pipeline', file: 'livekit-pipeline.md', title: 'Override the LiveKit pipeline', group: 'Guides', description: 'Edit the LiveKit session and agent on every route, or write your own worker.' },
  { id: 'knowing-the-caller', file: 'knowing-the-caller.md', title: 'Knowing the caller', group: 'Guides', description: "Use what a call already knows, and what the caller's page said, without trusting it." },
  { id: 'pronunciation', file: 'pronunciation.md', title: 'Pronunciation', group: 'Guides', description: "Make the agent hear and say your product's names correctly." },
  { id: 'custom-llm', file: 'custom-llm.md', title: 'Your own LLM', group: 'Guides', description: "Run an agent on Anthropic, OpenAI or any OpenAI-compatible endpoint." },
  { id: 'mcp', file: 'mcp.md', title: 'MCP servers', group: 'Guides', description: "Give an agent tools from remote MCP servers." },
  { id: 'app-messages', file: 'app-messages.md', title: 'App messages', group: 'Guides', description: "Exchange messages with the caller's page and the host, without the model." },
  { id: 'goals-and-experiments', file: 'goals-and-experiments.md', title: 'Goals and experiments', group: 'Guides', description: "Say what a successful call is, and compare variants of an agent." },
  { id: 'outbound-calls', file: 'outbound-calls.md', title: 'Outbound calls', group: 'Guides', description: "The agent's side of a call it places: what it knows, and how it opens." },
  { id: 'web-calls', file: 'web-calls.md', title: 'Calls from your website', group: 'Guides', description: "Start a call from a page, and tell the agent where it came from." },
  { id: 'improve-from-calls', file: 'improve-from-calls.md', title: 'Improve from real calls', group: 'Guides', description: "Fix an agent from a real call's transcript, and test the fix." },
  { id: 'coding-agents', file: 'coding-agents.md', title: 'Working with a coding agent', group: 'Guides', description: "Build a Curb agent with a coding agent: the loop, the rules and connecting KugelAudio." },
  { id: 'preview', file: 'preview.md', title: 'The preview', group: 'Guides', description: "The curb dev page: chat, voice, the context the model reads, tools and recorded conversations." },
  { id: 'hosting', file: 'hosting.md', title: 'Self-hosting', group: 'Guides', description: "Run an agent on your own servers: dev, the LiveKit worker, a built artifact or a managed runner." },
  { id: 'migrate-from-elevenlabs', file: 'migrate-from-elevenlabs.md', title: 'Migrate from ElevenLabs', group: 'Guides', description: "Rebuild an ElevenLabs agent in Curb, test it and move your numbers." },
  { id: 'examples', file: 'examples.md', title: 'Example projects', group: 'Guides', description: "Five complete projects with scenarios you can run." },
  { id: 'how-it-works', file: 'how-it-works.md', title: 'How Curb works', group: 'Concepts', description: "Curb is a real React renderer that targets a model's context. The renderer and the turn loop." },
  { id: 'what-the-model-receives', file: 'what-the-model-receives.md', title: 'What the model receives', group: 'Concepts', description: "The real requests of a conversation, and how state changes the tools in them." },
  { id: 'skill-lifecycle', file: 'skill-lifecycle.md', title: 'Skill lifecycle', group: 'Concepts', description: "When a skill joins the request, what it takes with it when it leaves, and how much history the model reads." },
  { id: 'voice-sessions', file: 'voice-sessions.md', title: 'Voice sessions', group: 'Concepts', description: "The one voice session every route runs: how a call opens, its identity, how it ends and what happens when something fails." },
  { id: 'architecture', file: 'architecture.md', title: 'Architecture', group: 'Concepts', description: "What Curb does, what a host does, and how they talk." },
  { id: 'api-reference', file: 'api-reference.md', title: 'Overview', group: 'API Reference', description: "Every part of Curb's API, by kind." },
  { id: 'components', file: 'components.md', title: 'Components', group: 'API Reference', description: "Agent, Skill, Tool, Procedure and every other component, with props and examples." },
  { id: 'hooks', file: 'hooks.md', title: 'Hooks', group: 'API Reference', description: "useRouter, useSession, useSend and every other hook, with signatures and examples." },
  { id: 'functions', file: 'functions.md', title: 'Functions', group: 'API Reference', description: "defineAgent, createAgentStore, defineTool, the errors, and what programs built on Curb use." },
  { id: 'providers', file: 'providers.md', title: 'Providers', group: 'API Reference', description: "Every LLM, speech-to-text and text-to-speech provider of curb/providers, and its options." },
  { id: 'client', file: 'client.md', title: 'Client', group: 'API Reference', description: "curb/client: the browser side of a call, for your own page." },
  { id: 'testing-api', file: 'testing-api.md', title: 'Testing', group: 'API Reference', description: "curb/testing: the scenario function and its checks." },
  { id: 'orchestration-api', file: 'orchestration-api.md', title: 'Orchestration', group: 'API Reference', description: "curb/orchestration: server-only exports for scripts." },
  { id: 'configuration', file: 'configuration.md', title: 'Configuration', group: 'API Reference', description: "Every environment variable Curb reads, and the package.json settings." },
  { id: 'cli', file: 'cli.md', title: 'CLI', group: 'API Reference', description: "Every curb command and its options." },
  { id: 'diagnostics', file: 'diagnostics.md', title: 'Diagnostics', group: 'API Reference', description: "The check and fix loop, and every code curb check can report." },
  { id: 'host-protocol', file: 'host-protocol.md', title: 'Host protocol', group: 'API Reference', description: "How a host starts, follows and ends calls on a runner, with app messages and live settings." },
  { id: 'glossary', file: 'glossary.md', title: 'Glossary', group: 'More', description: "What the terms in these docs mean." },
  { id: 'changelog', file: '../../../CHANGELOG.md', title: 'Changelog', group: 'More', description: "What changed in each version of Curb." },
] as const

export type GuidePage = (typeof ALL_PAGES)[number]
export type GuidePageId = GuidePage['id']

/** The pages to build. CHANGELOG.md lives beside website/ on curb.js, and joins with the first approved release notes. */
export function pagesToBuild(hasChangelog: boolean): readonly GuidePage[] {
  return ALL_PAGES.filter((page) => page.id !== 'changelog' || hasChangelog)
}

/** The navigation, llms.txt and llms-full.txt read this table. The build runs in website/. */
export const GUIDE_PAGES = pagesToBuild(existsSync('../CHANGELOG.md'))

export const GUIDE_GROUPS = ['Getting Started', 'Guides', 'Concepts', 'API Reference', 'More'] as const

/** The page's URL; the overview opens the docs. */
export function pageUrl(id: GuidePageId): string {
  return id === 'readme' ? '/docs/' : `/docs/${id}/`
}

/** The page's raw Markdown, for an agent. */
export function markdownUrl(id: GuidePageId): string {
  return id === 'readme' ? '/docs/index.md' : `/docs/${id}.md`
}

/** The pages before and after this one, for the pager. */
export function neighbours(id: GuidePageId): { previous?: GuidePage; next?: GuidePage } {
  const index = GUIDE_PAGES.findIndex((page) => page.id === id)
  return { previous: GUIDE_PAGES[index - 1], next: GUIDE_PAGES[index + 1] }
}
