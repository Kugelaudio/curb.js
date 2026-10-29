import { Streamdown } from "streamdown";

/**
 * Authored prose (the system prompt, an instruction, a text) rendered as the
 * markdown it is: paragraphs, headings and lists, and a line break wherever the
 * author put one, because the model reads that break too (`.prose-view p` keeps
 * it). Static mode: this text is complete, so nothing may "repair" it as if it
 * were a stream that stopped halfway.
 */
export function Prose({ text, className }: { text: string; className?: string }) {
  return (
    <div className={["prose-view", "markdown-message", className].filter(Boolean).join(" ")}>
      <Streamdown mode="static">{text}</Streamdown>
    </div>
  );
}
