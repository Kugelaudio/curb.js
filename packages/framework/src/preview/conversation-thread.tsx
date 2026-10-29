import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { LucideIcon } from "lucide-react";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button.js";
import { replyInk, REPLY_IDLE, type ReplyPlayback } from "../llm/spoken-split.js";
import type { AgentAssistantMessage, AgentChatMessage } from "../llm/types.js";
import { AgentSphere } from "./agent-sphere.js";
import { callerMessageCount } from "./agent-view.js";
import type { ConversationReplayState } from "./conversation-player.js";
import { ToolCallRow } from "./conversation-tool-call.js";
import {
  conversationTurns,
  newestReplyIndex,
  nextCallerMessage,
  turnReply,
  type AgentTurnItem,
  type ConversationTurn,
} from "./conversation-turns.js";
import { CallerActions, ReplyActions } from "./message-actions.js";
import { useLiveCallerText, type CallerSpeech } from "./voice/caller-transcript.js";
import { replayTimeForMessage } from "./voice/conversation-recording.js";

/**
 * The conversation. The agent writes on the page beside its sphere; the caller writes in a
 * filled bubble on the right, the pattern every chat app uses, so nobody has to learn which
 * side is whom. What the agent did sits inside its turn, in order.
 */
export function ConversationThread({
  messages,
  streamingText,
  running,
  callLive,
  playback,
  callerSpeech,
  replay,
  agentName,
  suggestedPrompts,
  onPrompt,
  skillLabel,
  toolIcon,
  onOpenSkill,
  onShowModelInput,
  onRetry,
  onGoBack,
}: {
  messages: readonly AgentChatMessage[];
  /** The reply being written right now; null when none is. */
  streamingText: string | null;
  running: boolean;
  callLive: boolean;
  /** Where the spoken reply is. Only the newest reply can still be speaking. */
  playback: ReplyPlayback;
  /** What the caller is saying right now, in a call, by recognised segment. */
  callerSpeech: CallerSpeech;
  /** A call replay in progress shows the transcript up to its position. */
  replay: ConversationReplayState;
  agentName: string;
  suggestedPrompts: readonly string[];
  onPrompt: (text: string) => void;
  skillLabel: (path: string) => string;
  toolIcon: (name: string) => LucideIcon | undefined;
  onOpenSkill: (path: string) => void;
  onShowModelInput: (message: AgentAssistantMessage) => void;
  /** Answer the caller's message at `index` again; absent while a turn runs. */
  onRetry?: (index: number) => void;
  /** Go back to the reply before the caller's message at `index`, and put `text` back in the field. */
  onGoBack?: (index: number, text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const callerCount = callerMessageCount(messages);
  // What the caller is saying and the transcript has not committed yet. It leaves in the
  // same render its committed message arrives in, so the words never blink out between.
  const transcribing = useLiveCallerText(callerSpeech, callerCount);
  const onScroll = useStickToBottom(scrollRef, contentRef, callerCount);
  const shown = (message: AgentChatMessage) =>
    !replay.active || replayTimeForMessage(message, replay.windows) <= replay.timeMs + 120;
  const turns = visibleTurns(conversationTurns(messages), messages, shown);
  const newestReply = newestReplyIndex(messages);
  const newestAssistant = messages.findLastIndex((message) => message.role === "assistant");
  const streaming = Boolean(streamingText?.trim());
  const lastTurn = turns.at(-1);
  const empty = turns.length === 0 && !streaming && !transcribing;

  const liveTail =
    streaming || (running && !transcribing) ? (
      <TurnInProgress text={streaming ? streamingText! : null} muted={callLive} />
    ) : null;

  return (
    <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-[200px]">
      <div ref={contentRef}>
        {empty ? (
          <EmptyConversation agentName={agentName} prompts={suggestedPrompts} onPrompt={onPrompt} />
        ) : (
          <div className="mx-auto flex max-w-[720px] flex-col gap-3.5">
            {turns.map((turn) =>
              turn.kind === "caller" ? (
                <div key={`caller-${turn.index}`} className={CALLER_ROW}>
                  <div className={CALLER_BUBBLE}>{turn.message.content}</div>
                  <CallerActions
                    text={turn.message.content}
                    audio={turn.message.audio}
                    onRetry={onRetry ? () => onRetry(turn.index) : undefined}
                  />
                </div>
              ) : (
                <AgentTurn key={`agent-${turn.index}`}>
                  {turn.items.map((item) =>
                    item.kind === "tool" ? (
                      <ToolCallRow
                        key={item.tool.call.id}
                        tool={item.tool}
                        running={running}
                        skillLabel={skillLabel}
                        toolIcon={toolIcon}
                        onOpenSkill={onOpenSkill}
                      />
                    ) : (
                      <ReplyText
                        key={`text-${item.index}`}
                        message={item.message}
                        playback={item.index === newestAssistant && callLive ? playback : REPLY_IDLE}
                      />
                    ),
                  )}
                  {turn === lastTurn ? liveTail : null}
                  {replyActions(turn.items)}
                </AgentTurn>
              ),
            )}
            {/* Keyed as the turn its first message will open, so it is updated in place
                when that message lands instead of being replaced. */}
            {lastTurn?.kind !== "agent" && liveTail ? (
              <AgentTurn key={`agent-${messages.length}`}>{liveTail}</AgentTurn>
            ) : null}
            {transcribing ? (
              // The same row and bubble its committed message gets, only muted, so committing
              // it changes the ink and nothing else.
              <div key={`caller-${messages.length}`} className={CALLER_ROW}>
                <div className={`${CALLER_BUBBLE} text-muted-foreground`} aria-live="polite">
                  {transcribing}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );

  /** One row of actions per turn, under all it wrote: its words read as one reply. */
  function replyActions(items: readonly AgentTurnItem[]) {
    const reply = turnReply(items);
    if (!reply) return null;
    return (
      <ReplyActions
        // A turn that grows gets a new reply, and its audio is fetched for that.
        key={`actions-${reply.last.index}-${reply.text.length}`}
        text={reply.text}
        audio={reply.audio}
        newest={reply.last.index === newestReply}
        running={running}
        onShowModelInput={() => onShowModelInput(reply.last.message)}
        onGoBack={goBackFrom(reply.last.index)}
      />
    );
  }

  function goBackFrom(index: number) {
    if (!onGoBack) return undefined;
    const next = nextCallerMessage(messages, index);
    return next ? () => onGoBack!(next.index, next.text) : undefined;
  }
}

/** A caller row and its bubble, live or committed. No `text-wrap: pretty`: it re-breaks
 * earlier lines as words arrive, which reads as the words jumping. */
const CALLER_ROW = "group/turn relative flex max-w-[75%] flex-col self-end";
const CALLER_BUBBLE = "rounded-[18px] bg-muted px-4 py-2.5 text-[15px] leading-[1.55] whitespace-pre-wrap";

/** How near the bottom (px) still counts as reading the newest words. */
const PINNED_SLACK = 48;

/**
 * Keep the newest words in view while the reader is at the bottom, and leave them where
 * they are once they scrolled up to read something. Runs before paint, on every render and
 * on every size change of the content (a reply that reflows, markdown that finishes
 * rendering), so the view never shows a frame scrolled short. A new caller message brings
 * the reader back down: they just spoke or sent it.
 */
function useStickToBottom(
  ref: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  callerCount: number,
): () => void {
  const pinned = useRef(true);
  const lastCallerCount = useRef(callerCount);
  if (callerCount > lastCallerCount.current) pinned.current = true;
  lastCallerCount.current = callerCount;

  useLayoutEffect(() => {
    const element = ref.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });

  useLayoutEffect(() => {
    const element = ref.current;
    const content = contentRef.current;
    if (!element || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, contentRef]);

  return () => {
    const element = ref.current;
    if (element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight <= PINNED_SLACK;
  };
}

/** Turns with what a replay has not reached yet left out. */
function visibleTurns(
  turns: readonly ConversationTurn[],
  messages: readonly AgentChatMessage[],
  shown: (message: AgentChatMessage) => boolean,
): ConversationTurn[] {
  return turns.flatMap((turn): ConversationTurn[] => {
    if (turn.kind === "caller") return shown(turn.message) ? [turn] : [];
    const items = turn.items.filter((item) => shown(messages[item.index]));
    return items.length > 0 ? [{ ...turn, items }] : [];
  });
}

function AgentTurn({ children }: { children: ReactNode }) {
  return (
    <div className="group/turn grid max-w-[680px] grid-cols-[28px_minmax(0,1fr)] gap-x-3.5">
      <AgentSphere size={26} className="mt-px" />
      <div className="relative flex min-w-0 flex-col gap-2.5">{children}</div>
    </div>
  );
}

/**
 * A reply's words. While a call speaks a reply, the words already heard are in ink and the
 * rest muted; an interrupted reply keeps that split for good. Plain text then, because a
 * split rendered as two markdown blocks breaks a sentence in two.
 */
function ReplyText({ message, playback }: { message: AgentAssistantMessage; playback: ReplyPlayback }) {
  const ink = message.interruption
    ? { spoken: message.interruption.spokenText, unspoken: message.interruption.unspokenText }
    : replyInk(message.content, playback);
  if (ink) {
    return (
      <p className="m-0 text-[15px] leading-[1.65] [text-wrap:pretty]">
        {ink.spoken}
        {ink.spoken && ink.unspoken ? " " : null}
        {ink.unspoken ? (
          <span className="text-muted-foreground" aria-label={`Not spoken aloud: ${ink.unspoken}`}>
            {ink.unspoken}
          </span>
        ) : null}
      </p>
    );
  }
  return (
    <div className="markdown-message text-[15px] leading-[1.65]">
      <Streamdown>{message.content}</Streamdown>
    </div>
  );
}

/**
 * The reply being written, or "Thinking" before its first word. In a call it arrives muted:
 * the model writes a reply long before the voice says it, and none of it has been heard yet.
 */
function TurnInProgress({ text, muted }: { text: string | null; muted: boolean }) {
  if (text === null) {
    return (
      <p className="m-0 text-[15px] leading-[1.65]" role="status">
        <span className="agent-thinking">Thinking</span>
      </p>
    );
  }
  return (
    <div className={`markdown-message text-[15px] leading-[1.65]${muted ? " text-muted-foreground" : ""}`}>
      <Streamdown>{text}</Streamdown>
    </div>
  );
}

function EmptyConversation({
  agentName,
  prompts,
  onPrompt,
}: {
  agentName: string;
  prompts: readonly string[];
  onPrompt: (text: string) => void;
}) {
  return (
    <div className="flex flex-col items-center pt-[72px] text-center">
      <AgentSphere size={88} />
      <h2 className="mt-[22px] mb-1.5 text-[22px] font-semibold tracking-[-0.015em]">{agentName}</h2>
      <p className="m-0 max-w-[420px] text-[15px] text-muted-foreground [text-wrap:balance]">
        Start a call or type a message to talk to your agent.
      </p>
      {prompts.length > 0 ? (
        <div className="mt-7 flex max-w-[640px] flex-wrap justify-center gap-2">
          {prompts.map((prompt) => (
            <Button key={prompt} variant="outline" size="sm" className="font-normal" onClick={() => onPrompt(prompt)}>
              {prompt}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
