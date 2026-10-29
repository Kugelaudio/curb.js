/**
 * WebSocket path Vite's HMR socket uses under `curb dev`. Scoped to its
 * own path so the preview port's upgrade dispatcher (cli/dev.ts) hands HMR
 * to Vite and forwards everything else (chat on "/", voice on "/voice") to the
 * agent server. Kept dependency-free so both the supervisor and the Vite config
 * can import it without dragging in the other's module graph.
 */
export const VITE_HMR_PATH = "/__vite_hmr";
