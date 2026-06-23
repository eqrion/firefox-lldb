# firefox-lldb internals

Architecture, protocol details, and implementation notes.

## Architecture

The bridge sits between two protocols:

- **LLDB's GDB remote serial protocol** (RSP, including the wasm extensions) —
  inbound, from the lldb client
- **Firefox Remote Debug Protocol** (RDP) — outbound, to the browser

```
lldb  ──RSP──►  platform server  ──qLaunchGDBServer──►  per-tab GDB server
                                                                │
                                              gdbstub component (Worker thread)
                                                                │  synchronous WIT calls
                                                                ▼
                                                    SharedArrayBuffer RPC (Atomics)
                                                                │
                                                                ▼
                                          main thread: RdpDebuggee → RdpWasmSession ──RDP──► Firefox
```

### Embedded wasm LLDB (`firefox-lldb`)

The `firefox-lldb` command does not spawn a native lldb. It runs the platform
server in-process and drives LLDB compiled to WebAssembly
(`@firefox-devtools/lldb-wasm`) as a real interactive `(lldb)` prompt. Because
the wasm LLDB cannot open TCP sockets, each RSP connection it would normally make
(the platform connection and every per-tab GDB server) is bridged through an
in-memory channel: LLDB connects to `inprocess://<channelId>` and `firefox-lldb`
pumps bytes between that channel and a localhost socket to the in-process server.

```
wasm LLDB (Worker)  ──inprocess://N──►  channel N  ◄──pump──►  net.Socket  ──►  platform / per-tab server (same process)
```

This requires the wasm LLDB to select the `wasm` platform (`platform select
wasm`), which routes `platform connect` through `PlatformWasmRemoteGDBServer`;
its `MakeUrl` turns the per-tab port returned by `qLaunchGDBServer` into an
`inprocess://` URL. See the package's own docs for the interpreter and transport
internals. The standalone `firefox-lldb-server` + external-lldb path above is
unchanged.

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

## Enabling wasm debugging in Firefox (the `observeWasm` timing problem)

SpiderMonkey only baseline-compiles a wasm module with debug support if the
debugger's `allowUnobservedWasm` is already `false` when the module compiles.
DevTools defaults it to `true`, so observation must be turned on **before the
page's wasm loads**. The working sequence (no Firefox patch needed):

1. `getWatcher` with **`isServerTargetSwitchingEnabled: true`** — so the watcher
   instantiates server-side targets itself and applies thread-config session data
   at target creation (before page scripts run). Without this flag the top-level
   target comes from the legacy `getTarget` path, which never receives the config.
2. `thread-configuration.updateConfiguration({ observeWasm: true, observeAsmJS: true })`
3. `watchTargets("frame")` + `watchResources(["source"])`
4. Navigate; the new target's wasm is debuggable.

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

| Need               | RDP source                                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wasm module list   | `thread.sources` (filter `introductionType === "wasm"`)                                                                                                                                                                                   |
| wasm module bytes  | HTTP fetch of the source URL — the source actor cannot serve wasm binary; lldb reads DWARF from the fetched bytes                                                                                                                         |
| Stack frames       | `thread.frames` returns interleaved `wasmcall`/`call` frames; both are surfaced to LLDB                                                                                                                                                   |
| wasm PC            | a `wasmcall` frame's `where.line` is the byte offset (column is always 1; not column as the original design assumed)                                                                                                                      |
| JS PC              | a `call` frame's `where.line` is the source line (1-based). Reported as `where.line + codeOffset` so LLDB's code-section subtraction recovers the DWARF address = source line.                                                            |
| JS sources         | each JS source is a synthetic wasm module (`src/gdb/synthetic-module.ts`) with DWARF v4 mapping address L → line L. Source text is fetched via the source actor `source` request and written to a temp file for `source list`.            |
| Breakpoints (wasm) | `thread.setBreakpoint` at `{ sourceUrl, line: <offset>, column: 1 }` — offset snapped to a valid position from `getBreakpointPositionsCompressed`; an invalid offset is a silent no-op in Firefox                                         |
| Breakpoints (JS)   | same packet; line = source line number (pc - codeOffset), snapped to a valid (line, column) from `getBreakpointPositionsCompressed` on the JS source actor — an unsnapped column binds to nothing and the breakpoint silently never fires |
| Continue / step    | `thread.resume()` / `thread.resume({type:"step"})` for wasm frames, `{type:"next"}` for a JS innermost frame (one wasm instruction jumps an arbitrary number of JS source lines); stop via the `paused` event                             |
| Locals             | `frame.getEnvironment` → the `wasm function` scope's `var0..varN` bindings (raw i32/i64/f32/f64 values), returned to lldb in wasm-local-index order                                                                                       |
| Linear memory      | evaluate `new Uint8Array(memory0.buffer, addr, len)` in the wasm frame's scope (`evaluateJSAsync` with `frameActor`); `memory0` lives in the `wasm instance` scope                                                                        |
| Globals            | `wasm instance` scope `global0..globalN` bindings → `instance.get-global` / `global.get` → `qWasmGlobal`                                                                                                                                  |

## Testing

- **Unit tests** (`npm test`) — protocol layer and platform server. Run without
  Firefox or a wasm-plugin lldb.
- **e2e suite** (`npm run test:e2e`) — fixture-driven tests via the real bridge
  against headless Firefox. Needs a wasm-plugin lldb build and emsdk-built
  fixtures (`npm run build:fixtures`). Tests: call-stack symbolication across all
  four fixtures; breakpoint by file:line; multiple breakpoints + continue;
  struct inspection through a pointer; dynamic dispatch; StepInstruction,
  StepIn/StepOut, StepOver; locals.

## Vendoring & patches

See `vendor/gdbstub-component/MODIFICATIONS.md`. The vendored Rust edits are
committed source (never auto-clobbered). A single jco-generated patch (a jco
1.24 `currentSubtask` codegen bug) is reapplied idempotently by
`scripts/patch-generated.mjs`, wired into `npm run component:transpile`.

## Multithreading

Firefox exposes each emscripten pthread worker as a separate RDP target with its
own `threadActor`. The session watches both `frame` and `worker` target types. On
each `target-available-form` the session assigns a gdbstub TID (TID 1 = top-level
frame, TID 2+ = workers). All-stop is implemented by the host: when any thread
fires a `paused` event, the host sends `interrupt` to all others and awaits their
acks before emitting a unified `stopped` event to the component.

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
- **Expression evaluation** (`expr` / `p`) is unavailable — it JIT-compiles for
  the target, which wasm has no support for. Inspect variables via the SB value
  API (`frame.FindVariable`, `GetChildMemberWithName`, `Dereference`) which reads
  DWARF + linear memory directly.
- **Stepping across the JS/wasm boundary at step-in** — `thread step-in` from a
  JS frame at a wasm call site does cross the boundary and enter the wasm function.
  The inverse (step-in from wasm into a JS caller) is not supported.
- **JS step-in degrades to step-over within JS** — inside a JS frame, stepping
  uses RDP `{type:"next"}` (step-over by source line), so `thread step-in` cannot
  descend into a called _JS_ function. Single-subprogram synthetic modules can't
  distinguish JS functions anyway (`GetFunctionName()` returns the filename), so
  there is nothing finer to step into. Stepping into a _wasm_ callee from JS does
  work (LLDB's step-in plan overrides the RDP granularity at the boundary).
- **Local/global type inference** is heuristic — RDP reports values as plain JS
  numbers without wasm types. Integer numbers are treated as i32, non-integers as
  f64, bigints as i64.
- **JS locals/variable inspection** — JS frame locals are not yet exposed (returns empty). JS values don't map cleanly to wasm types; deferred to a future phase.
- **Per-function JS names** — each JS source is one synthetic module with a file-level subprogram; `GetFunctionName()` returns the filename. Real per-function names (from the per-frame `displayName` RDP already provides) would need multi-subprogram modules with content-versioned unique ids.
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
