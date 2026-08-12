# firefox-lldb internals

Architecture, protocol details, and implementation notes.

## Architecture

The emerging language-generic architecture is documented in
[`docs/SOURCE-DEBUGGER-COMPONENTS.md`](docs/SOURCE-DEBUGGER-COMPONENTS.md).
The current CLI already places the embedded LLDB behind a
`SourceDebuggerComponent` and exposes core debugging operations through a
`SourceDebuggerSession`; the platform/RSP path described below remains the raw
debuggee transport for the first vertical slice.

The bridge sits between two protocols:

- **LLDB's GDB remote serial protocol** (RSP, including the wasm extensions) —
  inbound, from the lldb client
- **Firefox Remote Debug Protocol** (RDP) — outbound, to the browser

The **primary** entry point is `firefox-lldb`, which embeds LLDB compiled to
WebAssembly behind the language-generic `(sdb)` REPL and runs everything
(session, component runtime, platform server, per-tab GDB server, RDP client)
in a single Node process:

```
REPL (src/cli/repl.ts)
   │  drives
   ▼
wasm LLDB (Worker)  ──RSP over inprocess://──►  attach-shim ──►  per-tab GDB server
                                                                        │
                                                      gdbstub component (Worker thread)
                                                                        │  synchronous WIT calls
                                                                        ▼
                                                            SharedArrayBuffer RPC (Atomics)
                                                                        │
                                                                        ▼
                                                  main thread: RdpDebuggee → RdpWasmSession ──RDP──► Firefox
```

The **secondary** path, `firefox-lldb-server`, runs only the platform + per-tab
servers and listens on a real TCP port for an external native wasm-plugin lldb.
The two paths share everything from the per-tab GDB server inward; they differ
only in how the RSP bytes reach it.

The multi-component prototype creates a separate wasm LLDB worker and filtered
gdbstub/RSP projection for each `SourceDebuggerComponent`, but lends every
projection the same physical `RdpWasmSession`. Only the session-selected driver
may release that shared Firefox run lease. Observer LLDBs still execute their
own state-machine transitions and consume the same stop notification, so an
LLDB-internal step-off cannot race a second RDP controller.

When a Wasm module first appears, `SourceDebuggerSession` resolves its owner
asynchronously. Installed component definitions are probed concurrently and a
unique highest-confidence supported claim wins; ambiguity, no support, or a
probe failure aborts assignment. Ownership remains pinned until unload. The
CLI's explicit URL routes currently narrow this process for multiple identical
LLDB definitions, but the selected definition's probe still runs across the
outer isolation boundary. Raw Wasm remains in the RDP/gdbstub host: it scans
custom-section names once and sends only normalized `dwarf`/`source-map` hints
in the module descriptor. LLDB gives those artifacts stronger claims while
remaining a low-confidence fallback for unrecognized Wasm.

With multiple Firefox threads, an observer may be locally stepping a stale
breakpoint on a worker when a sibling stops the main thread. The debuggee WIT
interface carries an internal `synchronized(tid)` event for this case. The
gdbstub reports a connection-local `SIGSTOP` on the observer plan's thread,
ending that LLDB operation without resuming Firefox or exposing a false user
breakpoint. This is distinct from the abort sentinel: synchronization completes
an observer continue, while the sentinel cancels a real source thread plan
after a sibling preempts it.

For cross-component step-in, the session treats a stop with an unchanged
composed source stack as an opaque-language transition and continues the source
plan. At a JavaScript boundary the active component's run-control policy keeps
RDP instruction-step granularity (instead of the normal JS `next`) so a call
into another owned Wasm module is observable. The destination component adopts
the raw entry trap and completes its prologue before the logical stop is shown.

Every observer also classifies its completed stop before the driver is allowed
to resume again. A real breakpoint owned by an observer preempts the driver's
source thread plan. The aborting LLDB has a private logical breakpoint in an
internal synthetic module; its filtered RSP projection temporarily places that
sentinel above its first owned activation. This gives LLDB a breakpoint it
recognizes, stops the active plan without resuming Firefox, and leaves the
session free to publish the observer's real reason and compose its top frame
over the driver's suspended caller. Without a foreign breakpoint, LLDB's normal
step-over plan suppresses the foreign activation and returns to its next owned
source line. The production e2e keeps a third, module-less LLDB armed throughout
the same sequence to verify that preemption converges every non-owning observer,
not just one driver/observer pair.
Another production e2e combines the pthread fixture with an independent Wasm
module and hands the accepted stop worker → main → worker across two outer LLDB
isolates. The session remembers which component supplied the committed stop so
generic state and thread selection come from the correct projection.
Set `SOURCE_DEBUGGER_TRACE=1` to log only session/runtime barrier transitions
when diagnosing these handoffs, without enabling the full RDP/RSP wire trace.

The CLI presents those adapters to `SourceDebuggerSession` through
`src/source-debugger/rpc.ts`, a concurrent request/response transport over
`MessagePort`. Separate definition and instance ports keep discovery
(`describe`/`probeModule`) independent from target-specific operations; the
third generic port carries the component's imported
`SourceDebuggerComponentHost`. Installed ecosystems enter through
`SourceDebuggerComponentLoader` in two phases. `loadDefinition()` contributes
only discovery exports to `SourceDebuggerComponentCatalog`;
`instantiate(host)` receives a component-scoped binding only after that
definition wins a module. `SourceDebuggerSessionRuntime` constructs the broker
from selected instances, activates their target connections in catalog order,
and tears down the broker, target handles, definitions, and isolates in
dependency order. A stopped module refresh can select a definition which was
not needed at startup. The runtime serializes its instantiation and target
attach with run control, adds its modules, and only then lets the new component
join subsequent observer barriers. The production CLI does not directly create an
LLDB platform server, bridge RSP ports, attach an LLDB process, or retain LLDB
run-control objects. Those operations live in `lldb-loader.ts`, behind the same
lifecycle another installed ecosystem would implement. The LLDB control
channel no longer carries component API or host calls. This exercises
structured cloning and keeps a pending
`waitForStop` from blocking a sibling `abortRun` or `cancelRun` call. The LLDB
adapter, runtime, and nested `lldb-wasm` worker live inside a per-component
outer worker (`lldb-isolate-worker.ts`). A shared `SourceDebuggerSessionHost`
owns opaque one-shot RSP endpoints and every live TCP byte-channel bridge;
sibling bindings cannot consume one another's endpoints, and session shutdown
revokes them all. The LLDB host-side proxy retains only bootstrap state and
Firefox's physical resume closures; the worker returns a refined resume action
and permission to release one. Worker exit closes the
component port, rejects pending calls, and drops unreleased closures so failure
is biased toward leaving Firefox paused. Bounded component calls have a
30-second watchdog (run waits and debugger-native commands are intentionally
unbounded); a timeout is terminal for that RPC connection and tears down its
outer worker. `SourceDebuggerSession` quarantines a component on either timeout
or peer exit, invalidates its logical frames and breakpoint routes, and omits it
from later fan-out barriers. Surviving components remain available for stack
inspection and subsequent runs, while `components` reports the failed route and
its reason.

### Embedded wasm LLDB (`firefox-lldb`)

The `firefox-lldb` command does not spawn a native lldb. It runs the platform
server in-process and drives LLDB compiled to WebAssembly (the `lldb-wasm`
package, built from `../llvm-project/lldb/tools/lldb-wasm`) as an installed
`LldbSourceDebuggerComponentLoader`. Before LLDB exists,
`FirefoxSourceDebuggerTarget` launches/connects Firefox, applies Wasm
observation before navigation, waits briefly for initial modules, inspects
their normalized debug metadata, and establishes the shared physical stop.
The catalog then probes all installed definitions and creates a wasm LLDB
worker only if LLDB owns a module (or is explicitly configured as an eager
compatibility observer). A module loaded later repeats that selection at a
stopped refresh and can add another isolated LLDB without restarting the
session. `SourceDebuggerSessionRuntime` presents selected components through
`SourceDebuggerSession`; LLDB's target adapter owns each
`IsolatedLldbComponentRuntime` and its platform/attach lifecycle. The outer
isolate owns an `EmbeddedLldbComponentRuntime`. Because
the wasm LLDB cannot open TCP sockets, the host opens each RSP connection it
needs (the platform connection and every per-tab GDB server) and transfers a
`MessagePort` byte channel to the outer worker. The worker adapts it to the
pull-based `GdbRspConnection` import; LLDB connects to
`inprocess://<channelId>` and the runtime pumps only ordered bytes between that
resource and its internal channel. TCP, gdbstub, RDP, and physical Firefox
ownership stay outside the debugger isolate.
Platform and per-process ports are registered under opaque endpoint IDs. The
worker obtains each stream by calling its `SourceDebuggerComponentHost` proxy;
it cannot select or connect to an arbitrary host port, nor consume an endpoint
registered for a sibling component. Endpoint and bridge lifetime belongs to the
shared `SourceDebuggerSessionHost`, not the LLDB-specific control channel.

```
wasm LLDB ─► channel N ◄─ GdbRspConnection ─ MessagePort ─► host net.Socket ─► platform / per-tab server
```

This requires the wasm LLDB to select the `wasm` platform (`platform select
wasm`), which routes `platform connect` through `PlatformWasmRemoteGDBServer`;
its `MakeUrl` turns the per-tab port returned by `qLaunchGDBServer` into an
`inprocess://` URL. See the package's own docs for the interpreter and transport
internals.

### REPL (`src/cli/repl.ts`)

The interactive prompt wraps the wasm LLDB. Beyond plumbing input/output it
adds: command history, Ctrl-C to interrupt a running target (routed to
`RdpDebuggee.triggerInterrupt`), an `attach` alias for
`process attach --plugin wasm`, `js` subcommands that answer JS questions over
RDP (the wasm LLDB cannot evaluate JS — see `js p`/`js bt`/`js frame`), and live
streaming of the page's console output. LLDB blocks on synchronous GDB-remote
round-trips, so the REPL drives it through an **off-worker session API**
(`sessionCommand`/`sessionState`/`sessionFrames`/`sessionVariable`) that runs on
a dedicated session pthread, keeping the worker that pumps the bridge free.

### The attach handshake (`src/protocol/attach-shim.ts`)

The gdbstub component presents an already-attached, stopped process the instant
LLDB connects. That satisfies `process connect`, but breaks LLDB's native
`process attach`: `PlatformRemoteGDBServer::Attach` relocates modules at connect
time, then `Process::Attach`'s `ClearAllLoadedSections` wipes that relocation
without reapplying it, so breakpoints never arm. A real lldb-server spawned for
attach is _unattached_ on connect and defers everything to the `vAttach` packet.

The shim emulates that. The component listens on a private OS-assigned port; the
shim fronts the public port and, until it sees `vAttach`, answers the pid-
discovery queries (`?`, `qProcessInfo`, `qC`, `qfThreadInfo`) as "no process
yet" so `ConnectRemote` lands in `eStateConnected` and the real attach happens at
`vAttach`. After forwarding `vAttach` the shim is a transparent byte pipe — no
binary RSP payloads are ever parsed. See the file header for the exact reply
codes and why each one is chosen.

### Layer 1 — platform server (`src/platform/`)

Models the browser as an LLDB platform: tabs are processes, and
`qLaunchGDBServer` spawns a per-tab GDB server. Implements the platform packet
set from `lldbplatformpackets.md`. Reachable directly via `connect://`.

Wire-format note: `triple` and process `name` are hex-encoded on the wire even
though the protocol docs render them plain — verified against
`GDBRemoteCommunicationClient.cpp`.

### Layer 2 — per-tab GDB server, backed by the gdbstub component

The per-tab GDB server is the vendored wasmtime
[gdbstub-component](https://github.com/bytecodealliance/wasmtime/tree/main/crates/gdbstub-component).
It embeds the Rust `gdbstub` state machine, handles all RSP framing and the wasm
extension packets (`qWasmCallStack`/`Local`/`Global`/`StackValue`, breakpoints,
libraries XML, memory-map, host/process info), opens its own TCP listener for
lldb, and **imports a WIT `debuggee` interface that we implement** over RDP.

#### Sync/async bridge (the worker + SAB RPC)

The WIT `debuggee` interface is synchronous, but RDP is async. The solution:

- The component runs on a **Worker thread** (`src/gdb/worker/`). Its WASI poll /
  socket blocking happens on the worker, keeping the main event loop free.
- Each synchronous `debuggee` call is forwarded to the main thread over a
  SharedArrayBuffer (`src/gdb/worker/wire.mjs`). The worker blocks on
  `Atomics.wait`; the main thread services the call asynchronously (RDP
  round-trip) and wakes the worker via `Atomics.notify`.
- JSPI is not needed — the bridge runs on plain Node.

Key modules:

- `src/rdp/transport.ts`, `client.ts` — RDP transport + request/reply/events
- `src/rdp/session.ts` (`RdpWasmSession`) — the validated wasm-debug RDP flow
- `src/gdb/rdp-debuggee.ts` (`RdpDebuggee`) — the WIT `debuggee` impl over RDP
- `src/gdb/worker/host.mjs`, `component-worker.mjs`, `wire.mjs` — the worker +
  SAB RPC bridge

RDP replies are FIFO per actor. Every request has a finite deadline; a timeout
or malformed frame closes the entire RDP connection and rejects all pending
work, because accepting a late reply after abandoning its request would shift
the FIFO and corrupt every later reply on that actor.

### Source maps → DWARF (`src/sourcemap/`)

Wasm modules built with a source map but no embedded DWARF (e.g. some toolchains
that emit only `sourceMappingURL`) are made debuggable by synthesizing DWARF from
the source map at debug time. `RdpDebuggee.#wasmBytecode` fetches a real module's
bytes and runs them through `#maybeConvertSourceMap`:

1. `inspect(bytes)` reports whether the module already `hasDwarf` and its
   `sourceMapUrl`. If it has DWARF, or has no source map, the original bytes are
   used unchanged.
2. The source map is fetched (data: URLs are inlined; otherwise resolved against
   the module URL) and passed to `convert(bytes, mapBytes, compDir)`, which
   returns rewritten wasm carrying synthesized DWARF plus the list of original
   source files.
3. The returned sources are materialized under a per-module temp dir
   (`<basename>.<url-hash>.src`) so `source list` works without collisions;
   `compDir` is the DWARF comp-dir.
   Source names are rewritten to safe relative paths before DWARF conversion,
   and the materializer independently verifies containment before filesystem
   access, since source maps are remote page input.
4. Any failure falls back to the original bytes — source-map support never breaks
   a module that would otherwise load.

The converter is a pure-compute wasm component (no host imports beyond WASI),
vendored as the Rust `source-map-dwarf` crate and its `source-map-dwarf-component`
wrapper, transpiled by jco into `src/sourcemap/generated/`. `src/sourcemap/
converter.ts` instantiates it once on the main thread and exposes `inspect` /
`convert`. This is distinct from the **synthetic modules** above: synthetic
modules represent _JS_ sources LLDB can't otherwise see, while the converter
rewrites a _real wasm_ module to add the DWARF its source map implies.

## Enabling wasm debugging in Firefox (the `observeWasm` timing problem)

SpiderMonkey only baseline-compiles a wasm module with debug support if the
debugger's `allowUnobservedWasm` is already `false` when the module compiles.
DevTools defaults it to `true`, so observation must be turned on **before the
page's wasm loads**. The working sequence (no Firefox patch needed):

1. `getWatcher` with **`isServerTargetSwitchingEnabled: true`** — so the watcher
   instantiates server-side targets itself and applies thread-config session data
   at target creation (before page scripts run). Without this flag the top-level
   target comes from the legacy `getTarget` path, which never receives the config.
2. `thread-configuration.updateConfiguration({ observeWasm: true, observeAsmJS: true, pauseOnExceptions: true, ignoreCaughtExceptions: true })`
3. `watchTargets("frame")` + `watchResources(["source"])`
4. Navigate; the new target's wasm is debuggable.

`pauseOnExceptions` + `ignoreCaughtExceptions` make an **uncaught wasm trap**
(divide-by-zero, unreachable, out-of-bounds, `call_indirect` signature mismatch)
surface as a stop with the trapping frame intact, without pausing on routine
caught JS exceptions. The session reports the RDP `paused` reason via `why.type`;
the host turns a trap pause into a `SIGTRAP`-style signal stop so LLDB shows the
fault and lets you inspect the frame.

## Launching Firefox

```
firefox --headless --no-remote --profile <dir> --start-debugger-server <port> about:blank
```

Required prefs (in the profile): `devtools.debugger.remote-enabled=true`,
`devtools.chrome.enabled=true`, `devtools.debugger.prompt-connection=false`.
RDP transport is length-prefixed JSON (`<byte-length>:<json>`).

## Protocol mapping

### Address encoding (`wasm_addr_t`)

64-bit little-endian: `type[63:62] | module_id[61:32] | offset[31:0]`, where
type `0x00` = linear memory and `0x01` = object (code/data). Each module's code
section is mapped at `(module_id << 32)`.

### Firefox-side RDP surface

See [`docs/RDP-USAGE.md`](docs/RDP-USAGE.md) for the full RDP surface (actors,
requests, events) generated from [`src/rdp/protocol.ts`](src/rdp/protocol.ts),
the single source of truth. The table below maps each debugger need to the
part of that surface serving it.

| Need               | RDP source                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wasm module list   | `thread.sources` (filter `introductionType === "wasm"`)                                                                                                                                                                                                                                                                                                                                                       |
| wasm module bytes  | Use the injectable, validated HTTP provider, then fall back to Firefox's browser-owned ArrayBuffer source actor when Node lacks the page's credentials/cache context. HTTP errors, oversized bodies, and non-wasm responses fall back to an empty module rather than reaching the component.                                                                                                                  |
| Stack frames       | `thread.frames` returns interleaved `wasmcall`/`call` frames; both are surfaced to LLDB. `resources-available-array` records each frame's thread-local source actor → URL mapping, including worker actors.                                                                                                                                                                                                   |
| wasm PC            | a `wasmcall` frame's `where.line` is the byte offset (column is always 1; not column as the original design assumed)                                                                                                                                                                                                                                                                                          |
| JS PC              | a `call` frame's `where.line` is the source line (1-based). Reported as `where.line + codeOffset` so LLDB's code-section subtraction recovers the DWARF address = source line.                                                                                                                                                                                                                                |
| JS sources         | each JS source is a synthetic wasm module (`src/gdb/synthetic-module.ts`) with DWARF v4 mapping address L → line L. Source text is fetched via the source actor `source` request and written to a temp file for `source list`.                                                                                                                                                                                |
| Breakpoints (wasm) | `thread.setBreakpoint` at `{ sourceUrl, line: <offset>, column: 1 }` — offset snapped to a valid position from `getBreakpointPositionsCompressed`; an invalid offset is a silent no-op in Firefox                                                                                                                                                                                                             |
| Breakpoints (JS)   | same packet; line = source line number (pc - codeOffset), snapped to a valid (line, column) from `getBreakpointPositionsCompressed` on the JS source actor — an unsnapped column binds to nothing and the breakpoint silently never fires                                                                                                                                                                     |
| Continue / step    | `thread.resume()` / `thread.resume({type:"step"})` for wasm frames, `{type:"next"}` for a JS innermost frame (one wasm instruction jumps an arbitrary number of JS source lines); a multi-component step-in preserves `step` at an opaque JS boundary to observe foreign Wasm entry; observer breakpoints preempt an active source plan through a private logical abort sentinel; stop via the `paused` event |
| Locals             | `frame.getEnvironment` → the `wasm function` scope's `var0..varN` bindings (raw i32/i64/f32/f64 values), returned to lldb in wasm-local-index order                                                                                                                                                                                                                                                           |
| Linear memory      | evaluate `new Uint8Array(memory0.buffer, addr, len)` in the wasm frame's scope (`evaluateJSAsync` with `frameActor`); `memory0` lives in the `wasm instance` scope                                                                                                                                                                                                                                            |
| Globals            | `wasm instance` scope `global0..globalN` bindings → `instance.get-global` / `global.get` → `qWasmGlobal`                                                                                                                                                                                                                                                                                                      |

## Testing

- **Unit tests** (`npm test`) — protocol layer, platform server, attach-shim,
  SAB-RPC wire codec, synthetic modules, REPL. Run without Firefox or any lldb.
- **e2e suite** (`npm run test:e2e`) — the primary correctness signal. Drives the
  **embedded wasm LLDB** (the same path `firefox-lldb` uses, no native lldb) against
  headless Firefox, through the off-worker session API. Needs only Firefox plus
  emsdk-built fixtures (`npm run build:fixtures`). Files run concurrently
  (`--test-concurrency=4`, override `E2E_CONCURRENCY=N`); each does one attach in
  `before()` (see `test/e2e/README.md` for the per-file convention). Coverage:
  call-stack symbolication across all fixtures, breakpoints by name and file:line,
  multiple breakpoints + continue, struct/pointer/heap inspection, dynamic
  dispatch, every step mode, locals/args/globals, JS-frame debugging, source maps,
  wasm traps, and multithreading.

**Every significant change must land with an e2e test that exercises it.** A
feature or fix the suite doesn't cover is treated as unverified.

## Vendoring & patches

See `vendor/gdbstub-component/MODIFICATIONS.md`. The vendored Rust edits are
committed source (never auto-clobbered). A single jco-generated patch (a jco
1.24 `currentSubtask` codegen bug) is reapplied idempotently by
`scripts/patch-generated.mjs`, wired into `npm run component:transpile`.

The source-map → DWARF converter is vendored as the in-tree Rust crate
`vendor/source-map-dwarf` and its component wrapper
`vendor/source-map-dwarf-component`. `npm run sourcemap` builds and jco-transpiles
it into `src/sourcemap/generated/`; `npm run test:rust` runs the crate's tests.

## Multithreading

Firefox exposes each emscripten pthread worker as a separate RDP target with its
own `threadActor`. The session watches both `frame` and `worker` target types. On
each `target-available-form` the session assigns a gdbstub TID (TID 1 = top-level
frame, TID 2+ = workers). All-stop is implemented by the host: when any thread
fires a `paused` event, the host sends `interrupt` to all others and awaits their
acks before emitting a unified `stopped` event to the component.

Threads and source actors are also scoped to a monotonically increasing
top-level **target generation**. A navigation retires the old generation as one
unit (page plus workers), while the replacement inherits the page's stable LLDB
TID. This handles both destroy-before-available and available-before-destroy RDP
ordering without exposing two page threads or letting late source replies
repopulate actor caches. Pause ownership is explicit session state rather than
being inferred from EventEmitter listener counts, and an all-stop interrupt wait
settles immediately when its target is destroyed.

RDP facts confirmed experimentally:

- `watchTargets("worker")` surfaces emscripten pthread workers as targets.
- `observeWasm` is propagated automatically to all workers via watcher session-data.
- `interrupt` reliably pauses any thread (including idle/Atomics.wait threads) in
  < 10 ms — no timeout strategy needed.
- Breakpoints must be set per-thread actor; the watcher does not broadcast.
- Breakpoints are buffered and replayed to new workers as they arrive.
- The same wasm module URL appears on every thread; modules are deduped by URL
  (one `module_id` slot in the address space, one library-list entry).

## Known limitations

- **Operand stack** (`qWasmStackValue` → empty) — SpiderMonkey does not expose
  the wasm value stack yet.
- **Expression evaluation** (`expr` / `p`) works only for expressions LLDB's IR
  interpreter can fold without running code in the target: arithmetic,
  comparisons, casts, and temp vars over existing variables (`p n + 1`,
  `expr (int)n + 1`, `expr int $x = n * n; $x`). Anything that requires calling a
  function in the target (`expr foo(3)`) JIT-compiles, which wasm has no support
  for, and fails with "Interpreter doesn't handle one of the expression's
  opcodes". Variables can also be inspected via the SB value API
  (`frame.FindVariable`, `GetChildMemberWithName`, `Dereference`), which reads
  DWARF + linear memory directly.
- **Stepping across the JS/wasm boundary at step-in** — `thread step-in` from a
  JS frame at a wasm call site does cross the boundary and enter the wasm function.
  The inverse (step-in from wasm into a JS caller) is not supported.
- **Component-to-component step-in is supported through opaque JS** — the
  language-generic session can step from one owned Wasm module through a JS
  import into another component's Wasm module. This does not expose the
  intervening JavaScript as a source frame; full Wasm-to-JS handoff still needs
  a JavaScript SourceDebuggerComponent.
- **JS step-in degrades to step-over within JS** — inside a JS frame, stepping
  uses RDP `{type:"next"}` (step-over by source line), so `thread step-in` cannot
  descend into a called _JS_ function. Single-subprogram synthetic modules can't
  distinguish JS functions anyway (`GetFunctionName()` returns the filename), so
  there is nothing finer to step into. Stepping into a _wasm_ callee from JS does
  work (LLDB's step-in plan overrides the RDP granularity at the boundary).
- **Local/global type inference** is heuristic — RDP reports values as plain JS
  numbers without wasm types. Integer numbers are treated as i32, non-integers as
  f64, bigints as i64.
- **JS locals/variable inspection through LLDB** — JS values don't map cleanly to
  wasm types, so the synthetic-module DWARF path exposes no JS locals to LLDB
  itself (`frame variable` on a JS frame is empty). Instead, the REPL's `js`
  commands bypass LLDB and query Firefox over RDP directly: `js bt` prints the JS
  backtrace, `js frame <n>` prints a JS frame with its arguments and locals (via
  the frame's `getEnvironment` bindings), and `js p <expr>` evaluates an
  expression in the stopped JS frame's scope (or page scope if not paused).
  Similarly `console on`/`console off` toggle live streaming of the page's
  `console.*` output and uncaught errors. These are REPL features of
  `firefox-lldb` only — they are not available through an external native lldb.
- **Per-function JS names** — each JS source is one synthetic module with one subprogram; the subprogram name is taken from `callee.displayName` of the innermost active JS frame, so the first JS caller correctly shows its function name instead of the filename. Outer JS frames from the same file (which Firefox reports at the same source line, see next bullet) still show the innermost function name. A full fix (distinct name per frame) requires multi-subprogram modules with per-depth unique ids, which needs a Rust change.
- **Duplicate frame IDs for recursive JS frames** — `qWasmCallStack` reports only
  PCs; LLDB's wasm plugin derives `GetFrameID()` from the PC alone (no FP/SP
  equivalent for wasm). Multiple JS frames at the same source line (e.g., a
  recursive call where every frame is at `math.js:725`) all report the same PC →
  LLDB assigns them the same frame ID. Native debugging avoids this because the
  frame pointer distinguishes each call frame even when the PC is identical. The
  clean fix is per-depth virtual module IDs (unique `module_id` per (url, depth)
  in the `WasmAddr`), but that requires a Rust change to register those modules in
  `update_on_stop()` before `frame_to_pc()` runs. Alternatively, fixing LLDB's
  wasm plugin to use the call-stack index rather than the PC as the frame ID would
  solve it upstream.
