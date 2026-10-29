import type { ReactNode } from "react";
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { LlmCallRecord, LlmMessage } from "../llm/types.js";
import { ValueTree } from "./value-tree.js";

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const ROLE_LABEL: Record<LlmMessage["role"], string> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool result",
};

/**
 * The exact input of the model call that wrote a reply: the instructions, every message as
 * the model got it (the conversation, tool results, and the current context block the
 * framework appends last) and the tools it could call. Downloadable as JSON, every call of
 * the conversation at once.
 */
export function ModelInputDialog({
  call,
  open,
  onOpenChange,
  trace,
}: {
  /** Null when the conversation has no recorded call for this reply (restored from the store). */
  call: LlmCallRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trace: readonly LlmCallRecord[];
}) {
  const tools = call ? Object.entries(call.input.tools) : [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>What the model read</DialogTitle>
          <DialogDescription>
            {call
              ? `The exact input of the model call that wrote this reply: call ${call.index + 1} of ${trace.length} in this conversation, at ${new Date(call.at).toLocaleTimeString()}.`
              : "This conversation has no recorded model call for this reply. Calls are recorded while the preview is open, so a reopened conversation has none until its next reply."}
          </DialogDescription>
        </DialogHeader>
        {call ? (
          <>
            {call.error ? (
              <p className="m-0 text-[0.8125rem] text-destructive">This call failed: {call.error}</p>
            ) : null}
            <Section title="Instructions">
              <Text text={call.input.system || "None"} />
            </Section>
            <Section title={`Messages (${call.input.messages.length})`}>
              <div className="flex flex-col gap-2.5">
                {call.input.messages.map((message, index) => (
                  <MessageBlock key={index} message={message} />
                ))}
              </div>
            </Section>
            <Section title={`Tools (${tools.length})`}>
              <div className="flex flex-col gap-2">
                {tools.map(([name, tool]) => (
                  <details key={name} className="group rounded-xl border border-border/70 px-3 py-2">
                    <summary className="flex items-baseline gap-2 text-[0.8125rem]">
                      <span className="font-medium">{name}</span>
                      <span className="min-w-0 truncate text-muted-foreground">{tool.description}</span>
                    </summary>
                    <div className="mt-2 flex flex-col gap-2">
                      <Text text={tool.description} />
                      <ValueTree value={tool.inputSchema.properties} />
                    </div>
                  </details>
                ))}
              </div>
            </Section>
          </>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={trace.length === 0}
            onClick={() => downloadJson(`model-calls-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, { calls: trace })}
          >
            <DownloadIcon aria-hidden="true" />
            Download all calls
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-[0.8125rem] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Text({ text }: { text: string }) {
  return <p className="m-0 text-[0.8125rem] leading-relaxed break-words whitespace-pre-wrap">{text}</p>;
}

function MessageBlock({ message }: { message: LlmMessage }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-accent px-3 py-2.5">
      <span className="text-xs font-medium text-muted-foreground">{ROLE_LABEL[message.role]}</span>
      {typeof message.content === "string" ? (
        <Text text={message.content} />
      ) : (
        message.content.map((part, index) =>
          part.type === "text" ? (
            <Text key={index} text={part.text} />
          ) : part.type === "tool-call" ? (
            <div key={index} className="flex flex-col gap-1">
              <span className="text-[0.8125rem]">
                Calls <span className="font-medium">{part.toolName}</span>
              </span>
              <ValueTree value={part.input} />
            </div>
          ) : (
            <div key={index} className="flex flex-col gap-1">
              <span className="text-[0.8125rem]">
                From <span className="font-medium">{part.toolName}</span>
              </span>
              <ValueTree value={part.output.value} />
            </div>
          ),
        )
      )}
    </div>
  );
}
