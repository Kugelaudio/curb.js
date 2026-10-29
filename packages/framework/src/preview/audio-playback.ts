/**
 * One shared playback slot for every per-message audio button (chat replies,
 * voice-panel clips): starting a clip stops whatever else was playing, and
 * components subscribe so their Play/Stop icons follow ownership.
 */
let current: { id: string; audio: HTMLAudioElement; cleanup?: () => void } | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export function stopPlayback(): void {
  if (!current) return;
  const { audio, cleanup } = current;
  current = null;
  audio.onended = null;
  audio.pause();
  cleanup?.();
  notify();
}

/** Play `urls` exclusively under `id` (stops anything else first) — several
 * urls play back to back as one clip (a message whose audio spans multiple
 * server clips). `cleanup` runs when playback ends, errors, or is
 * stopped/preempted. */
export function playExclusive(id: string, urls: string | string[], cleanup?: () => void): void {
  const queue = Array.isArray(urls) ? [...urls] : [urls];
  stopPlayback();
  const playNext = (): void => {
    const url = queue.shift();
    if (!url) return;
    const audio = new Audio(url);
    current = { id, audio, cleanup };
    const finish = () => {
      if (current?.audio !== audio) return;
      if (queue.length > 0) {
        playNext();
        return;
      }
      current = null;
      cleanup?.();
      notify();
    };
    audio.onended = finish;
    void audio.play().catch(finish);
  };
  playNext();
  notify();
}

export function isPlaying(id: string): boolean {
  return current?.id === id;
}

/** useSyncExternalStore-compatible subscription. */
export function subscribePlayback(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}
