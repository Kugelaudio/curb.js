import { createContext, createElement, useContext, type ReactNode } from "react";
import type { ProviderSettings } from "./session-settings.js";

/**
 * `useSession()`: what the agent's own code can read about the live session.
 *
 *   const { settings } = useSession();
 *   <Text>You are speaking with voice {String(settings.tts.options.voice ?? "default")}.</Text>
 *
 * `settings` is the EFFECTIVE providers: the `<Agent>` / active `<Skill>` props with any
 * outside change on top (a client's `agent.update`, the host's `PATCH /v1/sessions/{id}`).
 * Read-only: the agent changes its own providers by rendering other props.
 *
 * The runtime provides a fresh value on every render and renders again when the settings
 * changed, so a component never sees a stale value in the context it compiles into.
 */
export interface SessionView {
  readonly settings: Readonly<ProviderSettings>;
  /**
   * The call this conversation is. Set on every route: a managed runner, a direct join, a
   * LiveKit worker (`curb start` or a built artifact), and `curb dev`, whose preview
   * conversations have one whether typed or spoken. Absent only in a runtime nothing hosts
   * (tests). Read the call's identity HERE, never from `process.env`: a runner that serves
   * several calls has one environment for all of them.
   */
  readonly call?: CallView;
}

/** One call, as its own agent sees it. */
export interface CallView {
  /**
   * The host's id for this call: the start request's `sessionId` on a managed runner; on a
   * direct join `CURB_SESSION_ID`, else the room name; on a LiveKit worker the room name; in
   * `curb dev` the preview conversation's id (`preview-…`), kept across a rewind.
   */
  readonly sessionId: string;
  /**
   * This call's own writable directory, removed when the call ends. No other call on the
   * runner is given it. Absent in `curb dev`, and when it could not be created (the runner
   * logs why).
   */
  readonly scratchDir?: string;
}

const SessionContext = createContext<SessionView | null>(null);

/** Mounted by `AgentSiteRuntime` around every site; authors never render this. */
export function SessionProvider({ value, children }: { value: SessionView; children?: ReactNode }) {
  return createElement(SessionContext.Provider, { value }, children);
}

/** The live session, read-only. */
export function useSession(): SessionView {
  const session = useContext(SessionContext);
  if (session === null) throw new Error("useSession must be used inside an agent runtime render.");
  return session;
}
