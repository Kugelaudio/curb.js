import type { TestHost } from "./host.js";

/**
 * The reply store: model replies a test has had before, looked up by the exact request.
 *
 * A host wrapped by {@link withReplyStore} answers each model request (the agent's, the simulated
 * caller's and the judge's) from the store when it holds a reply to exactly that request, and
 * calls the model only on a miss, storing what it answered. Nothing else in Curb knows about the
 * store. The remote protocol is on the guide's `reply-store.md` page.
 *
 *   import { localReplyStore, projectHost, withReplyStore } from "curb/testing";
 *   const host = withReplyStore(projectHost(), localReplyStore());
 */

/** One stored model reply. Only the reply is kept, never the request it answered. */
export type StoredReply = {
  /** The format of this record: 1. */
  v: 1;
  /** The request's key: the sha256 of its canonical JSON, hex. */
  key: string;
  /** The model that answered, as `provider:model`. */
  model: string;
  /** When the reply was stored, as an ISO date-time. */
  createdAt: string;
  /** The tokens the request used when it went to the model; null where the provider said none. */
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } | null;
  /** The reply as the model client received it, as JSON. */
  response: unknown;
};

/** Where stored replies live. `get` answers null for a key it does not hold; `put` of a key it
 * already holds keeps the reply it has. Either may throw: a store that fails is skipped, and a
 * test never fails because of it. */
export type ReplyStore = {
  get(key: string): Promise<StoredReply | null>;
  put(key: string, reply: StoredReply): Promise<void>;
};

const NOT_IMPLEMENTED = "is not implemented yet in this version of curb";

/**
 * A host that answers each model request from `stores` when one holds its reply, and otherwise
 * asks `host`'s model and stores the reply. Given several stores, the first that holds a reply
 * answers, and a reply found in a later one is copied to the earlier ones (local first, then
 * remote).
 */
export function withReplyStore(host: TestHost, stores: ReplyStore | readonly ReplyStore[]): TestHost {
  void host;
  void stores;
  throw new Error(`withReplyStore ${NOT_IMPLEMENTED}.`);
}

/**
 * Stored replies as files under `dir`, one immutable gzip JSON file per key
 * (`<dir>/v1/<first two characters of the key>/<key>.json.gz`). Default dir:
 * `CURB_REPLY_STORE_DIR`, else `$XDG_CACHE_HOME/curb/replies`, else `~/.cache/curb/replies`,
 * outside the checkout so every worktree shares it.
 */
export function localReplyStore(options: { dir?: string } = {}): ReplyStore {
  void options;
  throw new Error(`localReplyStore ${NOT_IMPLEMENTED}.`);
}

/**
 * Stored replies on a server that speaks the reply store protocol (`reply-store.md`). Default:
 * `CURB_REPLY_STORE_URL` and `CURB_REPLY_STORE_TOKEN`.
 */
export function remoteReplyStore(options: { url?: string; token?: string } = {}): ReplyStore {
  void options;
  throw new Error(`remoteReplyStore ${NOT_IMPLEMENTED}.`);
}
