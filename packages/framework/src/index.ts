export {
  ErrorMessage,
  Field,
  GlobalTools,
  Instruction,
  Mcp,
  Agent,
  Skill,
  Skills,
  SystemPrompt,
  Text,
  Tool,
  defineTool,
} from "./components.js";
export type { McpProps } from "./components.js";
export { Procedure, Step } from "./blocks/procedure/index.js";
export type { ProcedureProps, StepProps } from "./blocks/procedure/index.js";
export {
  McpManager,
  configureMcp,
  getMcpManager,
  preloadMcpTools,
  resolveMcpServer,
  setMcpOAuthCallbackUrl,
} from "./mcp/index.js";
export type {
  McpAuth,
  McpServerConfig,
  McpServerState,
  McpServerSummary,
  McpToolInfo,
} from "./mcp/index.js";
export { compileSite, flattenContext } from "./compiler.js";
export {
  AUTHORING_DIAGNOSTIC_CODES,
  AgentAuthoringError,
  formatAuthoringDiagnostic,
  mergeAuthoringDiagnostics,
} from "./authoring.js";
export type {
  AuthoringDiagnostic,
  AuthoringDiagnosticCode,
  AuthoringDiagnosticSeverity,
  AuthoringLocation,
} from "./authoring.js";
export { diagnoseAgentAuthoring } from "./authoring-diagnostics.js";
export { defineAgent } from "./config.js";
export type {
  AgentAppProps,
  AgentConfig,
  AgentDefinition,
  AgentFirstTurn,
  AgentPreviewHints,
} from "./config.js";
export type { AgentGoal, AgentGoals, AgentJudgeGoal, AgentToolGoal } from "./goals.js";
export type { AgentExperiment, AgentExperiments } from "./experiments.js";
export type { CallEvent, CallHook, CallRecord } from "./hooks.js";
export { AgentInfoStore } from "./info-store.js";
export type { AgentInfo } from "./info-store.js";
export type { ProviderSettings, ProviderSlot } from "./session-settings.js";
export { useSession } from "./session-context.js";
export type { CallView, SessionView } from "./session-context.js";
export { SettingsRefusedError } from "./settings-update.js";
export type {
  Adjustable,
  AdjustablePath,
  EffectiveSettings,
  SessionUpdate,
  SettingsOrigin,
  SettingsRefusalCode,
} from "./settings-update.js";
export { useAgentInfo, useClient, useVariant } from "./info-context.js";
export type { ClientInfo } from "./info-context.js";
export { createAgentStore } from "./agent-state.js";
export {
  HostTimeoutError,
  HostUnavailableError,
  MessageRefusedError,
  useMessage,
  useSend,
} from "./messages.js";
export type {
  MessageIssue,
  MessageMeta,
  MessageOrigin,
  MessageRefusalCode,
  MessageSender,
  UseMessageWithSchema,
  UseMessageWithoutSchema,
} from "./messages.js";
export { TransferCallTool, useTransferCall } from "./transfer.js";
export type { TransferCall, TransferCallRequest, TransferCallToolProps, TransferOutcome } from "./transfer.js";
export type { TransferEnded, TransferEndedDecision, TransferEndedOption } from "./transfer-ended.js";
export type { GetState, SetState, StoreInitializer, UseAgentStore } from "./agent-state.js";
export { listPublicMarkdown, preloadPublicMarkdown, resolvePublicMarkdown } from "./public-context.js";
export { AgentSiteRuntime } from "./runtime.js";
export { AgentSession } from "./agent-session.js";
export type {
  AgentLlmClient,
  AgentLlmStreamStep,
  AgentSessionOptions,
} from "./agent-session.js";
export { createSemanticRoot } from "./reconciler.js";
export { createSkillRoutes, skillPathFromModuleId, titleFromSkillPath } from "./routing.js";
// Renders nothing; kept so a project from before <Agent> rendered the skills still loads.
export { AgentRouter } from "./agent-router-migration.js";
export { RouteProvider, useRoutePath, useRouter } from "./route-context.js";
export type { AgentRouterApi } from "./route-context.js";
export type { AgentRoute, SkillMeta } from "./routing.js";
export { z } from "zod";
export { zodSchemaToFields, validateSchemaInput } from "./form-schema.js";
export { ToolInputError, isToolInputError } from "./types.js";
export type { ZodObjectSchema } from "./form-schema.js";
export type { AgentChatMessage, AgentRunRequest, AgentRunResponse, AgentToolCall } from "./llm/types.js";
// TYPE ONLY, and it has to stay that way: the implementation module is Node-only
// (node:fs), and a value export from here would pull it into the browser
// bundle. A host implements this interface and names its module in
// KUGEL_CONVERSATION_SINK; the framework imports that module, so nothing else of
// the sink machinery needs to be public.
export type { ConversationSink } from "./server/conversation-store.js";
export type {
  AgentProps,
  CompiledContext,
  ContextEvent,
  ContextLink,
  ContextDocProps,
  FieldDefinition,
  FieldProps,
  HostContainer,
  PageBlock,
  JsonSchema,
  JsonSchemaProperty,
  RuntimeSnapshot,
  SemanticNode,
  SkillProps,
  SkillsProps,
  ToolActionProps,
  ToolDefinition,
  ToolFeedbackProps,
  ToolHandler,
  ToolProps,
  ToolSpec,
  ToolPropsWithFields,
  ToolPropsWithSchema,
  ToolResult,
} from "./types.js";
