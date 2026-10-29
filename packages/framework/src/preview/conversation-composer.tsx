import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  LoaderIcon,
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { cn } from "@/lib/utils.js";
import { AgentSphere } from "./agent-sphere.js";
import type { MicrophoneDevice } from "./voice/types.js";

/** One line above the composer: a problem to see (red), or something to know. The page
 * fills these from main.tsx; each says one thing. */
export type ComposerNotice = {
  key: string;
  tone: "error" | "neutral";
  text: ReactNode;
  onDismiss?: () => void;
};

/** The call attached to the conversation, and its controls. */
export type ComposerCall = {
  live: boolean;
  connecting: boolean;
  speaking: boolean;
  /** The agent is working out its reply. */
  thinking: boolean;
  micMuted: boolean;
  microphones: readonly MicrophoneDevice[];
  selectedMicrophoneId: string | null;
  switchingMicrophone: boolean;
  onStart: () => void;
  onStop: () => void;
  onToggleMute: () => void;
  onMicrophoneChange: (deviceId: string) => void;
  /** The microphone menu opened: list the inputs again, with their names. */
  onMicrophoneMenuOpen: () => void;
};

/**
 * One row: the field with its send button, and beside it the call, named on its button.
 * In a call the field stays for typing, and the call's own controls (mute, the microphone,
 * End call) take the button's place. Before a call, a microphone button beside Start call
 * picks the input the call will use.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  running,
  notices,
  call,
  blocked,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder: string;
  running: boolean;
  notices: readonly ComposerNotice[];
  call: ComposerCall;
  /** The agent cannot answer (a key it needs is not set; the page says which): nothing can be
   * typed or sent, and no call started. */
  blocked: boolean;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [multiline, setMultiline] = useState(false);

  // The field grows with what is typed, up to its max height, then scrolls.
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    const height = Math.min(element.scrollHeight, 160);
    element.style.height = `${height}px`;
    element.style.overflowY = element.scrollHeight > 160 ? "auto" : "hidden";
    setMultiline(height > 30);
  }, [value]);

  const canSend = !blocked && !running && value.trim().length > 0;
  return (
    <div className="pointer-events-none absolute right-6 bottom-[22px] left-6 mx-auto flex max-w-[760px] flex-col gap-2.5">
      {notices.map((notice) => (
        <Notice key={notice.key} notice={notice} />
      ))}
      {call.live || call.connecting ? <CallLine call={call} /> : null}
      <form
        className="pointer-events-auto flex items-end gap-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) onSubmit(value);
        }}
      >
        <div
          className={cn(
            "flex min-h-12 flex-1 items-end gap-2 border border-border bg-card py-[6px] pr-[7px] pl-5 shadow-[0_6px_20px_-10px_rgb(0_0_0/0.14)] transition-[border-radius] focus-within:border-ring/60",
            multiline ? "rounded-3xl" : "rounded-full",
          )}
        >
          <textarea
            ref={textarea}
            rows={1}
            value={value}
            aria-label="Message"
            disabled={blocked}
            placeholder={
              blocked ? "Set the key above to talk to your agent" : call.live ? "Type to your agent during the call…" : placeholder
            }
            className="max-h-40 min-h-0 flex-1 resize-none self-center border-0 bg-transparent py-[5px] text-[15px] leading-6 outline-none placeholder:text-muted-foreground"
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (canSend) onSubmit(value);
            }}
          />
          <button
            type="submit"
            aria-label={running ? "Your agent is answering" : "Send"}
            disabled={!canSend}
            className="grid size-[34px] shrink-0 place-items-center rounded-full bg-foreground text-background transition-colors hover:bg-foreground/85 disabled:bg-[hsl(60_3%_88%)] disabled:text-card"
          >
            <ArrowUpIcon className="size-4" aria-hidden="true" />
          </button>
        </div>
        {call.live ? (
          <>
            <MicControls call={call} />
            <Button size="xl" className="shadow-[0_6px_20px_-10px_rgb(0_0_0/0.3)]" onClick={call.onStop}>
              <PhoneOffIcon aria-hidden="true" />
              End call
            </Button>
          </>
        ) : (
          <>
            <MicPicker call={call} />
            <Button
              size="xl"
              className="shadow-[0_6px_20px_-10px_rgb(0_0_0/0.3)]"
              disabled={blocked || call.connecting}
              onClick={call.onStart}
            >
              {call.connecting ? (
                <LoaderIcon className="animate-spin" aria-hidden="true" />
              ) : (
                <PhoneIcon aria-hidden="true" />
              )}
              Start call
            </Button>
          </>
        )}
      </form>
    </div>
  );
}

function Notice({ notice }: { notice: ComposerNotice }) {
  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={cn(
        "pointer-events-auto flex items-start gap-2 px-2 text-[0.8125rem] leading-snug",
        notice.tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {notice.tone === "error" ? <CircleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" /> : null}
      <span className="min-w-0 flex-1 break-words">{notice.text}</span>
      {notice.onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss"
          className="grid size-5 shrink-0 place-items-center rounded-md hover:bg-accent"
          onClick={notice.onDismiss}
        >
          <XIcon className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** Seconds since the call went live, ticking while it is. */
function useCallSeconds(live: boolean): number {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) {
      setStartedAt(null);
      return;
    }
    setStartedAt(Date.now());
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

function CallLine({ call }: { call: ComposerCall }) {
  const seconds = useCallSeconds(call.live);
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const activity = call.speaking ? "your agent is speaking" : call.thinking ? "your agent is thinking" : "listening";
  return (
    <div className="pointer-events-auto flex items-center gap-2.5 px-2 text-sm" role="status">
      <AgentSphere size={32} live={call.speaking ? "speaking" : "quiet"} />
      {call.live ? (
        <>
          <span className="font-medium">In call</span>
          <span className="text-muted-foreground">
            {elapsed} · {activity}
            {call.micMuted ? " · your microphone is muted" : ""}
          </span>
        </>
      ) : (
        <span className="text-muted-foreground">Starting the call…</span>
      )}
    </div>
  );
}

/** Mute, and beside it the menu that picks the microphone: one split button. */
function MicControls({ call }: { call: ComposerCall }) {
  const muteLabel = call.micMuted ? "Unmute your microphone" : "Mute your microphone";
  return (
    <div className="flex h-12 items-center rounded-full border border-border bg-card shadow-[0_6px_20px_-10px_rgb(0_0_0/0.14)]">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={muteLabel}
              aria-pressed={call.micMuted}
              className="grid h-full place-items-center rounded-l-full px-3.5 hover:bg-accent aria-pressed:bg-muted"
              onClick={call.onToggleMute}
            />
          }
        >
          {call.micMuted ? <MicOffIcon className="size-4" aria-hidden="true" /> : <MicIcon className="size-4" aria-hidden="true" />}
        </TooltipTrigger>
        <TooltipContent>{muteLabel}</TooltipContent>
      </Tooltip>
      <span className="h-6 w-px bg-border/70" aria-hidden="true" />
      <MicrophoneMenu
        call={call}
        trigger={
          <button
            type="button"
            aria-label="Microphone"
            className="grid h-full place-items-center rounded-r-full px-2.5 text-muted-foreground hover:bg-accent aria-expanded:bg-accent"
          />
        }
      >
        <ChevronDownIcon className="size-3.5" aria-hidden="true" />
      </MicrophoneMenu>
    </div>
  );
}

/** Before a call: the microphone the call will use, as a round button beside Start call. */
function MicPicker({ call }: { call: ComposerCall }) {
  const selected = call.microphones.find((microphone) => microphone.deviceId === call.selectedMicrophoneId);
  const label = selected ? `Microphone: ${selected.label}` : "Microphone";
  return (
    <Tooltip>
      <MicrophoneMenu
        call={call}
        trigger={
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={label}
                className="flex h-12 items-center gap-1 rounded-full border border-border bg-card px-3.5 shadow-[0_6px_20px_-10px_rgb(0_0_0/0.14)] hover:bg-accent aria-expanded:bg-accent"
              />
            }
          />
        }
      >
        <MicIcon className="size-4" aria-hidden="true" />
        <ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </MicrophoneMenu>
      <TooltipContent>{selected?.label ?? "Choose a microphone"}</TooltipContent>
    </Tooltip>
  );
}

/** The menu that picks the microphone, opened from `trigger`; opening it lists the inputs again. */
function MicrophoneMenu({
  call,
  trigger,
  children,
}: {
  call: ComposerCall;
  trigger: ReactElement;
  children: ReactNode;
}) {
  return (
    <DropdownMenu onOpenChange={(open) => (open ? call.onMicrophoneMenuOpen() : undefined)}>
      <DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Microphone</DropdownMenuLabel>
          {call.microphones.length === 0 ? (
            <DropdownMenuItem disabled>No microphones found</DropdownMenuItem>
          ) : (
            <DropdownMenuRadioGroup
              value={call.selectedMicrophoneId ?? ""}
              onValueChange={(deviceId) => {
                if (typeof deviceId === "string" && deviceId) call.onMicrophoneChange(deviceId);
              }}
            >
              {call.microphones.map((microphone) => (
                <DropdownMenuRadioItem
                  key={microphone.deviceId}
                  value={microphone.deviceId}
                  disabled={call.switchingMicrophone}
                >
                  <span className="truncate">{microphone.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
