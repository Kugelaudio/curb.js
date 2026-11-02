/** Stable machine-readable identifiers for agent-context authoring problems. */
export const AUTHORING_DIAGNOSTIC_CODES = {
  invalidRoute: "AGENT_INVALID_ROUTE",
  unreachableSkill: "AGENT_UNREACHABLE_SKILL",
  duplicateTool: "AGENT_DUPLICATE_TOOL_NAME",
  missingDescription: "AGENT_MISSING_SKILL_DESCRIPTION",
  possiblyLockedBranch: "AGENT_POSSIBLY_LOCKED_BRANCH",
  oversizedContext: "AGENT_CONTEXT_TOO_LARGE",
  renderFailed: "AGENT_AUTHORING_RENDER_FAILED",
  invalidProp: "AGENT_INVALID_AUTHORING_PROP",
  scaffoldPlaceholder: "AGENT_SCAFFOLD_PLACEHOLDER",
  voiceLanguageMismatch: "AGENT_VOICE_LANGUAGE_MISMATCH",
  s2sSpeechProviderIgnored: "AGENT_S2S_SPEECH_PROVIDER_IGNORED",
  typeError: "AGENT_TYPE_ERROR",
  typeCheckUnavailable: "AGENT_TYPECHECK_UNAVAILABLE",
  nodeTypesMissing: "AGENT_NODE_TYPES_MISSING",
  envNotDeclared: "AGENT_ENV_NOT_DECLARED",
  proseJsxText: "AGENT_PROSE_JSX_TEXT",
  literalDate: "AGENT_LITERAL_DATE",
  orchestrationIgnored: "AGENT_ORCHESTRATION_IGNORED",
  homeSkillRemoved: "AGENT_HOME_SKILL_REMOVED",
  agentRouterRemoved: "AGENT_ROUTER_REMOVED",
  goalToolNotDeclared: "AGENT_GOAL_TOOL_NOT_DECLARED",
  conversationStoreSqlite: "AGENT_CONVERSATION_STORE_SQLITE",
  hookNotAFunction: "AGENT_HOOK_NOT_A_FUNCTION",
  hookNotDeclared: "AGENT_HOOK_NOT_DECLARED",
} as const;

export type AuthoringDiagnosticCode =
  (typeof AUTHORING_DIAGNOSTIC_CODES)[keyof typeof AUTHORING_DIAGNOSTIC_CODES];

export type AuthoringDiagnosticSeverity = "error" | "warning";

export type AuthoringLocation = {
  /** Agent folder id, when the diagnostic belongs to a discovered agent. */
  agentId?: string;
  /** Skill route (`/claims`, `/claims/new`, …), when the problem is route-scoped. */
  skillPath?: string;
  /** Source file or module id when discovery can provide it. */
  source?: string;
  /** 1-based line in `source`, when the problem has one. */
  line?: number;
  /** 1-based column on `line`. */
  column?: number;
  /** JSX component or authored symbol involved in the problem. */
  component?: string;
};

/**
 * Public authoring diagnostic contract. The fields are deliberately redundant:
 * a human can scan `message`, while a coding agent can branch on `code`, locate
 * the source with `location`, and apply the concrete `fix` without guessing.
 */
export type AuthoringDiagnostic = {
  code: AuthoringDiagnosticCode;
  severity: AuthoringDiagnosticSeverity;
  message: string;
  location: AuthoringLocation;
  fix: string;
};

export function authoringDiagnosticKey(diagnostic: AuthoringDiagnostic): string {
  const { location } = diagnostic;
  return [
    diagnostic.code,
    location.agentId ?? "",
    location.skillPath ?? "",
    location.source ?? "",
    // Padded so diagnostics in one file sort by line number, not by its digits.
    String(location.line ?? "").padStart(7, "0"),
    String(location.column ?? "").padStart(5, "0"),
    location.component ?? "",
    diagnostic.message,
  ].join("::");
}

/** Merge diagnostics without making callers implement unstable message matching. */
export function mergeAuthoringDiagnostics(
  ...groups: ReadonlyArray<readonly AuthoringDiagnostic[]>
): AuthoringDiagnostic[] {
  const merged = new Map<string, AuthoringDiagnostic>();
  for (const diagnostic of groups.flat()) {
    merged.set(authoringDiagnosticKey(diagnostic), diagnostic);
  }
  return [...merged.values()].sort(compareDiagnostics);
}

function compareDiagnostics(left: AuthoringDiagnostic, right: AuthoringDiagnostic): number {
  if (left.severity !== right.severity) return left.severity === "error" ? -1 : 1;
  return authoringDiagnosticKey(left).localeCompare(authoringDiagnosticKey(right));
}

/** Prefer a directly navigable source path; authored symbols are fallbacks for
 * hosts that cannot resolve a diagnostic to a file. */
export function formatAuthoringLocation(location: AuthoringLocation): string {
  if (location.source) {
    if (location.line === undefined) return location.source;
    const column = location.column === undefined ? "" : `:${location.column}`;
    return `${location.source}:${location.line}${column}`;
  }
  return [
    location.skillPath ? `skill ${JSON.stringify(location.skillPath)}` : null,
    location.component ? `component ${location.component}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Agent-readable rendering used in thrown errors and host logs. */
export function formatAuthoringDiagnostic(diagnostic: AuthoringDiagnostic): string {
  const location = formatAuthoringLocation(diagnostic.location);
  return [
    `[${diagnostic.code}] ${diagnostic.severity.toUpperCase()}: ${diagnostic.message}`,
    location ? `Location: ${location}` : null,
    `Fix: ${diagnostic.fix}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Typed failure for authoring mistakes that make compilation impossible. */
export class AgentAuthoringError extends Error {
  readonly diagnostic: AuthoringDiagnostic;

  constructor(diagnostic: AuthoringDiagnostic) {
    super(formatAuthoringDiagnostic(diagnostic));
    this.name = "AgentAuthoringError";
    this.diagnostic = diagnostic;
  }
}
