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

| Milestone | State |
|-----------|-------|
| **M1 — platform server** | Done. Full platform packet set; validated live against Apple `lldb-1700` (`platform connect`, process list, `platform shell`, `vFile`). 16 unit tests. |
| **M2 — module loading + call stack** | Done. `qXfer:libraries:read`, module bytes, `qWasmCallStack`; LLDB resolves the wasm stack to source via embedded DWARF. Validated with real lldb against live Firefox. |
| **M3 — breakpoints + continue/step** | Working. `Z0/z0` → `thread.setBreakpoint`; `vCont;c`/`s` → `thread.resume`; stop replies via the RDP `paused` event. |
| **M4 — locals / globals / memory** | Component+protocol plumbing done and validated by the lldb test suite (locals `a=1,b=2` via `qWasmLocal` + linear-memory reads). The **RDP-backed path is still stubbed** (`RdpDebuggee` returns `[]`); next step is wiring it to the RDP environment actor + linear memory. |
| **M5 — operand stack** | Not available (`qWasmStackValue` → empty); SpiderMonkey does not expose the wasm value stack yet. |

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
- `src/cli/wasm-debug.ts` — the bridge entry point (`just bridge`).

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

| Need | RDP source |
|------|-----------|
| wasm module list | `thread.sources` (filter `introductionType === "wasm"`) |
| wasm module bytes | **HTTP fetch of the source URL** — the source actor cannot serve wasm binary; LLDB reads DWARF from the fetched bytes |
| Stack frames | `thread.frames` returns interleaved `wasmcall`/`call` frames |
| wasm PC | a `wasmcall` frame's `where.line` is the byte offset (column is always 1; **not** column as the original design assumed) |
| Breakpoints | `thread.setBreakpoint` at `{ sourceUrl, line: <offset>, column: 1 }` (use the *thread* actor, not the watcher breakpoint-list) |
| Continue / step | `thread.resume()` / `thread.resume({type:"step"})`; stop via the `paused` event |
| Locals / globals | Environment actor (`frame.getEnvironment` bindings) — *to be implemented in `RdpDebuggee`* |
| Linear memory | a new/dedicated RDP read — *to be implemented* |

## Build & run

```sh
just install            # npm install
just test               # unit tests (protocol + platform server)
just component          # (re)build the vendored component + transpile (+patch); needs `rustup target add wasm32-wasip2`
just platform           # run the M1 platform server
just bridge             # run the wasm bridge (connects to Firefox, serves LLDB)
```

`just component` builds `vendor/gdbstub-component` to a `wasm32-wasip2`
component, transpiles it with jco, and applies one post-transpile patch (see
**Vendoring** below). The generated output is committed, so a plain checkout
runs without Rust/jco.

## Testing

Primary strategy (per the original design): run LLDB's own test suites rather
than writing our own.

- **Unit tests** (`npm test`) cover the protocol layer and the platform server.
- **lldb API suite** — build lldb from `../llvm-project` with
  `LLDB_ENABLE_PYTHON=ON` + `LLDB_INCLUDE_TESTS=ON` (needs SWIG). `TestWasm.py`
  (LLVM's wasm spec) passes as a baseline.
- **End-to-end TDD** — `test/lldb/TestRdpBridge.py` is an lldb API test (modeled
  on `TestWasm.py`) that drives a real lldb against our actual gdbstub component,
  backed by a deterministic `FakeDebuggee` (`src/gdb/fake-debuggee.ts`,
  `src/cli/fake-wasm-server.ts`) — no Firefox required, so it is a fast,
  reproducible loop. Symlink it into
  `llvm-project/lldb/test/API/functionalities/gdb_remote_client/` and run:
  ```sh
  build/bin/lldb-dotest -p TestRdpBridge.py <that dir>
  ```
  Passing: wasm call stack + DWARF symbolication, and locals (`a=1`, `b=2`).
- **Live Firefox** — `src/gdb/rdp-integration.ts` (`just integration`) runs the
  full pipeline against a running Firefox and the served `examples/` page.

## Repo layout

```
src/protocol/   RSP packet framing, hex, generic TCP server
src/platform/   M1 platform server (filesystem, process list, qLaunchGDBServer)
src/rdp/        RDP client + RdpWasmSession
src/gdb/        RdpDebuggee, FakeDebuggee, worker host + SAB RPC, generated/ (jco output)
src/cli/        entry points (platform, wasm-debug, fake-wasm-server)
test/lldb/      lldb API test + simple.wasm asset
vendor/         the vendored wasmtime gdbstub-component (+ MODIFICATIONS.md)
scripts/        patch-generated.mjs (post-transpile jco patch)
```

## Vendoring & patches

See `vendor/gdbstub-component/MODIFICATIONS.md`. In short: the vendored Rust
edits are committed source (never auto-clobbered); the single jco-generated
patch (a jco 1.24 `currentSubtask` codegen bug) is reapplied idempotently by
`scripts/patch-generated.mjs`, wired into `just component-transpile`.

## Known limitations

- No multithreading initially (gdbstub-component is single-thread).
- Operand stack (`qWasmStackValue`) unavailable until SpiderMonkey exposes it.
- `RdpDebuggee` locals/globals/memory are stubbed (component side validated via
  the TDD harness; RDP wiring is the next step).
- Interleaved JS/wasm stacks currently surface only wasm frames (the upstream
  component is wasm-centric; a synthetic `[host]` sentinel for JS gaps is a
  possible enhancement).
- The vendored lldb build at `../llvm-project/build` was relocated from an older
  path; it is made to resolve via symlinks (see the project notes).
