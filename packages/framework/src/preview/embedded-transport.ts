import type { ClientMessage, ServerMessage } from "../server/protocol.js";
import type { PreviewTransport } from "./ws-client.js";

// Keep the embed's protocol narrower than the dev socket. Tickets, MCP sign-in
// links, connection reloads and session metadata belong to the host.
const SERVER_FRAMES: ReadonlySet<string> = new Set([
  "agents", "context", "messages", "assistant_delta", "llm_trace", "inspect_context",
  "conversations", "running", "notice", "agent_unavailable", "missing_keys", "error",
] satisfies ServerMessage["type"][]);

const CLIENT_ACTIONS: ReadonlySet<string> = new Set([
  "read_skill", "inspect_skill", "call_tool", "inspect_undo",
  "select_agent", "rewind", "reset", "select_conversation",
] satisfies ClientMessage["type"][]);

/**
 * Opt-in transport for the published preview mounted in a same-origin iframe.
 * The host owns the session and the input UI.
 */
export function embeddedPreviewTransport(page: Window = window): PreviewTransport | undefined {
  if (page.parent === page || page.document.documentElement.dataset.curbTransport !== "parent") return;
  const origin = page.location.origin;
  const parent = page.parent;
  return {
    connect(receive) {
      const onMessage = (event: MessageEvent) => {
        if (event.source !== parent || event.origin !== origin || event.data?.type !== "curb_preview_frame") return;
        const message: ServerMessage = event.data.frame;
        if (!message || !SERVER_FRAMES.has(message.type)) return;
        if (message.type === "error" && (message.scope === "voice" || message.scope === "mcp")) return;
        receive(message);
      };
      page.addEventListener("message", onMessage);
      parent.postMessage({ type: "curb_preview_ready" }, origin);
      return () => page.removeEventListener("message", onMessage);
    },
    send(frame: ClientMessage) {
      if (CLIENT_ACTIONS.has(frame.type)) parent.postMessage({ type: "curb_preview_action", frame }, origin);
    },
  };
}
