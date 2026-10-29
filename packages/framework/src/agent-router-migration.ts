import { parse } from "@babel/parser";
import { AUTHORING_DIAGNOSTIC_CODES, type AuthoringDiagnostic } from "./authoring.js";
import type { AgentRoute } from "./routing.js";

/**
 * What a project from before `<Agent>` rendered the skills still writes, and what to delete.
 *
 * The app component used to take `path`, `loadedPaths` and `routes` from its host and hand them
 * to `<AgentRouter>`, which rendered the skills the conversation had opened. `<Agent>` renders
 * them now (`WithOpenedSkills` in `routing.tsx`), so an app takes no props. `<AgentRouter>` stays
 * exported only so that such a project still loads: it renders nothing, so no skill is rendered
 * twice, and every place that renders it gets one warning saying what to delete.
 */

/** What `<AgentRouter>` was passed. Accepted and ignored, so an old app still type-checks. */
export type AgentRouterProps = {
  path: string;
  loadedPaths?: readonly string[];
  routes: readonly AgentRoute[];
};

/**
 * @deprecated `<Agent>` renders the skills the conversation opens, and this renders nothing.
 * Delete it, and the `path`, `loadedPaths` and `routes` props of the app component
 * (`curb check` warns `AGENT_ROUTER_REMOVED` where it is left).
 */
export function AgentRouter(_props: AgentRouterProps): null {
  return null;
}

/** One warning per `<AgentRouter>` these sources render: `agent.tsx` and every skill module,
 * each with its file from the project root. A source without a file is not scanned. */
export function diagnoseAgentRouterLeftovers(
  agentId: string,
  sources: ReadonlyArray<{ file?: string; source?: string }>,
): AuthoringDiagnostic[] {
  return sources.flatMap(({ file, source }) =>
    file && source
      ? routersIn(source).map(
          (at): AuthoringDiagnostic => ({
            code: AUTHORING_DIAGNOSTIC_CODES.agentRouterRemoved,
            severity: "warning",
            message: "<AgentRouter> renders nothing any more: <Agent> renders every skill the conversation opens.",
            location: { agentId, source: file, ...at, component: "AgentRouter" },
            fix:
              "Delete this <AgentRouter ... /> and its import, and the path, loadedPaths and routes props " +
              "of the app component: export function App() { ... }.",
          }),
        )
      : [],
  );
}

// --- reading the source -------------------------------------------------------------------

type AstNode = {
  type: string;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
};

type Position = { line: number; column: number };

const ROUTER = "AgentRouter";
const SKIPPED_KEYS = new Set(["loc", "extra", "leadingComments", "trailingComments", "innerComments"]);

/** Where `source` writes `<AgentRouter>` (or `<curb.AgentRouter>`), 1-based. */
function routersIn(source: string): Position[] {
  let ast: unknown;
  try {
    ast = parse(source, { sourceType: "module", plugins: ["jsx", "typescript"] });
  } catch {
    // KEEP-JUSTIFIED: a source that does not parse is reported by the authoring analysis
    // (AGENT_AUTHORING_RENDER_FAILED) and the type check; this scan only adds a warning.
    return [];
  }
  const found: Position[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object" || typeof (node as AstNode).type !== "string") return;
    const current = node as AstNode;
    if (current.type === "JSXElement" && isRouter((current.openingElement as AstNode).name as AstNode)) {
      const start = current.loc?.start;
      found.push({ line: start?.line ?? 1, column: (start?.column ?? 0) + 1 });
    }
    for (const [key, value] of Object.entries(current)) {
      if (!SKIPPED_KEYS.has(key) && value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  return found;
}

function isRouter(name: AstNode): boolean {
  if (name.type === "JSXIdentifier") return name.name === ROUTER;
  return name.type === "JSXMemberExpression" && (name.property as AstNode).name === ROUTER;
}
