// Records Node's own default HTTP dispatcher, by identity, before any project code runs. The
// model client keeps its connection open between turns only while requests would still go out
// over that dispatcher (src/llm/keep-alive-fetch.ts); any other is the application's transport.
// bin/curb.js loads this first, and every process the CLI starts loads it through execArgv.
// When a dispatcher is installed already (a proxy from NODE_USE_ENV_PROXY, a preload), nothing
// is recorded, and the application's transport is kept.

const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
const NODE_DEFAULT_DISPATCHER = Symbol.for("curb.nodeDefaultDispatcher");

if (globalThis[GLOBAL_DISPATCHER] === undefined) {
  // Node's fetch installs its default Agent as it loads, which reading one of its globals does.
  void globalThis.Headers;
  globalThis[NODE_DEFAULT_DISPATCHER] = globalThis[GLOBAL_DISPATCHER];
}
