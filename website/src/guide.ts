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
  { id: 'deploying', file: 'deploying.md', title: 'Deploying', group: 'Getting Started', description: "Put an agent live on your own servers, and what hosted deploys accept today." },
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
  { id: 'speech-to-speech', file: 'speech-to-speech.md', title: 'Speech-to-speech models', group: 'Guides', description: "Run a call on a speech-to-speech model such as OpenAI Live or Realtime." },
  { id: 'custom-llm', file: 'custom-llm.md', title: 'Your own LLM', group: 'Guides', description: "Run an agent on Anthropic, OpenAI or any OpenAI-compatible endpoint." },
  { id: 'mcp', file: 'mcp.md', title: 'MCP servers', group: 'Guides', description: "Give an agent tools from remote MCP servers." },
  { id: 'connecting', file: 'connecting.md', title: 'Connecting to a running agent', group: 'Guides', description: "How your app, your backend and other services talk to an agent, on KugelAudio and on your own servers." },
  { id: 'app-messages', file: 'app-messages.md', title: 'App messages', group: 'Guides', description: "Exchange messages with the caller's page and the host, without the model." },
  { id: 'goals-and-experiments', file: 'goals-and-experiments.md', title: 'Goals and experiments', group: 'Guides', description: "Say what a successful call is, and compare variants of an agent." },
  { id: 'after-call-code', file: 'after-call-code.md', title: 'After-call code', group: 'Guides', description: "Run your own code after each call, with the transcript, the call data and the goal results." },
  { id: 'outbound-calls', file: 'outbound-calls.md', title: 'Outbound calls', group: 'Guides', description: "The agent's side of a call it places: what it knows, and how it opens." },
  { id: 'web-calls', file: 'web-calls.md', title: 'Calls from your website', group: 'Guides', description: "Start a call from a page, and tell the agent where it came from." },
  { id: 'improve-from-calls', file: 'improve-from-calls.md', title: 'Improve from real calls', group: 'Guides', description: "Fix an agent from a real call's transcript, and test the fix." },
  { id: 'coding-agents', file: 'coding-agents.md', title: 'Working with a coding agent', group: 'Guides', description: "Build a Curb agent with a coding agent: the loop, the rules and connecting KugelAudio." },
  { id: 'reporting-a-bug', file: 'reporting-a-bug.md', title: 'Reporting a bug', group: 'Guides', description: "What a bug report holds and how to file it, for people and coding agents." },
  { id: 'preview', file: 'preview.md', title: 'The preview', group: 'Guides', description: "The curb dev page: chat, voice, the context the model reads, tools and recorded conversations." },
  { id: 'hosting', file: 'hosting.md', title: 'Self-hosting', group: 'Guides', description: "Run an agent on your own servers: dev, the LiveKit worker, a built artifact or a managed runner." },
  { id: 'migrate-from-elevenlabs', file: 'migrate-from-elevenlabs.md', title: 'Migrate from ElevenLabs', group: 'Guides', description: "Rebuild an ElevenLabs agent in Curb, test it and move your numbers." },
  { id: 'examples', file: 'examples.md', title: 'Example projects', group: 'Guides', description: "Five complete projects with scenarios you can run." },
  { id: 'api-reference', file: 'api-reference.md', title: 'Overview', group: 'API Reference', description: "Every part of Curb's API, by kind." },
  { id: 'components', file: 'components.md', title: 'Components', group: 'API Reference', description: "Agent, Skill, Tool, Procedure and every other component, with props and examples." },
  { id: 'components/agent', file: 'components/agent.md', title: '<Agent>', group: 'API Reference', parent: 'components', description: "The root of an agent: everything it says and can do renders inside it, and it sets the agent's LLM, speech-to-text and voice." },
  { id: 'components/system-prompt', file: 'components/system-prompt.md', title: '<SystemPrompt>', group: 'API Reference', parent: 'components', description: "The system prompt of an agent: its children are the prompt, and nothing is added when it compiles." },
  { id: 'components/skills', file: 'components/skills.md', title: '<Skills>', group: 'API Reference', parent: 'components', description: "Holds the Skill links the model may open. It takes no props." },
  { id: 'components/skill', file: 'components/skill.md', title: '<Skill>', group: 'API Reference', parent: 'components', description: "One link to a skill folder that the model opens with read_skill, with its description and its own providers." },
  { id: 'components/global-tools', file: 'components/global-tools.md', title: '<GlobalTools>', group: 'API Reference', parent: 'components', description: "Tools rendered inside GlobalTools are available in every skill of the agent. It takes no props." },
  { id: 'components/instruction', file: 'components/instruction.md', title: '<Instruction>', group: 'API Reference', parent: 'components', description: "Behavioural guidance for the model, as opposed to facts. It takes no props." },
  { id: 'components/text', file: 'components/text.md', title: '<Text>', group: 'API Reference', parent: 'components', description: "Factual context for the model, written inline or loaded from a markdown file under context/." },
  { id: 'components/tool', file: 'components/tool.md', title: '<Tool>', group: 'API Reference', parent: 'components', description: "What the model can call: its name, its input as a Zod schema, fields or nothing, and the handler that runs." },
  { id: 'components/field', file: 'components/field.md', title: '<Field>', group: 'API Reference', parent: 'components', description: "One input field of a Tool, written as a child: shorter than a Zod schema for a few flat fields." },
  { id: 'components/error-message', file: 'components/error-message.md', title: '<ErrorMessage>', group: 'API Reference', parent: 'components', description: "An error the model reads in its context on its next step, with where it came from." },
  { id: 'components/procedure', file: 'components/procedure.md', title: '<Procedure>', group: 'API Reference', parent: 'components', description: "An ordered flow of steps: the model sees the steps up to the current one and gets a tool to move on." },
  { id: 'components/step', file: 'components/step.md', title: '<Step>', group: 'API Reference', parent: 'components', description: "One step of a Procedure: its children render from that step on, and later steps stay hidden." },
  { id: 'components/mcp', file: 'components/mcp.md', title: '<Mcp>', group: 'API Reference', parent: 'components', description: "Tools from an MCP server, configured in defineAgent or declared in place, for one skill or for all of them." },
  { id: 'components/transfer-call-tool', file: 'components/transfer-call-tool.md', title: '<TransferCallTool>', group: 'API Reference', parent: 'components', description: "A ready tool that puts the caller through to a number and tells the model what happened." },
  { id: 'hooks', file: 'hooks.md', title: 'Hooks', group: 'API Reference', description: "useRouter, useSession, useSend and every other hook, with signatures and examples." },
  { id: 'hooks/use-router', file: 'hooks/use-router.md', title: 'useRouter', group: 'API Reference', parent: 'hooks', description: "Load a skill and make it active from code, when a tool's result decides what comes next." },
  { id: 'hooks/use-route-path', file: 'hooks/use-route-path.md', title: 'useRoutePath', group: 'API Reference', parent: 'hooks', description: "The path of the skill a component renders in, or null at the agent level." },
  { id: 'hooks/use-agent-info', file: 'hooks/use-agent-info.md', title: 'useAgentInfo', group: 'API Reference', parent: 'hooks', description: "Everything the call knows, or one value with a selector. The agent re-renders when a selected value changes." },
  { id: 'hooks/use-client', file: 'hooks/use-client.md', title: 'useClient', group: 'API Reference', parent: 'hooks', description: "What the caller's page said: the client values without the prefix. Never proof of identity." },
  { id: 'hooks/use-session', file: 'hooks/use-session.md', title: 'useSession', group: 'API Reference', parent: 'hooks', description: "The effective providers of a conversation, and the identity and scratch directory of this call." },
  { id: 'hooks/use-variant', file: 'hooks/use-variant.md', title: 'useVariant', group: 'API Reference', parent: 'hooks', description: "This call's variant of an experiment, or undefined where no variants are assigned." },
  { id: 'hooks/use-send', file: 'hooks/use-send.md', title: 'useSend', group: 'API Reference', parent: 'hooks', description: "Send a message to the caller's page or to the host, and ask the host for a reply." },
  { id: 'hooks/use-message', file: 'hooks/use-message.md', title: 'useMessage', group: 'API Reference', parent: 'hooks', description: "Handle a message from the caller's page or the host for as long as the component is mounted." },
  { id: 'hooks/use-transfer-call', file: 'hooks/use-transfer-call.md', title: 'useTransferCall', group: 'API Reference', parent: 'hooks', description: "Put the caller through to a number from your own code, and read how the transfer ended." },
  { id: 'functions', file: 'functions.md', title: 'Functions', group: 'API Reference', description: "defineAgent, createAgentStore, defineTool, the errors, and what programs built on Curb use." },
  { id: 'functions/define-agent', file: 'functions/define-agent.md', title: 'defineAgent', group: 'API Reference', parent: 'functions', description: "Declares an agent: its React tree, its limits, who speaks first, its MCP servers, goals, hooks and voice pipeline." },
  { id: 'functions/create-agent-store', file: 'functions/create-agent-store.md', title: 'createAgentStore', group: 'API Reference', parent: 'functions', description: "Creates a hook on state that lasts the whole call and survives a skill leaving the request." },
  { id: 'functions/define-tool', file: 'functions/define-tool.md', title: 'defineTool', group: 'API Reference', parent: 'functions', description: "Types the props of a Tool outside JSX, so a tool can live in its own file or be shared." },
  { id: 'functions/z', file: 'functions/z.md', title: 'z', group: 'API Reference', parent: 'functions', description: "Zod, re-exported from curb so a project validates tool input and messages with no dependency of its own." },
  { id: 'functions/errors', file: 'functions/errors.md', title: 'Errors', group: 'API Reference', parent: 'functions', description: "The errors Curb throws and a handler can throw: tool input, authoring, messages, the host and settings." },
  { id: 'providers', file: 'providers.md', title: 'Providers', group: 'API Reference', description: "Every LLM, speech-to-text and text-to-speech provider of curb/providers, and its options." },
  { id: 'providers/kugelaudio', file: 'providers/kugelaudio.md', title: 'kugelaudio', group: 'API Reference', parent: 'providers', description: "KugelAudio's LLM, speech-to-text and text-to-speech on one key, with every option of each." },
  { id: 'providers/anthropic', file: 'providers/anthropic.md', title: 'anthropic', group: 'API Reference', parent: 'providers', description: "Run an agent on an Anthropic model, with its key in ANTHROPIC_API_KEY." },
  { id: 'providers/openai', file: 'providers/openai.md', title: 'openai', group: 'API Reference', parent: 'providers', description: "Run an agent on an OpenAI model, and use OpenAI for speech-to-text and text-to-speech." },
  { id: 'providers/openai-compatible', file: 'providers/openai-compatible.md', title: 'openaiCompatible', group: 'API Reference', parent: 'providers', description: "Run an agent on any OpenAI-compatible endpoint, with its model and request options." },
  { id: 'providers/azure', file: 'providers/azure.md', title: 'azure', group: 'API Reference', parent: 'providers', description: "Use Azure speech-to-text, with its key, region and segmentation silence." },
  { id: 'providers/deepgram', file: 'providers/deepgram.md', title: 'deepgram', group: 'API Reference', parent: 'providers', description: "Use Deepgram speech-to-text, with its key in DEEPGRAM_API_KEY." },
  { id: 'providers/elevenlabs', file: 'providers/elevenlabs.md', title: 'elevenlabs', group: 'API Reference', parent: 'providers', description: "Use ElevenLabs speech-to-text and text-to-speech on your own servers." },
  { id: 'providers/cartesia', file: 'providers/cartesia.md', title: 'cartesia', group: 'API Reference', parent: 'providers', description: "Use Cartesia text-to-speech, with its key in CARTESIA_API_KEY." },
  { id: 'client', file: 'client.md', title: 'Client', group: 'API Reference', description: "curb/client: the browser side of a call, for your own page." },
  { id: 'testing-api', file: 'testing-api.md', title: 'Testing', group: 'API Reference', description: "curb/testing: the scenario function and its checks." },
  { id: 'orchestration-api', file: 'orchestration-api.md', title: 'Orchestration', group: 'API Reference', description: "curb/orchestration: server-only exports for scripts." },
  { id: 'configuration', file: 'configuration.md', title: 'Configuration', group: 'API Reference', description: "Every environment variable Curb reads, and the package.json settings." },
  { id: 'cli', file: 'cli.md', title: 'CLI', group: 'API Reference', description: "Every curb command and its options." },
  { id: 'cli/dev', file: 'cli/dev.md', title: 'curb dev', group: 'API Reference', parent: 'cli', description: "Start the preview, chat and voice on one port, and reload the agent on every save." },
  { id: 'cli/check', file: 'cli/check.md', title: 'curb check', group: 'API Reference', parent: 'cli', description: "Type-check a project and run the authoring checks. Exits 1 on errors." },
  { id: 'cli/say', file: 'cli/say.md', title: 'curb say', group: 'API Reference', parent: 'cli', description: "Run one caller turn headless and print the reply, the tool calls and what changed in the context." },
  { id: 'cli/test', file: 'cli/test.md', title: 'curb test', group: 'API Reference', parent: 'cli', description: "Run the conversation scenarios of a project, or those matching a filter. Exits 1 when one fails." },
  { id: 'cli/hook', file: 'cli/hook.md', title: 'curb hook', group: 'API Reference', parent: 'cli', description: "Run an agent's afterCall or afterEvaluation once on your machine, with the project's .env." },
  { id: 'cli/conversations', file: 'cli/conversations.md', title: 'curb conversations', group: 'API Reference', parent: 'cli', description: "Print the recorded conversations of curb dev, with every tool call and result." },
  { id: 'cli/start', file: 'cli/start.md', title: 'curb start', group: 'API Reference', parent: 'cli', description: "Run the LiveKit voice worker in production mode, optionally serving host protocol v1." },
  { id: 'cli/server', file: 'cli/server.md', title: 'curb server', group: 'API Reference', parent: 'cli', description: "Start only the agent WebSocket server, without the preview." },
  { id: 'cli/build', file: 'cli/build.md', title: 'curb build', group: 'API Reference', parent: 'cli', description: "Bundle a project for hosting, then start the finished artifact and render every skill to prove it runs." },
  { id: 'cli/upgrade', file: 'cli/upgrade.md', title: 'curb upgrade', group: 'API Reference', parent: 'cli', description: "Update a project's curb dependency to the latest version on npm, or check whether one is available." },
  { id: 'cli/info', file: 'cli/info.md', title: 'curb info', group: 'API Reference', parent: 'cli', description: "Print what a bug report needs: versions, providers and which environment variables are set, never a value." },
  { id: 'cli/voices', file: 'cli/voices.md', title: 'curb voices', group: 'API Reference', parent: 'cli', description: "List the KugelAudio voices a project can use, with the id kugelaudio.tts({ voice }) takes." },
  { id: 'cli/login', file: 'cli/login.md', title: 'curb login', group: 'API Reference', parent: 'cli', description: "Sign in to KugelAudio in the browser, so a project runs with no key in .env." },
  { id: 'cli/logout', file: 'cli/logout.md', title: 'curb logout', group: 'API Reference', parent: 'cli', description: "Revoke this machine's session and delete the stored credentials and project keys." },
  { id: 'cli/deploy', file: 'cli/deploy.md', title: 'curb deploy', group: 'API Reference', parent: 'cli', description: "Upload a project and make it the agent's live production deployment on KugelAudio hosting." },
  { id: 'cli/secrets-push', file: 'cli/secrets-push.md', title: 'curb secrets push', group: 'API Reference', parent: 'cli', description: "Set every variable in .env on a hosted agent's production environment. Prints names only, never values." },
  { id: 'diagnostics', file: 'diagnostics.md', title: 'Diagnostics', group: 'API Reference', description: "The check and fix loop, and every code curb check can report." },
  { id: 'host-protocol', file: 'host-protocol.md', title: 'Host protocol', group: 'API Reference', description: "How a host starts, follows and ends calls on a runner, with app messages and live settings." },
  { id: 'how-it-works', file: 'how-it-works.md', title: 'How Curb works', group: 'Architecture', description: "Curb is a real React renderer that targets a model's context. The renderer and the turn loop." },
  { id: 'what-the-model-receives', file: 'what-the-model-receives.md', title: 'What the model receives', group: 'Architecture', description: "The real requests of a conversation, and how state changes the tools in them." },
  { id: 'skill-lifecycle', file: 'skill-lifecycle.md', title: 'Skill lifecycle', group: 'Architecture', description: "When a skill joins the request, what it takes with it when it leaves, and how much history the model reads." },
  { id: 'voice-sessions', file: 'voice-sessions.md', title: 'Voice sessions', group: 'Architecture', description: "The one voice session every route runs: how a call opens, its identity, how it ends and what happens when something fails." },
  { id: 'architecture', file: 'architecture.md', title: 'Curb and its host', group: 'Architecture', description: "What Curb does, what a host does, and how they talk." },
  { id: 'glossary', file: 'glossary.md', title: 'Glossary', group: 'More', description: "What the terms in these docs mean." },
  { id: 'changelog', file: '../../../CHANGELOG.md', title: 'Changelog', group: 'More', description: "What changed in each version of Curb." },
] as const

export type GuidePage = (typeof ALL_PAGES)[number]
export type GuidePageId = GuidePage['id']

/** The pages to build. CHANGELOG.md lives beside website/. */
export function pagesToBuild(hasChangelog: boolean): readonly GuidePage[] {
  return ALL_PAGES.filter((page) => page.id !== 'changelog' || hasChangelog)
}

/** The navigation, llms.txt and llms-full.txt read this table. The build runs in website/. */
export const GUIDE_PAGES = pagesToBuild(existsSync('../CHANGELOG.md'))

export const GUIDE_GROUPS = ['Getting Started', 'Guides', 'API Reference', 'Architecture', 'More'] as const

/** The page's URL; the overview opens the docs. */
export function pageUrl(id: GuidePageId): string {
  return id === 'readme' ? '/docs/' : `/docs/${id}/`
}

/** The page's raw Markdown, for an agent. */
export function markdownUrl(id: GuidePageId): string {
  return id === 'readme' ? '/docs/index.md' : `/docs/${id}.md`
}

/** The pages under a page of the API Reference. */
export function childrenOf(id: GuidePageId): readonly GuidePage[] {
  return GUIDE_PAGES.filter((page) => 'parent' in page && page.parent === id)
}

/** The pages before and after this one, for the pager. */
export function neighbours(id: GuidePageId): { previous?: GuidePage; next?: GuidePage } {
  const index = GUIDE_PAGES.findIndex((page) => page.id === id)
  return { previous: GUIDE_PAGES[index - 1], next: GUIDE_PAGES[index + 1] }
}
