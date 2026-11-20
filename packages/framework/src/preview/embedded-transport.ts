import type { ClientMessage, ServerMessage } from "../server/protocol.js";
import type { PreviewTransport } from "./ws-client.js";

/**
 * Opt-in transport for the published preview mounted in a same-origin iframe.
 * The host owns the session and the input UI. The iframe only renders frames
 * and sends back preview controls, using the same protocol as the dev socket.
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
        if (message && typeof message.type === "string") receive(message);
      };
      page.addEventListener("message", onMessage);
      parent.postMessage({ type: "curb_preview_ready" }, origin);
      return () => page.removeEventListener("message", onMessage);
    },
    send(frame: ClientMessage) {
      parent.postMessage({ type: "curb_preview_action", frame }, origin);
    },
  };
}
