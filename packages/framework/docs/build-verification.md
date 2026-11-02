# curb build — runtime verification

Evidence that a built artifact RUNS, not merely that it compiles. Reproduce with
the steps at the bottom; the exact ids will differ, the shape should not.

## The automatic check

`curb build` performs the first half of this by itself, on every build. After the
manifest is written it ensures the artifact is outside dependency-install ancestry,
reads `curb.bundle.json`, runs `node <entrypoint> start` with placeholder LiveKit
credentials, and waits for the line the worker logs when it starts. Repository builds
are copied to an isolated temp directory; hosted builds whose output already has no
ancestor `node_modules` run in place, avoiding a second copy of the finished artifact:

```text
{"level":30,...,"version":"1.5.2","msg":"starting worker"}
```

That line is reachable only once every import resolved AND a worker began, and
it is logged before the first connection attempt, so the check needs no LiveKit
server and works offline and in CI. On success the build prints:

```text
  verified started a worker from packages/framework/entry/worker.mjs in 1.4s
```

The artifact is killed as soon as the marker appears. If it exits first (for any
reason, including exit 0), times out, or cannot be started, the build prints the
child's stdout and stderr and exits non-zero. Both of the bugs described below
shipped from builds that reported success, so a build that produces an unrunnable
artifact now fails.

Three details are load-bearing and easy to undo by accident:

- the artifact has no ancestor install. Repository builds must be copied out because
  running them in place lets Node resolve upward into the real install and makes every
  packaging bug pass as a false green; an already isolated hosted artifact needs no copy;
- the entrypoint comes from the manifest, never a constant. The manifest naming
  the wrong file is one of the two bugs;
- success is the marker, not the exit code. An entry that exits 0 may have
  started nothing.

`--no-verify` skips it, for anyone who wants the artifact without the check; the
build then prints `verified NO: the artifact was not started, so it is not known
to run`. `--no-trace` skips it too, since a bundle without its runtime tree
cannot start.

## The render self-check

A started worker is necessary and not sufficient. An artifact shipped that
booted, joined a room, and had nothing to say: the project's `context/` markdown
was never packaged, so every `<Text src=…>` raised
`Context markdown "policy/coverage-basics.md" was not found. Available files:
(none).` and the agent rendered an empty tree. No start marker could have caught
that.

So the same entrypoint is run a second time with the argument
`curb-render-check`. In that mode the worker starts no LiveKit worker; it builds
the bundled agent, renders EVERY skill (file-backed markdown usually lives in
skills a conversation opens only when needed), and prints one machine-readable line:

```text
curb-render-check {"skills":["/claim-procedure","/policy-questions/coverage",…],
  "contextFiles":["member/unlocked-context.md","policy/coverage-basics.md",
  "property-damage/intake-checklist.md"],
  "contextDocs":[{"skill":"/policy-questions/coverage",
  "src":"policy/coverage-basics.md","chars":617}],"errors":[]}
```

The build fails when that line is missing, when `errors` holds any
error-severity authoring diagnostic, or when the reported `contextFiles` do not
cover every markdown file the project's `context/` holds. The set, not the
count: shipping two of three files leaves one skill silently empty. On success
the build prints:

```text
  rendered  12 skill(s), 2 context doc(s) from 3 bundled markdown file(s)
```

The mode lives in the runnable entry rather than in a fourth entry point on
purpose — what renders has to be the module graph the runner actually executes,
or a sibling could carry context the real entrypoint is missing and still report
a green build. Implementation: `src/bundler/render-check.ts` (runs inside the
artifact) and `runRenderCheck` in `src/bundler/verify.ts` (reads the line back).

## Isolation

```text
artifact:        /tmp/curb-proof  (copied out, or already isolated by the host)
ancestor node_modules above it:   none
TypeScript sources in artifact:   0 (.tsx)
tsx loader in artifact:           0
```

Isolation is the point. Run the artifact inside the repo and Node silently
resolves against the real install, so every packaging bug passes as a false green.

## The artifact's own log

```json
{"level":30,"time":1785146101135,"pid":91271,"version":"1.5.2","msg":"starting worker"}
{"level":30,"time":1785146101147,"pid":91271,"version":"1.5.2","id":"AW_q5DGec2uJHSm","agentName":"curb-proof","agentNameIsEnv":false,"server_info":{"edition":"Standard","version":"1.13.4","protocol":
{"level":30,"time":1785146119493,"pid":91271,"version":"1.5.2","jobId":"AJ_5NUMFJpdFNFE","resuming":false,"agentName":"curb-proof","msg":"received job request"}
```

Fatal errors (`"level":50`): 0

## The LiveKit server's independent view

Confirmation from the other side of the connection, not the artifact's own claim:

```text
2026-07-27T09:55:01.147Z	INFO	livekit.agents	service/agentservice.go:303	worker registered	{"namespace": "", "jobType": "JT_ROOM", "agentName": "curb-proof", "workerID": "AW_q5DGec2uJHSm"}
"room": "proof-room", "roomID": "RM_gUmAcBhYT9KD", "participant": "agent-AJ_5NUMFJpdFNFE"
```

The agent joined as a participant and held the connection, pinging at ~1 ms RTT.

## Direct join: one room, one call

The artifact has a second mode, for a platform that has already done the
dispatching. It creates the room, mints the agent a token, and starts exactly one
runner for exactly one session; registering a worker pool there would re-do that
work, and a worker pool can only be registered with the LiveKit **API key and
secret**, the platform's credentials for every room it will ever create.

Set both `CURB_REALTIME_URL` and `CURB_REALTIME_TOKEN` and the entrypoint joins
that one room instead:

```bash
CURB_REALTIME_URL=ws://127.0.0.1:7880 CURB_REALTIME_TOKEN=<join token> \
  CURB_SESSION_ID=sess-1 node packages/framework/entry/worker.mjs
```

```text
 ✓ 17:20:35 voice livekit agent joined room curb-proof-room
curb-hosted {"event":"joined","room":"curb-proof-room"}
```

`curb-hosted` lines are one JSON object each, on stdout: `joined` when the agent
is in the room and serving, `stopping` when a signal arrived, `ended` when the
call is over. The platform needs a positive signal that the agent is IN the room;
"the process is still alive" is not the same claim.

The mode is chosen once, before anything else runs, and it is an if/else around
the whole worker path, so `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are never
read here. They are also DELETED from the environment on entry, loudly, because
"we do not read them" is a property any later import can quietly break:

```text
curb: LIVEKIT_API_KEY and LIVEKIT_API_SECRET were present in this runner's
environment and have been removed. A hosted runner joins one room with one token
and must never receive the platform's LiveKit credentials.
```

With neither variable set, the worker/dispatch path above is unchanged. With
exactly one set the runner exits 78 naming the other, rather than falling back to
a worker pool it has no credentials for; a token the room rejects exits 70 with
the server's reason. SIGTERM and SIGINT close the session and disconnect the room
(the platform's executor signals the process group), then the process exits 0.

Implementation: `src/bundler/direct-join.ts`, which runs inside the artifact.

## Dependency versions

The artifact must resolve every dependency to the version the project installed.
It is not enough for the package to be present: an artifact assembled from the
traced file set alone hands a package whatever version some other consumer
hoisted to the top, which is silent at build time and fatal at import.

```text
@livekit/agents@1.5.2                        needs commander@12.1.0, got 7.2.0
  -> Option.env is not a function
@opentelemetry/exporter-trace-otlp-proto@0.54.2  needs otlp-exporter-base@0.54.2, got 0.208.0
  -> Class extends value undefined is not a constructor or null
```

`curb build` now reproduces the installed tree rather than the traced one
(`src/bundler/dependency-mirror.ts`) and FAILS if any dependency edge still
disagrees with the source install, naming the package. The build prints how many
packages it had to copy in:

```text
  runtime  279.89 MB  2515 files
  mirrored 93 package(s) the trace could not reach
```

## Context markdown

The runtime reads a project's `context/` relative to `AGENT_PROJECT_DIR` or the
working directory. A hosted artifact has neither: the platform starts it from an
arbitrary directory that is not a curb project, so that lookup always finds
nothing. `@vercel/nft` cannot help — it traces JavaScript imports, and these
files are read by path at runtime.

So `curb build` INLINES them (`src/bundler/context-registry.ts`), the way the
skills' own sources travel through `?raw`: content in the module graph needs no
root, and a root is exactly what the artifact cannot know. The whole directory
goes in, not the files the tree references statically — `<Text src={…}>` can be
computed at render time, and a skill loaded mid-conversation renders long after
any build-time scan.

A missing context file is unchanged in every other respect: it still raises a
loud `AGENT_AUTHORING_RENDER_FAILED` naming the src and the files that ARE
available. The error was never the problem; the shipping was.

## Content addressing

`curb.bundle.json` describes the artifact completely, and `treeDigest` is its
identity. Without that field there is nothing for an artifact store to verify,
no way to tell whether a revision has already been built, and no stable key for
"the artifact that worked" to roll back to.

```json
{
  "schemaVersion": 1,
  "frameworkVersion": "0.3.0",
  "runtimeProtocolVersion": "1.0",
  "mediaRelayProtocol": 1,
  "runtime": { "node": "26" },
  "entrypoint": "packages/framework/entry/worker.mjs",
  "entryDigest": "sha256:66bae0…",
  "treeDigest": "sha256:6ebf1e…",
  "externals": [
    { "specifier": "onnxruntime-node", "version": "1.27.0", "native": true },
    { "specifier": "@livekit/rtc-ffi-bindings", "version": "0.13.31", "native": true },
    …
  ],
  "requiredSecrets": [],
  "requiredCapabilities": ["provider.llm", "provider.stt", "provider.tts", "realtime.audio"],
  "goals": [{ "name": "booked", "kind": "tool", "tool": "book_slot" }, …],
  "experiments": [{ "name": "greeting", "variants": [{ "name": "casual", "weight": 1 }, { "name": "formal", "weight": 1 }] }],
  "hooks": ["afterCall"],
  "hooks": ["afterCall"],
  "target": { "os": "darwin", "architecture": "arm64" },
  "reproducible": true,
  "assets": [{ "path": "assets/agent-source/agent.tsx", "kind": "agent-source" }, …],
  "files": [{ "path": "…", "digest": "sha256:…", "size": 1234, "mode": "644" }, …]
}
```

`files` lists every file in the bundle except `curb.bundle.json` itself, which
cannot be inside its own digest. `entryDigest` stays alongside `treeDigest`
because they answer different questions: "is the file the runner is about to
execute the one that was built" is checkable without reading 600 MB.

### The canonical form

`treeDigest` is `sha256:` plus the hex SHA-256 of this byte stream — spelled
out here because the runner reproduces it in another language, and a digest two
implementations compute differently is worse than none:

```text
header := "CURB-BUNDLE-DIGEST-V1" LF
count  := decimal(number of entries) LF
entry  := path NUL mode NUL decimal(size) NUL sha256-hex LF
stream := header count entry*
```

- `path` is bundle-root-relative, POSIX-separated, no `./` prefix, UTF-8 bytes
  exactly as the filesystem reported them (no case folding, no normalization).
- entries are sorted ascending by the UTF-8 **bytes** of `path` — Go's
  `sort.Strings`, deliberately not JavaScript's default sort, which orders
  UTF-16 code units and disagrees above the BMP.
- `curb.bundle.json` at the root is excluded. Directories are not entries.
- `mode` is `755` when the owner-execute bit is set and `644` otherwise. Nothing
  else about `st_mode` is recorded; a vendored native prebuild that loses `+x`
  is broken, and a digest that could not see that would call it identical.
- mtime, atime, ctime, uid, gid, inode and device are not recorded.
- a symbolic link is a build error, not an entry: the tree is copied with
  `dereference: true`, so a link in a finished bundle means a file was placed by
  a path the manifest cannot describe.

Implementation: `src/bundler/bundle-digest.ts`.

### Determinism

`reproducible: true` is asserted, not declared. Three things used to make it
false and all three are fixed:

- the `?raw` loader handed esbuild absolute file names, and esbuild labels each
  bundled module with its path — so every artifact carried thirteen
  `/Users/<someone>/…` comments. The loader now presents paths relative to the
  dependency root and passes the absolute one through `pluginData`.
- esbuild's other module comments were relative to `process.cwd()`, so the same
  revision built from the project directory and from the workspace root produced
  different bytes. `absWorkingDir` is now pinned to the dependency root.
- the dependency trace seeded itself with the bundle **where it was written**,
  and `@vercel/nft` resolves a seed's imports by walking up from it. A bundle
  built in place inside the checkout therefore resolved the repository's own
  `node_modules` and shipped the root `commander@7` — the exact version the
  dependency mirror exists to keep away from `@livekit/agents` — which a build
  to `/tmp` never picked up. `curb build --out <inside the repo>` and
  `--out /tmp/...` produced different trees and different digests. The bundle is
  now traced from an isolated copy in a temp directory, the same isolation
  argument the verification step already makes about *starting* an artifact.

  The four externals then appear as `Failed to resolve dependency` warnings,
  counted under a named class: the isolated seed genuinely cannot see them, and
  the build copies them whole and traces them from the framework's location
  anyway. Packages the bundled JavaScript loads by name at runtime, through a
  require esbuild cannot see (`undici`, which the AI SDK loads with
  `module.createRequire`), are seeded from the framework's location the same
  way: the isolated copy cannot reach them, and without that seed they would be
  missing from the artifact.

Before the manifest is written, the build re-reads the entries it emitted and
**fails** if either still contains a build-machine path. The check and the flag
live next to each other on purpose: a `reproducible: true` that no code verifies
is not evidence of anything.

```bash
cd examples/insurance-agent
curb build --out /tmp/bundle-a
curb build                       # and in place, which must not change the answer
# both print the same line:
#   digest   sha256:6ebf1e7745bb3fcba131d356b6332a17e66ebf0ba8fc34c8a4a4a2234ec69c15
#            over 13749 file(s) listed in curb.bundle.json
```

The same assertion runs in the suite (`src/bundler/determinism.test.ts`), which
builds the fixture project twice into different output directories and compares
the manifests entry by entry — so a failure names the file that changed rather
than only the digest.

What determinism this claims: the same revision, the same framework version, the
same target and the same installed dependency tree produce the same digest. The
vendored dependency bytes are the project's install, pinned by its lockfile;
this build copies them, it does not resolve them.

### assets/

The bundle carries the revision's own text a second time, as files:

```text
assets/context/       the project's context/*.md, byte-identical to the revision
assets/agent-source/  agent.tsx and every skill.tsx, byte-identical
```

Both also reach the runtime inlined in the module graph, where nothing can read
them back as text. An authoring surface asked to show a *running* agent's source
has the artifact and not the checkout. The agent-source set is read back out of
the generated agent registry rather than re-walking `src/agent/`, so it cannot
drift from the set the bundle actually loads.

## Layered builds: a cached dependency layer

A hosted artifact is two layers. The **app layer** is `curb.bundle.json`, `assets/**`,
`mcp.servers.json` when the project has one, and the emitted entry,
`<entryHome>/entry/worker.mjs` (`entryHome` is `node_modules/curb` in a
hosted build). Everything else is the
**dependency layer**: the externals copied whole, the traced runtime files, the mirrored
versions, and Silero's ONNX model. The model is copied beside the generated entries because
the bundled Silero JavaScript resolves it relative to `import.meta.url`; it is still
dependency content rather than app content. The dependency layer depends on the install
alone, because the trace is seeded from an isolated copy of the bundle that cannot resolve
`node_modules`. A builder can therefore reuse it across revisions whose lockfile has not
changed.

### `curb build --emit-layers <dir>`

Builds exactly as usual, with the same tree and a byte-identical manifest, and also writes:

```text
<dir>/dependency-files.json  {"format":1,"files":[...]}  every non-app path, byte-sorted
<dir>/build-inputs.json      {"format":1,"inputs":[...],"edges":[...],"recordedExternals":[...]}
```

`inputs` are project-root-relative and self-sufficient. They list every `node_modules` file
esbuild read (from its metafile) and every `package.json` from those files up to their
package root. They also list the whole curb package without its nested `node_modules`, and
the toolchain that runs `curb build`: `tsx`, and `esbuild` with its platform binary
package, each resolved from the framework the way Node resolves it at build time, with its
dependency closure. A `node_modules` holding exactly `inputs` runs a hit build. `edges` are
the bare imports of project and
generated files as `{importer, specifier, kind, resolved}`. `recordedExternals` are the
bare specifiers esbuild left external. Node builtins are in neither: nothing in
`node_modules` can change one.

The build fails (exit 1, never 75) and writes no records when either layer could leak into
the other:

- the isolated bundle copy reached a trace file that no external seed reaches, which would
  make the dependency layer a function of agent code;
- a dependency stage wrote an entry, `assets/`, `mcp.servers.json` or the manifest.

`--emit-layers` cannot be combined with `--no-trace` or `--dependency-layer`.

### `curb build --dependency-layer <descriptor.json>`

The project's `node_modules` holds only the build inputs, and the descriptor supplies the
rest: `files` (the dependency layer's `files[]` entries), `externals` (the full build's
`externals[]`) and `buildInputs`. The build runs generate, esbuild, the escape checks,
the agent import that reads its goals and experiments, assets and manifest. It writes only
the app layer to `--out`, does not load `@vercel/nft`, and does not start the artifact. The
deployment's readiness probe does that.

`files[]` is the app entries plus the descriptor's entries, `treeDigest` covers that union,
and `externals[]` is the descriptor's. For the same revision and dependency key the manifest
is byte-identical to the one `--emit-layers` wrote.

When the project reaches past the record, the build **escapes**. It exits 75, writes
nothing to `--out`, prints a human-readable reason on stdout, and prints exactly one line on
stderr:

```json
{"code":"layer_escape","reason":"unresolved_import","path":"left-pad"}
```

| `reason` | What happened | `path` |
|---|---|---|
| `unresolved_import` | esbuild could not resolve an import against the inputs, or the build's import of the agent failed with a stub loaded for a missing package, or Node could not find a module there | the specifier (the first stubbed package), or the project-relative file |
| `node_modules_in_source` | esbuild read a `node_modules` directory inside project source | the file |
| `unrecorded_input` | esbuild read a `node_modules` file the record lacks | the file |
| `unrecorded_external` | the bundle leaves an external to runtime that was not recorded | the specifier |
| `unrecorded_edge` | a project file has a bare import whose importer, kind or resolution was not recorded | the specifier |

An escape is not a build error. The builder falls back to a full install and
`--emit-layers` in the same attempt.

### Matching rules

- **Node builtins are never edges or externals.** `fs`, `node:crypto` and the rest are left
  out of `edges` and `recordedExternals` and ignored by the checks. Nothing in
  `node_modules` can satisfy or change a builtin, so a new builtin import cannot move either
  layer and does not escape.
- **`reason` is one of the five fixed tokens above.** A builder can branch on it; the prose
  on stdout is for people and may change.
- **An edge is all four fields.** `importer`, `specifier`, `kind` and `resolved` must all
  match a recorded edge. A new file importing an already-recorded package escapes, and so
  does a recorded import that now resolves elsewhere, such as a nested version.

### Why the toolchain is in the inputs

The esbuild version is part of the output. An earlier version of the check below placed
the root `esbuild@0.28.1` rather than the `esbuild@0.25.12` the framework resolves. Nothing
escaped, but the runtime helpers esbuild emits changed, and with them `entryDigest` and
`treeDigest`. `inputs` therefore records the toolchain at the framework's own resolution,
rather than leaving the builder to supply one.

### `mcp.servers.json` is app content

The framework reads a project's MCP server list from `join(process.cwd(),
"mcp.servers.json")` (`src/mcp/servers-store.ts`). The tracer used to follow that call into
the project, so agent configuration arrived in the artifact as a traced file, which would
have put it in the dependency layer. The trace now ignores it, and the assets stage copies
it in every mode to the same position: `mcp.servers.json` at the root of a hosted build.
Editing it changes `files[]` and `treeDigest` like any other app file. It is never an escape
and never touches the dependency layer.

### Checked end to end

The first layered-build baseline was run on 2026-09-11 against
`examples/insurance-agent`, copied to `/private/tmp` with the
workspace install laid out as a hosted one (`node_modules/curb` a real copy), on
darwin-arm64 with Node 26.5.0. `mcp.servers.json` was removed from the copy, for the reason
above. Other work was running on the machine, so treat the durations as indicative.

```text
curb build                                  15.6s  runtime 279.82 MB  2513 files  (verified)
curb build --emit-layers <dir>              20.2s  same curb.bundle.json as above (cmp: identical)
  descriptor: 13715 dependency files, 18 app files, 1049 inputs, 43 edges, 9 recorded externals
fresh copy, node_modules = inputs + tsx/esbuild closure: 1125 files (full install: 66372)
curb build --dependency-layer descriptor.json 0.5s  19 files written
  cmp full/out-emit/curb.bundle.json hit/out/curb.bundle.json: byte-identical
```

The hit-mode build's stages: generate 0.0s, esbuild 0.5s, escape 0.0s, clean 0.0s,
assets 0.0s, reproducible 0.0s, digest 0.0s, manifest 0.0s. Today's code, on the same copy
before this change, counted the same `runtime 279.82 MB`, so measuring with `stat` instead
of re-reading each traced file left the byte count unchanged. The file count is 2514 there
and 2513 here because the file set aside was `mcp.servers.json`.

On 2026-09-17, selective bundling moved the portable LiveKit agents runtime, rtc-node
JavaScript wrapper and Silero plugin into the existing esbuild output. Only the actual
native packages remain external. In a clean Linux/amd64 Node 24.19 build this reduced the
artifact from 13,718 files / 853,512,058 bytes to 910 files / 411,192,710 bytes and build
time from 48.9s to 21.5s. The finished artifact then reached worker startup in 1.2s,
rendered in 1.4s and completed real managed-runner Silero/ONNX warmup in 498ms. On
darwin-arm64, two clean selective builds produced the same tree digest with 901 files /
207,371,679 bytes. These are isolated packaging measurements, not end-to-end call latency.

Implementation: `src/bundler/layers.ts` and `src/bundler/layer-escape.ts`. Suite:
`layers.test.ts` and `layer-escape.test.ts` (pure), `layered-build.test.ts` (`--emit-layers`) and
`layered-build.dependency-layer.test.ts` (`--dependency-layer`), which together cover:

- both modes over a real project;
- a CLI hit build from a tree materialized from exactly the recorded inputs, whose agent
  imports `sharp` and `curb/orchestration` and still has its goals and experiments read
  without those natives (exit 0, not 75, on Node 22.15 and later; below that, exit 75);
- a CLI hit build whose agent leaves a timer running at import, which still finishes;
- a changed `mcp.servers.json`;
- the explicit Silero model asset and a real managed-runner warmup;
- the five escapes and CLI exit 75;
- a module-resolution probe showing the tracer is never loaded.

## Publication: what the manifest declares, and who reads it

The manifest is not only for `curb`. A host that stores or runs artifacts can
parse it and refuse a bundle that fails any property it can judge without
unpacking the archive. Without these fields a build can succeed and still never
become a deployable artifact.

| Field | What it says | Where the value comes from |
|---|---|---|
| `runtimeProtocolVersion` | The runner-to-bundle interface generation, `MAJOR.MINOR`. | Constant `1.0`, the only MAJOR so far. |
| `mediaRelayProtocol` | The [media relay](agent-guide/host-protocol.md#media-relay) protocol this build speaks. Additive: a host that does not know it ignores it. | Constant `MEDIA_RELAY_PROTOCOL`. |
| `runtime.node` | The Node major the artifact needs. | The major running the build, because that is the ABI the vendored native prebuilds were selected for. Not the esbuild syntax target. |
| `externals[]` | `{ specifier, version, native }` per unbundlable package. | The version is read from the package the **artifact** resolves, never from a range. `native` is true when a compiled addon exists anywhere in the closure that package resolves. Portable wrappers such as `@livekit/rtc-node` are bundled; their platform-specific binding, `@livekit/rtc-ffi-bindings`, remains external. |
| `requiredSecrets[]` | What the bundle needs injected. | `package.json` → `curb.requiredRuntimeSecrets`; each name becomes `{ required: true, phase: "runtime" }`. Values are never read or copied. An omitted key truthfully declares no required runtime secrets. |
| `requiredCapabilities[]` | What the runner must grant. | Derived. Four are structural to every artifact this builder writes (`realtime.audio`, `provider.llm`, `provider.stt`, `provider.tts`) because the generated worker unconditionally starts a voice session; `integration.mcp` is added when the shipped agent source declares an MCP server. |
| `goals[]` | What counts as a successful call: `{ name, description?, kind: "tool", tool }` or `{ name, description?, kind: "judge", criterion }`. | `defineAgent({ goals })`, sorted by name; `[]` when none. |
| `experiments[]` | The agent's A/B experiments: `{ name, description?, variants: [{ name, weight }], fromClient? }`. A host assigns each call a variant of each and passes it in the start request's `experiments` ([hosting.md](./agent-guide/hosting.md)). | `defineAgent({ experiments })`, experiments and variants sorted by name (the order the assignment walks); `[]` when none. |
| `hooks[]` | The names of the hooks the agent declares, `afterCall` and `afterEvaluation`. A host reads them to know which it may run on a hook runner ([hosting.md](./agent-guide/hosting.md#hook-runner)). | `defineAgent({ afterCall, afterEvaluation })`, sorted; `[]` when none. |

`goals`, `experiments` and `hooks` are values in the agent's module, so every build imports
`src/agent/agent.tsx` (not its skills) to read them, the way `curb check` does, and writes
all three fields in every mode: the render check that loads the agent too does not run with
`--no-verify`, `--no-trace` or `--dependency-layer`. `defineAgent` validates them on import,
so a build fails on goals, experiments or hooks a host would refuse.

The import runs in a child process (`curb build-declarations <projectRoot>`, through the same
CLI shim; `src/bundler/declarations-child.ts`) that prints one `curb-declarations {...}` line
and exits:

- An agent module that leaves a handle open at import (a `setInterval`, a database client at
  module scope) cannot keep `curb build` running. One that has not finished importing after
  30 s is stopped, and the build fails naming the timeout.
- A package Node cannot find by a bare specifier loads as a stub: a value that tolerates any
  property access, call or `new`, exported as `default`, as every name its ES importer imports
  from it, and as `module.exports` for a `require`. A dependency layer never holds the
  externals the bundle leaves to runtime (`sharp`, `onnxruntime-node`, `@livekit/rtc-ffi-bindings`
  behind `curb/orchestration`), so without stubs every hit-mode build of such an agent would
  escape to a full install. The stubs are synchronous module hooks (`module.registerHooks`,
  Node 22.15 and later), the only kind a `require()` inside a dependency goes through; on an
  older Node nothing is stubbed, so such a build escapes (exit 75) and the builder falls back
  to a full install. A missing file of the project's own, or any error its code throws, still
  fails the build.
- In a `--dependency-layer` build, any failure while a stub was loaded is an escape (exit 75,
  `path` the first stubbed package), because the stub may be the cause (an importer needing a
  name it does not export, say a string-named import its pattern cannot read) and a full
  install has the real package. So is a module that is still not found, like one esbuild
  cannot resolve. Only a failure with no stub involved fails a hit-mode build.

`requiredCapabilities` is deliberately never empty. A runner that grants exactly
the declared set and no more would read an empty list as a bundle that cannot
reach a model — a field that lies rather than a field that says "nothing
declared". Two capabilities are **not** declared and their absence is a finding,
not an oversight: `egress.public`, because an agent tool that fetches an
arbitrary URL is an ordinary function the build cannot see, and
`storage.conversation`, because the conversation store is off by default in a
hosted runner. Both need a project-level declaration surface to answer honestly.

### Target and layout

**The target is the build host's own platform.** The builder and the runner
share the host platform, so on a macOS laptop the target is `darwin/arm64`.
There is no cross-target packaging yet; a runner should refuse a bundle whose
`target` differs from its own.

**The layout is a vendored npm tree.** First-party code is bundled and
everything else is vendored, and vendoring means an ordinary `node_modules`
tree resolved by Node's upward walk. That is why the entry sits at
`packages/framework/entry/worker.mjs`: the framework's own package-relative
position is the only one from which the bundle's externals resolve the way they
did in the source tree. A host validating manifest paths should check what is
security-bearing (no absolute path, no `..`, no duplicate, entrypoint and every
asset listed in `files[]`) rather than a fixed top-level directory set.

## What this does NOT prove

Audio has never flowed. The agent is in the room with its pipeline constructed;
nobody has spoken to it. A real conversation needs a browser microphone.

## Reproduce

```bash
docker run -d --rm --name lk -p 7880:7880 -p 7881:7881 \
  livekit/livekit-server --dev --bind 0.0.0.0

cd examples/insurance-agent && curb build
cp -R .curb/standalone/* /tmp/curb-proof/     # somewhere with no node_modules above

cd /tmp/curb-proof
LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
  CURB_AGENT_NAME=curb-proof \
  node packages/framework/entry/worker.mjs start

docker run --rm --network host livekit/livekit-cli:latest dispatch create \
  --url http://127.0.0.1:7880 --api-key devkey --api-secret secret \
  --room proof-room --agent-name curb-proof
```

For the direct-join half, mint a room-scoped token with the framework's own
minting code and hand the artifact nothing else:

```bash
# token: mintToken({url,apiKey:"devkey",apiSecret:"secret"},
#                  {roomName:"curb-proof-room", identity:"curb-agent", agent:true})
cd /tmp/curb-proof
env -i PATH="$PATH" HOME="$HOME" \
  AZURE_SPEECH_KEY=… AZURE_SPEECH_REGION=… KUGELAUDIO_API_KEY=… \
  CURB_REALTIME_URL=ws://127.0.0.1:7880 CURB_REALTIME_TOKEN=<token> \
  CURB_SESSION_ID=sess-proof-1 \
  node packages/framework/entry/worker.mjs
```

`env -i` is the point: no `LIVEKIT_*` variable exists in that process at all, and
the agent still appears in the room (`participant active`, identity
`curb-agent`, grants `RoomJoin: true, Room: curb-proof-room`) in the server's own
log.

