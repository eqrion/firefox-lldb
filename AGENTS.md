# firefox-lldb

Bridge that lets upstream LLDB debug WebAssembly running inside Firefox, via Firefox's Remote Debugging Protocol (RDP). Speaks RSP (GDB remote serial protocol) to LLDB on one side and RDP to Firefox on the other.

## Layout

```
src/protocol/      RSP framing + TCP server
src/platform/      LLDB platform server (process list, qLaunchGDBServer)
src/rdp/           RDP client, RdpWasmSession, headless Firefox launcher
src/gdb/           RdpDebuggee, worker + SAB-RPC, jco-generated gdbstub
src/cli/           CLI entry points (firefox-lldb, firefox-lldb-server)
test/unit/         unit tests (protocol + platform server)
test/e2e/          fixture-driven lldb API suite + raw GDB pipeline test
vendor/            vendored wasmtime gdbstub-component (Rust, wasm32-wasip2)
```

## Requirements

- Node.js 20+
- Firefox 120+ with remote debugging enabled
- emsdk (only for rebuilding test fixtures)
- Rust + jco (only for rebuilding the gdbstub component)

## Development

```sh
npm install               # install deps
npm test                  # unit tests (no external deps)
npm run check             # typecheck + prettier
LLVM=../llvm-project EMSDK=~/src/emsdk npm run test:e2e  # e2e suite
```

### Rebuild the gdbstub component (Rust)

```sh
npm run component         # cargo build --target wasm32-wasip2 + jco transpile + patch
```

### Rebuild test fixtures (emscripten)

```sh
EMSDK=~/src/emsdk npm run build:fixtures
```

## Running a debug session

```sh
# Terminal 1: start Firefox + platform server
URL=http://localhost:8080/index.html npm run launch

# Terminal 2: connect lldb
../llvm-project/build/bin/lldb
(lldb) process connect --plugin wasm connect://127.0.0.1:1234
(lldb) breakpoint set -n compute_factorial
(lldb) continue
```

## What works / doesn't

| Feature                         | Status                                    |
| ------------------------------- | ----------------------------------------- |
| Call stack + DWARF symbols      | done                                      |
| Breakpoints (name, file:line)   | done                                      |
| Continue / step in/over/out     | done (SB API only; CLI step is upstream)  |
| Locals, globals, linear memory  | done                                      |
| Struct/pointer inspection       | done                                      |
| Operand stack (qWasmStackValue) | blocked on SpiderMonkey                   |
| Expression evaluation (expr)    | not supported (no wasm JIT in lldb)       |
| Multithreading                  | done — all-stop via per-thread RDP actors |

## Key gotchas

- **Breakpoint snapping**: LLDB resolves breakpoints to DWARF prologue-end offsets, which may not be valid Firefox breakpoint positions. `RdpWasmSession.setWasmBreakpoint` snaps to the nearest position from `getBreakpointPositionsCompressed`; without this, Firefox silently ignores the breakpoint.
- **observeWasm timing**: must be set in the thread configuration before the wasm module loads.
- **Memory reads**: done via frame-scoped `evaluateJSAsync` (`new Uint8Array(memory0.buffer, addr, len)`). The `selectedObjectActor` / `_self` path does not work for pause-pool memory actors.
