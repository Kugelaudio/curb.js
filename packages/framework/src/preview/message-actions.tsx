import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  BracesIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  LoaderIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
  Undo2Icon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { cn } from "@/lib/utils.js";
import type { AgentMessageAudio } from "../llm/types.js";
import { isPlaying, playExclusive, stopPlayback, subscribePlayback } from "./audio-playback.js";
import { copyToClipboard } from "./transcript-export.js";

/**
 * A message's audio. Messages from a call carry `audio` clip references, the exact audio
 * that was heard or said (GET /voice/clip); a typed reply is spoken once through POST /tts
 * with the provider the call would use. Fetched once, then played and downloaded from
 * memory; one clip plays at a time across the page.
 */
function useMessageAudio(text: string, audio: AgentMessageAudio | undefined) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blobUrls = useRef<string[] | null>(null);
  const clipId = audio ? `clip-${audio.room}-${audio.role}-${audio.ordinals.join("-")}` : `tts-${text}`;
  const playing = useSyncExternalStore(subscribePlayback, () => isPlaying(clipId), () => false);

  useEffect(
    () => () => {
      for (const url of blobUrls.current ?? []) URL.revokeObjectURL(url);
    },
    [],
  );

  const fetchWavs = async (): Promise<string[]> => {
    if (blobUrls.current) return blobUrls.current;
    let blobs: Blob[];
    if (audio) {
      blobs = await Promise.all(
        audio.ordinals.map(async (ordinal) => {
          const response = await fetch(
            `/voice/clip?room=${encodeURIComponent(audio.room)}&role=${audio.role}&ordinal=${ordinal}`,
          );
          if (!response.ok) throw new Error(await response.text());
          return response.blob();
        }),
      );
    } else {
      const response = await fetch("/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(await response.text());
      blobs = [await response.blob()];
    }
    blobUrls.current = blobs.map((blob) => URL.createObjectURL(blob));
    return blobUrls.current;
  };

  const run = async (action: (urls: string[]) => void) => {
    setError(null);
    setLoading(true);
    try {
      action(await fetchWavs());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  return {
    playing,
    loading,
    error,
    togglePlay: () => {
      if (playing) stopPlayback();
      else void run((urls) => playExclusive(clipId, urls));
    },
    download: () =>
      void run((urls) =>
        urls.forEach((url, index) => {
          const link = document.createElement("a");
          link.href = url;
          link.download = urls.length > 1 ? `message-${index + 1}.wav` : "message.wav";
          link.click();
        }),
      ),
  };
}

/** An icon button with its name in a tooltip. */
function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50 [&_svg]:size-3.5"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

type MessageClip = ReturnType<typeof useMessageAudio>;

function PlayAction({ clip, audio }: { clip: MessageClip; audio?: AgentMessageAudio }) {
  const label = clip.error
    ? `Could not play: ${clip.error}`
    : clip.playing
      ? "Stop"
      : audio
        ? audio.role === "user"
          ? "Play what your agent heard"
          : "Play what was said on the call"
        : "Play";
  return (
    <IconAction label={label} disabled={clip.loading} onClick={clip.togglePlay}>
      {clip.loading ? (
        <LoaderIcon className="animate-spin" aria-hidden="true" />
      ) : clip.playing ? (
        <SquareIcon aria-hidden="true" />
      ) : (
        <PlayIcon aria-hidden="true" />
      )}
    </IconAction>
  );
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconAction
      label={copied ? "Copied" : "Copy"}
      onClick={() =>
        void copyToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        })
      }
    >
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
    </IconAction>
  );
}

/** Actions that show while their message is hovered or focused, laid over the space below it
 * instead of holding a row open under every message. Their parent is `relative`. */
const ON_HOVER =
  "pointer-events-none absolute top-full z-10 pt-0.5 opacity-0 group-hover/turn:pointer-events-auto group-hover/turn:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100";

/** Under a reply: play it, copy it, see the exact input the model wrote it from, and more. */
export function ReplyActions({
  text,
  audio,
  onShowModelInput,
  onGoBack,
  newest,
  running,
}: {
  text: string;
  audio?: AgentMessageAudio;
  onShowModelInput: () => void;
  /** Go back to this reply: drop what came after it and rewrite the next message. */
  onGoBack?: () => void;
  /** The newest reply keeps its row of actions; older ones show theirs while hovered. */
  newest: boolean;
  /** A turn is running: the newest reply hides its actions but keeps their row, so the
   * conversation does not shift up a row as each turn starts and back as it ends. */
  running: boolean;
}) {
  const clip = useMessageAudio(text, audio);
  return (
    <div
      className={cn(
        "-ml-1.5 flex items-center gap-0.5 transition-opacity",
        newest ? (running ? "invisible" : null) : `left-0 ${ON_HOVER}`,
      )}
    >
      <PlayAction clip={clip} audio={audio} />
      <CopyAction text={text} />
      <IconAction label="What the model read" onClick={onShowModelInput}>
        <BracesIcon aria-hidden="true" />
      </IconAction>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="More"
              className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-expanded:bg-accent [&_svg]:size-3.5"
            />
          }
        >
          <EllipsisIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          <DropdownMenuItem onClick={clip.download} disabled={clip.loading}>
            <DownloadIcon aria-hidden="true" />
            Download audio
          </DropdownMenuItem>
          {onGoBack ? (
            <DropdownMenuItem onClick={onGoBack}>
              <Undo2Icon aria-hidden="true" />
              Go back to this reply
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Under the caller's message, while hovered: hear what the agent heard, and retry from here. */
export function CallerActions({
  text,
  audio,
  onRetry,
}: {
  text: string;
  audio?: AgentMessageAudio;
  /** Answer this message again from the state before it. */
  onRetry?: () => void;
}) {
  const clip = useMessageAudio(text, audio);
  if (!audio && !onRetry) return null;
  return (
    <div className={`-mr-1.5 flex items-center justify-end gap-0.5 transition-opacity right-0 ${ON_HOVER}`}>
      {audio ? <PlayAction clip={clip} audio={audio} /> : null}
      {audio ? (
        <IconAction label="Download audio" disabled={clip.loading} onClick={clip.download}>
          <DownloadIcon aria-hidden="true" />
        </IconAction>
      ) : null}
      {onRetry ? (
        <IconAction label="Retry from here" onClick={onRetry}>
          <RotateCcwIcon aria-hidden="true" />
        </IconAction>
      ) : null}
    </div>
  );
}
