import {
  GlobalTools,
  Instruction,
  Agent,
  Skill,
  Skills,
  SystemPrompt,
  Text,
  Tool,
} from "../index.js";

/**
 * Minimal generic agent for framework tests: an agent level with its own
 * instruction and text, two skills, one global tool, page-scoped tools, and a
 * deliberate tool-name collision (`shared_tool` on both /alpha and /beta).
 * Tests should use this instead of the insurance demo so framework behavior is
 * exercised without demo coupling.
 */
export function FixtureApp({
  path,
  loadedPaths,
}: {
  path: string;
  loadedPaths?: readonly string[];
}) {
  const paths = loadedPaths ?? (path ? [path] : []);

  return (
    <Agent>
      <SystemPrompt>Fixture system prompt.</SystemPrompt>
      <Instruction>Route the user to alpha or beta.</Instruction>
      <Text>Welcome to the fixture agent.</Text>

      <Skills>
        <Skill path="/alpha" description="First fixture skill.">
          Alpha
        </Skill>
        <Skill path="/beta" description="Second fixture skill.">
          Beta
        </Skill>
      </Skills>

      <GlobalTools>
        <Tool
          name="ping"
          description="Global fixture tool."
          onCall={async () => ({ ok: true, data: { pong: true } })}
        />
      </GlobalTools>

      {paths.includes("/alpha") ? (
        <agent-page path="/alpha" title="Alpha">
          <Instruction>Handle alpha requests.</Instruction>
          <Skill path="/beta" description="Go on to beta.">
            Beta (from alpha)
          </Skill>
          <Tool
            name="alpha_note"
            description="Alpha-only tool."
            onCall={async () => ({ ok: true, data: { from: "alpha_note" } })}
          />
          <Tool
            name="shared_tool"
            description="Defined by alpha."
            onCall={async () => ({ ok: true, data: { from: "alpha" } })}
          />
        </agent-page>
      ) : null}

      {paths.includes("/beta") ? (
        <agent-page path="/beta" title="Beta">
          <Instruction>Handle beta requests.</Instruction>
          <Tool
            name="shared_tool"
            description="Defined by beta."
            onCall={async () => ({ ok: true, data: { from: "beta" } })}
          />
        </agent-page>
      ) : null}
    </Agent>
  );
}
