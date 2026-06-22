# firefox-lldb

Bridge that lets upstream LLDB debug WebAssembly running inside Firefox, via Firefox's Remote Debugging Protocol (RDP). Speaks RSP (GDB remote serial protocol) to LLDB on one side and RDP to Firefox on the other.

Read INTERNALS.md for a summary of the architecture.

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

## Development

```sh
npm install                             # install deps
npm test                                # unit tests (no external deps)
npm run check                           # typecheck + prettier
LLVM=../llvm-project npm run test:e2e  # e2e suite
```

A wasm-plugin lldb is usually available at `../llvm-project/build/bin/lldb`. The e2e suite drives the full bridge between a real lldb and headless Firefox and is the primary correctness signal. Unit tests are rarely useful here.

Run `npm run check` before committing.

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

# Terminal 2: attach lldb
../llvm-project/build/bin/lldb
(lldb) platform select remote-gdb-server
(lldb) platform connect connect://127.0.0.1:1234
(lldb) process attach --plugin wasm --pid 1
(lldb) breakpoint set -n compute_factorial
(lldb) continue
```
