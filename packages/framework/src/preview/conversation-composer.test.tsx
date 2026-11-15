import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Composer, startCallClick, type ComposerCall } from "./conversation-composer.js";

const call: ComposerCall = {
  live: false,
  connecting: false,
  speaking: false,
  thinking: false,
  micMuted: false,
  microphones: [],
  selectedMicrophoneId: null,
  switchingMicrophone: false,
  onStart: () => undefined,
  onStop: () => undefined,
  onToggleMute: () => undefined,
  onMicrophoneChange: () => undefined,
  onMicrophoneMenuOpen: () => undefined,
};

function composer(blocked: boolean) {
  return renderToStaticMarkup(
    <Composer
      value=""
      onChange={() => undefined}
      onSubmit={() => undefined}
      placeholder="Ask about a claim…"
      running={false}
      notices={[]}
      call={call}
      blocked={blocked}
      onShowProblems={() => undefined}
    />,
  );
}

/** The opening tag of the button that carries this label. */
function buttonTag(html: string, label: string): string {
  const end = html.indexOf(label);
  return html.slice(html.lastIndexOf("<button", end), html.indexOf(">", html.lastIndexOf("<button", end)) + 1);
}

describe("the composer while the agent cannot answer", () => {
  it("keeps Start call pressable, and a press shows the problems instead of starting a call", () => {
    expect(buttonTag(composer(true), "Start call")).not.toMatch(/\sdisabled(=|\s|>)/);

    const onStart = vi.fn();
    const onShowProblems = vi.fn();
    startCallClick(true, onStart, onShowProblems)();
    expect(onShowProblems).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("takes no message, and says what is missing where the message would go", () => {
    const html = composer(true);
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toContain("Add the missing key to start talking");
  });

  it("starts a call as before once the agent can answer", () => {
    const onStart = vi.fn();
    const onShowProblems = vi.fn();
    startCallClick(false, onStart, onShowProblems)();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onShowProblems).not.toHaveBeenCalled();
    expect(composer(false)).toContain("Ask about a claim…");
  });
});
