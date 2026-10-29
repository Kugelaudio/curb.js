import { useEffect, useRef, useState } from "react";
import {
  DownloadIcon,
  ListEndIcon,
  PauseIcon,
  PlayIcon,
  Volume2Icon,
} from "lucide-react";
import {
  combineConversationRecordings,
  type ConversationRecording,
  type RecordingWindow,
} from "./voice/conversation-recording.js";

export type ConversationReplayState = {
  active: boolean;
  timeMs: number;
  windows: RecordingWindow[];
};

const PLAYER_BUTTON =
  "grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground";

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function ConversationPlayer({
  recordings,
  revision,
  onReplayChange,
}: {
  recordings: readonly ConversationRecording[];
  revision: number;
  onReplayChange: (state: ConversationReplayState) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [prepared, setPrepared] = useState<{
    url: string;
    durationMs: number;
    windows: RecordingWindow[];
  } | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [replayActive, setReplayActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(recordings.length > 0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setError(null);
    setCurrentTimeMs(0);
    setReplayActive(false);
    setPlaying(false);
    onReplayChange({ active: false, timeMs: 0, windows: [] });
    if (recordings.length === 0) {
      setLoading(false);
      setPrepared(null);
      return;
    }
    setLoading(true);
    void combineConversationRecordings(recordings)
      .then((combined) => {
        if (cancelled) return;
        url = URL.createObjectURL(combined.blob);
        setPrepared({ url, durationMs: combined.durationMs, windows: combined.windows });
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setPrepared(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // `revision` changes when a recording finishes; the array is intentionally
    // retained by the voice client so callers can keep stable references.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordings, revision]);

  if (recordings.length === 0) return null;

  const publishReplay = (active: boolean, timeMs: number) => {
    setReplayActive(active);
    setCurrentTimeMs(timeMs);
    onReplayChange({ active, timeMs, windows: prepared?.windows ?? [] });
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || !prepared) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    try {
      await audio.play();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const showFullTranscript = () => {
    audioRef.current?.pause();
    setPlaying(false);
    publishReplay(false, currentTimeMs);
  };

  return (
    <section
      className="mx-auto mb-1 flex w-full max-w-[720px] items-center gap-2.5 rounded-full border border-border/70 bg-card py-1 pr-1.5 pl-3.5 text-[0.8125rem] text-muted-foreground"
      aria-label="Call recording"
    >
      <audio
        ref={audioRef}
        src={prepared?.url}
        preload="metadata"
        onPlay={() => {
          setPlaying(true);
          publishReplay(true, (audioRef.current?.currentTime ?? 0) * 1000);
        }}
        onPause={() => setPlaying(false)}
        onTimeUpdate={() => {
          const timeMs = (audioRef.current?.currentTime ?? 0) * 1000;
          publishReplay(replayActive || !(audioRef.current?.paused ?? true), timeMs);
        }}
        onEnded={() => {
          setPlaying(false);
          publishReplay(false, prepared?.durationMs ?? 0);
        }}
      />
      <div className="flex shrink-0 items-center gap-1.5 font-medium text-foreground">
        <Volume2Icon className="size-3.5" aria-hidden="true" />
        <span>Call replay</span>
      </div>
      {loading ? (
        <div className="flex-1" role="status">
          Preparing audio
        </div>
      ) : error || !prepared ? (
        <div className="flex-1 text-destructive" role="status" title={error ?? undefined}>
          Recording unavailable{error ? `: ` : ""}
        </div>
      ) : (
        <>
          <button
            type="button"
            className={PLAYER_BUTTON}
            aria-label={playing ? "Pause conversation replay" : "Play conversation replay"}
            onClick={() => void togglePlayback()}
          >
            {playing ? <PauseIcon className="size-3.5" aria-hidden="true" /> : <PlayIcon className="size-3.5" aria-hidden="true" />}
          </button>
          <span className="shrink-0">{formatDuration(currentTimeMs)}</span>
          <input
            className="h-1 min-w-0 flex-1 cursor-pointer accent-foreground"
            type="range"
            min={0}
            max={Math.max(1, Math.round(prepared.durationMs))}
            step={50}
            value={Math.min(currentTimeMs, prepared.durationMs)}
            aria-label="Conversation replay position"
            onChange={(event) => {
              const timeMs = Number(event.currentTarget.value);
              if (audioRef.current) audioRef.current.currentTime = timeMs / 1000;
              publishReplay(true, timeMs);
            }}
          />
          <span className="shrink-0">{formatDuration(prepared.durationMs)}</span>
          {replayActive ? (
            <button
              type="button"
              className={PLAYER_BUTTON}
              aria-label="Show full transcript"
              title="Exit synchronized replay and show the full transcript"
              onClick={showFullTranscript}
            >
              <ListEndIcon className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
          <a
            className={PLAYER_BUTTON}
            href={prepared.url}
            download="conversation.wav"
            aria-label="Download full conversation as WAV"
            title="Download full conversation as WAV"
          >
            <DownloadIcon className="size-3.5" aria-hidden="true" />
          </a>
        </>
      )}
    </section>
  );
}
