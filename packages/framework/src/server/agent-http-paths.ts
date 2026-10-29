/**
 * The HTTP paths the agent server answers. `curb dev` serves the preview's port itself and
 * forwards these, and every WebSocket upgrade but Vite's HMR, to the agent server it runs
 * in a child process; everything else on that port is the preview app (Vite). Kept
 * dependency-free so the supervisor can import it without the server's module graph.
 */
export const AGENT_HTTP_PATHS = {
  /** The MCP OAuth redirect target. */
  oauthCallback: "/oauth/callback",
  /** The dashboard's MCP Sign in (`?server=<id>`): recorded as in progress, then on to the provider. */
  oauthSignIn: "/oauth/sign-in",
  /** POST { text }: one-shot text to WAV for the preview's Play buttons. */
  tts: "/tts",
  /** The audio of one message of a live or recent call. */
  voiceClip: "/voice/clip",
  /** The WebSocket a local call's page attaches on (`?call=<id>&token=<token>`). */
  localVoice: "/voice/local",
  /** TEMPORARY: the preview's reply-playback phases, logged on the voice timeline. */
  voicePhase: "/__voice-phase",
} as const;

const PATHS: ReadonlySet<string> = new Set(Object.values(AGENT_HTTP_PATHS));

export function isAgentHttpPath(pathname: string): boolean {
  return PATHS.has(pathname);
}
