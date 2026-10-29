/**
 * The two things the browser dev page shows of its own, outside the preview: whether Claude
 * is connected to this tab (`relay.ts`), and the prompt for a secret Claude asked for
 * (`request_secret`), whose value goes into the project's `.env` in this browser and nowhere
 * else. Plain DOM, styled inline: the preview app's styles are not loaded for these.
 */

import type { RelayState } from "./relay.js";

const FONT = "13px/1.4 system-ui, -apple-system, sans-serif";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, style: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const LABELS: Record<RelayState["kind"], string> = {
  connecting: "Connecting to Claude…",
  connected: "Claude is connected",
  refused: "This link expired: ask Claude for a new one",
  replaced: "Claude now works in another tab",
  retrying: "Reconnecting to Claude…",
};

/** What a session page (`session.ts`) says when it cannot get a link. */
const SESSION_LABELS = {
  signInFailed: "Signing in did not open this project: reload the page to try again",
  noLink: "Open this page from the link Claude gave you",
};

const CONNECTED = "#7ee2a8";

let frame: HTMLElement | null = null;
let badge: HTMLElement | null = null;

/**
 * The relay's state, or a session page's reason for having none, in a badge at the top centre.
 * While Claude is connected a soft border runs around the whole page as well, so this window
 * reads as the one Claude works in at a glance. Neither takes a click from the page under it.
 */
export function showRelayState(state: RelayState, session?: keyof typeof SESSION_LABELS): void {
  frame ??= document.body.appendChild(
    element(
      "div",
      `position:fixed;inset:0;z-index:2147483645;pointer-events:none;border-radius:14px;` +
        `box-shadow:inset 0 0 0 3px ${CONNECTED},inset 0 0 28px rgba(126,226,168,.45);opacity:0;transition:opacity .4s ease`,
    ),
  );
  frame.setAttribute("aria-hidden", "true");
  badge ??= document.body.appendChild(
    element(
      "div",
      `position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483646;max-width:calc(100% - 24px);` +
        `padding:6px 14px;border-radius:999px;font:${FONT};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` +
        "background:rgba(20,20,20,.88);color:#fff;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.18)",
    ),
  );
  badge.setAttribute("role", "status");
  const ok = state.kind === "connected" && session === undefined;
  frame.style.opacity = ok ? "1" : "0";
  badge.textContent = `${ok ? "●" : "○"} ${session ? SESSION_LABELS[session] : LABELS[state.kind]}`;
  badge.style.color = ok ? CONNECTED : state.kind === "refused" || state.kind === "replaced" ? "#ffb4a8" : "#fff";
}

/**
 * Ask the person for the value of `name`. Resolves with it, or null when they dismissed the
 * prompt. One prompt at a time; a second request for another name waits its turn.
 */
let prompting: Promise<unknown> = Promise.resolve();

export function askForSecret(name: string): Promise<string | null> {
  const asked = prompting.then(() => openPrompt(name));
  prompting = asked;
  return asked;
}

function openPrompt(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = element(
      "dialog",
      `font:${FONT};padding:20px;border:0;border-radius:12px;max-width:420px;width:calc(100% - 48px);box-shadow:0 12px 40px rgba(0,0,0,.25)`,
    );
    const form = element("form", "display:grid;gap:12px;margin:0");
    form.method = "dialog";
    const title = element("strong", "font-size:15px", `Claude asks for ${name}`);
    const note = element(
      "p",
      "margin:0;color:#555",
      "The value is saved in this browser's .env for this project and reaches only the agent running here. Claude never sees it.",
    );
    const input = element("input", "font:inherit;padding:8px 10px;border:1px solid #bbb;border-radius:8px");
    input.type = "password";
    input.autocomplete = "off";
    input.required = true;
    input.setAttribute("aria-label", name);
    const row = element("div", "display:flex;gap:8px;justify-content:flex-end");
    const cancel = element("button", "font:inherit;padding:6px 12px;border-radius:8px;border:1px solid #bbb;background:#fff", "Not now");
    cancel.type = "button";
    const save = element("button", "font:inherit;padding:6px 12px;border-radius:8px;border:0;background:#111;color:#fff", "Save");
    save.type = "submit";
    row.append(cancel, save);
    form.append(title, note, input, row);
    dialog.append(form);
    document.body.append(dialog);
    const finish = (value: string | null) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.onclick = () => finish(null);
    dialog.addEventListener("cancel", () => finish(null));
    form.onsubmit = (event) => {
      event.preventDefault();
      finish(input.value);
    };
    dialog.showModal();
    input.focus();
  });
}
