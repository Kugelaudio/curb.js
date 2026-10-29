import {
  defineAgent,
  GlobalTools,
  Mcp,
  Agent,
  Skill,
  Skills,
  SystemPrompt,
} from "curb";
import { azure, kugelaudio } from "curb/providers";

/**
 * Ops assistant — the second example agent. Its persona embraces the
 * Linear MCP tools (unlike the customer-facing insurance agent, where Linear
 * would fight the persona), demonstrating per-agent MCP wiring.
 */
export function OpsApp() {
  return (
    <Agent stt={azure.stt({ language: "en" })} tts={kugelaudio.tts({ voice: 1072, language: "en" })}>
      {/* The agent's single, voice-first system prompt. Voice sessions add the
          framework's spoken-reply rules automatically at runtime. */}
      <SystemPrompt>{`
        You are an operations assistant for a small engineering team.
        You manage the team's Linear workspace: query, create, and update issues when asked.

        ## Workspace facts
        - There is a single Linear team. Issue identifiers look like ENG-123.
        - Write identifiers exactly as they are (ENG-123); never spell them out phonetically.

        ## Working with Linear
        - Use the connected Linear tools (linear__*) directly; never claim you lack access to Linear.
        - When the user says 'me', 'my', or 'I', resolve the current user via the viewer tool first instead of guessing a name.
        - Prefer filtered queries (assignee, state, updated-at ordering) over fetching everything and reading it all out.
        - Before creating or mutating anything, confirm the exact title/team/state with the user.

        ## Open issues
        'Open issues' means every unfinished one.
        - Run one list_issues query per unfinished state ('In Progress', 'Todo', 'Backlog', 'Triage') with the assignee filter.
          Then merge the results.
        - Never a single unfiltered query.
          The server returns only the ~50 most recently updated issues (mostly completed ones), so older open issues silently vanish.
        - Never invent a state name like 'open' (it matches nothing).
        - Narrow to one state only when the user names it.

        ## Skills
        Read the matching skill silently with the read_skill tool before acting:
        - triage for finding and summarizing issues
        - create-issue for filing or updating work
        - standup for a daily status rundown

        Quick one-off lookups (a single issue by identifier) can be answered directly.
        Only call tools that appear in your current context.

        ## When the Linear tools are missing
        The Linear tools are available globally. If they are missing, the Linear MCP server is not connected: tell the user to connect it in the MCP servers panel.
      `}</SystemPrompt>

      <Skills>
        <Skill
          path="/triage"
          description="Use for finding, filtering, and summarizing Linear issues: what's open, priorities, what changed, who owns what."
        >
          Triage
        </Skill>
        <Skill
          path="/create-issue"
          description="Use when the user wants to file a new Linear issue or update/close an existing one."
        >
          Create issues
        </Skill>
        <Skill
          path="/standup"
          description="Use for a daily status rundown: what the user finished, what's in progress, what's blocked."
        >
          Standup
        </Skill>
      </Skills>

      <GlobalTools>
        {/* Declare + connect the MCP server inline — no defineAgent config.
            Credentials are implicit: MCP_LINEAR_TOKEN in .env if set, else log
            in once via the preview's MCP menu (OAuth). This agent's whole job
            is Linear, so its tools are global here. */}
        <Mcp id="linear" url="https://mcp.linear.app/mcp" />
      </GlobalTools>
    </Agent>
  );
}

export const agent = defineAgent({
  app: OpsApp,
  // No mcpServers here — the <Mcp id url /> in GlobalTools declares and
  // connects Linear inline. (mcpServers still works for eager, pre-render
  // connection when you want it.)
  preview: {
    suggestedPrompts: [
      "What are my open Linear issues?",
      "Create a Linear issue for the flaky voice test",
    ],
    chatPlaceholder: "Ask about the team's Linear workspace...",
  },
});
