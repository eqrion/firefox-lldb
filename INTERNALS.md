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

| Need              | RDP source                                                                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wasm module list  | `thread.sources` (filter `introductionType === "wasm"`)                                                                                                                                                                                                          |
| wasm module bytes | HTTP fetch of the source URL — the source actor cannot serve wasm binary; lldb reads DWARF from the fetched bytes                                                                                                                                                |
| Stack frames      | `thread.frames` returns interleaved `wasmcall`/`call` frames                                                                                                                                                                                                     |
| wasm PC           | a `wasmcall` frame's `where.line` is the byte offset (column is always 1; not column as the original design assumed)                                                                                                                                             |
| Breakpoints       | `thread.setBreakpoint` at `{ sourceUrl, line: <offset>, column: 1 }` (use the thread actor, not the watcher breakpoint-list). The offset is snapped to a valid position from `getBreakpointPositionsCompressed` — an invalid offset is a silent no-op in Firefox |
| Continue / step   | `thread.resume()` / `thread.resume({type:"step"})`; stop via the `paused` event                                                                                                                                                                                  |
| Locals            | `frame.getEnvironment` → the `wasm function` scope's `var0..varN` bindings (raw i32/i64/f32/f64 values), returned to lldb in wasm-local-index order                                                                                                              |
| Linear memory     | evaluate `new Uint8Array(memory0.buffer, addr, len)` in the wasm frame's scope (`evaluateJSAsync` with `frameActor`); `memory0` lives in the `wasm instance` scope                                                                                               |
| Globals           | `wasm instance` scope `global0..globalN` bindings → `instance.get-global` / `global.get` → `qWasmGlobal`                                                                                                                                                         |

## Testing

- **Unit tests** (`npm test`) — protocol layer and platform server. Run without
  Firefox or a wasm-plugin lldb.
- **e2e suite** (`just test-lldb`) — fixture-driven tests via the real bridge
  against headless Firefox. Needs a wasm-plugin lldb build and emsdk-built
  fixtures (`just build-fixtures`). Tests: call-stack symbolication across all
  four fixtures; breakpoint by file:line; multiple breakpoints + continue;
  struct inspection through a pointer; dynamic dispatch; StepInstruction,
  StepIn/StepOut, StepOver; locals.
- **Integration script** (`just integration`) — manual raw GDB client that
  exercises `qWasmLocal`/`qWasmGlobal` and has a `hold` mode for attaching an
  external lldb to a live wasm pause. Useful for one-off protocol experiments.

## Vendoring & patches

See `vendor/gdbstub-component/MODIFICATIONS.md`. The vendored Rust edits are
committed source (never auto-clobbered). A single jco-generated patch (a jco
1.24 `currentSubtask` codegen bug) is reapplied idempotently by
`scripts/patch-generated.mjs`, wired into `just component-transpile`.

## Known limitations

- **Operand stack** (`qWasmStackValue` → empty) — SpiderMonkey does not expose
  the wasm value stack yet.
- **Expression evaluation** (`expr` / `p`) is unavailable — it JIT-compiles for
  the target, which wasm has no support for. Inspect variables via the SB value
  API (`frame.FindVariable`, `GetChildMemberWithName`, `Dereference`) which reads
  DWARF + linear memory directly.
- **Multithreading** is not supported — the gdbstub-component is single-thread.
- **CLI stepping** (`thread step-in/over/out`) does not work; `CommandObjectThread::DoExecute`
  does not dispatch to `QueueThreadPlanForStep*` in batch mode. GUI debuggers and
  DAP adapters use the SB API and work correctly.
- **Local/global type inference** is heuristic — RDP reports values as plain JS
  numbers without wasm types. Integer numbers are treated as i32, non-integers as
  f64, bigints as i64.
- **Interleaved JS/wasm stacks** — only wasm frames surface; the component is
  wasm-centric. A synthetic `[host]` sentinel for JS gaps is a possible
  enhancement.
