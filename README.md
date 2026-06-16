# firefox-lldb

Debug WebAssembly running inside Firefox with a stock upstream LLDB. This bridge
sits between two protocols: LLDB's
[GDB remote serial protocol](https://lldb.llvm.org/resources/lldbgdbremote.html)
(RSP, including the LLDB wasm extensions) and the Firefox
[Remote Debug Protocol](https://firefox-source-docs.mozilla.org/devtools/backend/protocol.html)
(RDP).

It is TypeScript on Node. The RSP/wasm protocol engine is the
[wasmtime gdbstub-component](https://github.com/bytecodealliance/wasmtime/tree/main/crates/gdbstub-component)
(vendored under `vendor/`, transpiled to JS via [jco](https://github.com/bytecodealliance/jco));
we implement its WIT `debuggee` interface on top of RDP.

## Status

End-to-end working and validated against a **real upstream lldb** built from
`../llvm-project` (Apple's `/usr/bin/lldb` has no wasm process plugin):

```
(lldb) process connect --plugin wasm connect://127.0.0.1:8123
* thread #1, stop reason = signal SIGTRAP
    frame #0: wasm-0`compute_factorial(n=...) at math.cpp:23
```

| Milestone                            | State                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1 — platform server**             | Done. Full platform packet set; validated live against Apple `lldb-1700` (`platform connect`, process list, `platform shell`, `vFile`). 16 unit tests.                                                                                                                                                                                                        |
| **M2 — module loading + call stack** | Done. `qXfer:libraries:read`, module bytes, `qWasmCallStack`; LLDB resolves the wasm stack to source via embedded DWARF. Validated with real lldb against live Firefox.                                                                                                                                                                                       |
| **M3 — breakpoints + continue/step** | Done, validated end-to-end in real headless Firefox. `Z0/z0` → `thread.setBreakpoint` (LLDB's DWARF prologue-end offset is snapped to the engine's nearest valid breakpoint position); `vCont;c`/`s` → `thread.resume`; stop replies via the RDP `paused` event. Stepping required a new `ThreadPlanWasmStep` in the lldb wasm plugin — not in upstream lldb. |
| **M4 — locals / globals / memory**   | Done, validated end-to-end in real headless Firefox (`compute_factorial(n=10)` resolves `n`). Locals come from the wasm frame's RDP environment bindings (`var0..varN`); globals from the instance scope (`global0..globalN`); linear memory is read by evaluating `new Uint8Array(memory0.buffer, addr, len)` in the frame's scope.                          |
| **M5 — operand stack**               | Not available (`qWasmStackValue` → empty); SpiderMonkey does not expose the wasm value stack yet.                                                                                                                                                                                                                                                             |

## Architecture

Two layers.

### 1. Platform server (the browser as an LLDB platform)

`src/platform/` — models the browser as an LLDB platform: tabs are processes, a
filesystem backend stands in for the remote host's files, and `qLaunchGDBServer`
spawns a per-tab GDB server. Implements the platform packet set from
`lldbplatformpackets.md`. Reachable directly via `connect://`. (Wire-format note:
`triple` and process `name` are hex-encoded on the wire even though the protocol
docs render them plain — verified against `GDBRemoteCommunicationClient.cpp`.)

### 2. GDB server (per-tab), backed by the gdbstub component over RDP

The per-tab GDB server is the vendored wasmtime gdbstub-component. It embeds the
Rust `gdbstub` state machine, handles all RSP framing and the wasm packets
(`qWasmCallStack`/`Local`/`Global`/`StackValue`, breakpoints, libraries XML,
memory-map, host/process info), opens its own TCP listener for LLDB, and
**imports a WIT `debuggee` interface that we implement** — that is the only part
we write.

Bridging the synchronous WIT `debuggee` to async RDP:

```
LLDB ──RSP──► gdbstub component (Worker thread)
                      │  synchronous debuggee calls
                      ▼
              SharedArrayBuffer RPC (Atomics)
                      │
                      ▼
   main thread: RdpDebuggee → RdpWasmSession ──RDP──► live Firefox
```

- The component runs on a **Worker thread** (`src/gdb/worker/`). Its WASI poll /
  socket blocking happens on the worker, so the main event loop stays free.
- Each synchronous `debuggee` call is forwarded to the main thread over a
  SharedArrayBuffer (the worker blocks on `Atomics.wait`); the main thread
  services it asynchronously (an RDP round-trip) and wakes the worker.
- Because the worker blocks synchronously, the debuggee imports are synchronous
  and **JSPI is not needed** — the bridge runs on plain Node.

Key modules:

- `src/rdp/transport.ts`, `client.ts` — RDP transport + request/reply/events.
- `src/rdp/session.ts` (`RdpWasmSession`) — the validated wasm-debug RDP flow.
- `src/gdb/rdp-debuggee.ts` (`RdpDebuggee`) — the WIT `debuggee` impl over RDP.
- `src/gdb/worker/host.mjs`, `component-worker.mjs`, `wire.mjs` — the worker +
  SAB RPC bridge.
- `src/cli/firefox-lldb-server.ts` — the platform server entry point (`just launch` / `just connect`).

### Enabling wasm debugging in Firefox (the `observeWasm` timing problem)

SpiderMonkey only baseline-compiles a wasm module with debug support if the
debugger's `allowUnobservedWasm` is already `false` when the module compiles.
DevTools defaults it to `true`, so observation must be turned on **before the
page's wasm loads**. The working sequence (no Firefox patch needed):

1. `getWatcher` with **`isServerTargetSwitchingEnabled: true`** — so the watcher
   instantiates server-side targets itself and applies thread-config session
   data at target creation (before page scripts run). Without this flag the
   top-level target comes from the legacy `getTarget` path, which never receives
   the config.
2. `thread-configuration.updateConfiguration({ observeWasm: true, observeAsmJS: true })`.
3. `watchTargets("frame")` + `watchResources(["source"])`.
4. Navigate; the new target's wasm is debuggable.

### Launching Firefox

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

| Need              | RDP source                                                                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wasm module list  | `thread.sources` (filter `introductionType === "wasm"`)                                                                                                                                                                                                                                                        |
| wasm module bytes | **HTTP fetch of the source URL** — the source actor cannot serve wasm binary; LLDB reads DWARF from the fetched bytes                                                                                                                                                                                          |
| Stack frames      | `thread.frames` returns interleaved `wasmcall`/`call` frames                                                                                                                                                                                                                                                   |
| wasm PC           | a `wasmcall` frame's `where.line` is the byte offset (column is always 1; **not** column as the original design assumed)                                                                                                                                                                                       |
| Breakpoints       | `thread.setBreakpoint` at `{ sourceUrl, line: <offset>, column: 1 }` (use the _thread_ actor, not the watcher breakpoint-list). The offset is snapped to a valid position from `getBreakpointPositionsCompressed` — an invalid offset is a silent no-op in Firefox                                             |
| Continue / step   | `thread.resume()` / `thread.resume({type:"step"})`; stop via the `paused` event                                                                                                                                                                                                                                |
| Locals            | `frame.getEnvironment` → the `wasm function` scope's `var0..varN` bindings (raw i32/i64/f32/f64 values), returned to LLDB in wasm-local-index order                                                                                                                                                            |
| Linear memory     | evaluate `new Uint8Array(memory0.buffer, addr, len)` in the wasm frame's scope (`evaluateJSAsync` with `frameActor`); `memory0` lives in the `wasm instance` scope. (`selectedObjectActor`/`_self` can't reach it — pause-pool objects aren't in the target's objectsPool.)                                    |
| Globals           | `wasm instance` scope `global0..globalN` bindings → `instance.get-global` / `global.get` → `qWasmGlobal`. (LLDB only emits `qWasmGlobal` for a DWARF `DW_OP_WASM_location` global op, which emscripten's local frame bases don't generate — validated directly with a raw GDB client; see `just integration`.) |

## Build & run

```sh
just install            # npm install
npm test                # unit tests (protocol + platform server)
just component          # (re)build the vendored component + transpile (+patch); needs `rustup target add wasm32-wasip2`
just launch             # launch Firefox + platform server (LLDB connects manually)
firefox-lldb --launch   # launch server + spawn lldb pre-connected (wrapper)
```

`just component` builds `vendor/gdbstub-component` to a `wasm32-wasip2`
component, transpiles it with jco, and applies one post-transpile patch (see
**Vendoring** below). The generated output is committed, so a plain checkout
runs without Rust/jco.

## Testing

Primary strategy (per the original design): run LLDB's own test suites rather
than writing our own.

- **Unit tests** (`npm test`) cover the protocol layer and the platform server.
- **lldb API suite** (`test/e2e/run.py`) — fixture-driven tests run against
  headless Firefox via the real bridge. Needs a wasm-plugin lldb build (from
  `../llvm-project` with `LLDB_ENABLE_PYTHON=ON`).

  Fixtures: `factorial`, `oop` (virtual dispatch), `parser` (recursive descent),
  `ledger` (struct/array state) — in `test/e2e/fixtures/`, rebuilt with
  `just build-fixtures`. Each asserts the wasm call stack resolves to the right
  function + source via embedded DWARF. Offsets are derived with
  `scripts/wasm-offsets.mjs` (Firefox `where.line` = code-section offset + DWARF
  address).

  Behaviour tests: breakpoint by `file:line`; multiple breakpoints +
  continue-to-next (`compute_factorial` → recursive `factorial`); struct
  inspection through a pointer via the SB value API (`ledger` `txn->amount ==
30`); dynamic dispatch (virtual call → concrete override with dispatch site on
  stack); `StepInstruction` (PC advances); `StepIn`→`StepOut` round-trip across a
  call boundary; `StepOver` stays at the same depth; locals + linear memory via
  `FindVariable`.

  ```sh
  just test-lldb
  ```

- **Live Firefox (manual)** — `just integration` (raw GDB client against a live
  Firefox with a wasm page loaded).

## Repo layout

```
src/protocol/        RSP packet framing, hex, generic TCP server
src/platform/        platform server (process list, qLaunchGDBServer)
src/rdp/             RDP client + RdpWasmSession + headless Firefox launcher
src/gdb/             RdpDebuggee, worker host + SAB RPC, generated/ (jco output)
src/cli/             firefox-lldb-server (platform server), firefox-lldb (wrapper)
test/unit/           unit tests (protocol + platform server)
test/e2e/run.py      fixture-driven lldb API test suite
test/e2e/fixtures/   emscripten wasm fixtures (simple/oop/parser/ledger)
test/e2e/integration.ts  raw GDB client pipeline test (manual)
vendor/              vendored wasmtime gdbstub-component (+ MODIFICATIONS.md)
scripts/             patch-generated.mjs (jco patch), wasm-offsets.mjs
```

## Vendoring & patches

See `vendor/gdbstub-component/MODIFICATIONS.md`. In short: the vendored Rust
edits are committed source (never auto-clobbered); the single jco-generated
patch (a jco 1.24 `currentSubtask` codegen bug) is reapplied idempotently by
`scripts/patch-generated.mjs`, wired into `just component-transpile`.

## Known limitations

- No multithreading initially (gdbstub-component is single-thread).
- Operand stack (`qWasmStackValue`) unavailable until SpiderMonkey exposes it.
- Local/global type inference is heuristic: RDP reports the value as a plain JS
  value without its wasm type, so integer numbers are treated as i32 (what lldb
  needs for the frame-base pointer), non-integers as f64, bigints as i64.
- Stepping works via the **SB API** (`thread.StepInstruction`, `StepOver`,
  `StepOut`) but CLI `thread step-in/over/out` does not reach our override
  (the CLI command path in `CommandObjectThread::DoExecute` appears to not
  dispatch to `QueueThreadPlanForStep*` in batch mode — a secondary bug, not
  yet diagnosed). GUI debuggers and DAP adapters use the SB API and work.
  Note: wasmtime's own stepping support uses a completely different approach —
  it debugs the **wasmtime host process** as a native target (`lldb -- wasmtime
run`), not `process connect --plugin wasm`. The wasm RSP extensions and
  `ProcessWasm` plugin were never wired for stepping before our fix.
- Expression evaluation (`expr` / `p`) is unavailable: it JIT-compiles for the
  target, which wasm has no support for. Inspect variables via the SB value API
  (`frame.FindVariable`, `GetChildMemberWithName`, `Dereference`) instead, which
  reads DWARF + linear memory directly.
- Interleaved JS/wasm stacks currently surface only wasm frames (the upstream
  component is wasm-centric; a synthetic `[host]` sentinel for JS gaps is a
  possible enhancement).
- The vendored lldb build at `../llvm-project/build` was relocated from an older
  path; it is made to resolve via symlinks (see the project notes).
