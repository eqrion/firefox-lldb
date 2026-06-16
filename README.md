# firefox-lldb

Debug WebAssembly running inside Firefox with a stock upstream LLDB.

```
(lldb) process connect --plugin wasm connect://127.0.0.1:8123
* thread #1, stop reason = signal SIGTRAP
    frame #0: wasm-0`compute_factorial(n=...) at math.cpp:23
```

## Requirements

- Node.js 20+
- A wasm-plugin lldb build (Apple's `/usr/bin/lldb` lacks the wasm process plugin —
  build from `../llvm-project` with `LLDB_ENABLE_PYTHON=ON`)
- Firefox 120+

## Install

```sh
npm install
```

## Usage

### One-command debug session

`firefox-lldb` launches Firefox, starts the platform server, and drops you into
an interactive lldb prompt already connected to the wasm target:

```sh
LLDB=/path/to/wasm-lldb node --import tsx src/cli/firefox-lldb.ts \
  --launch --url http://localhost:8080/index.html
```

From the lldb prompt:

```
(lldb) breakpoint set -n compute_factorial
(lldb) continue
```

### Manual two-step

Start the platform server separately, then connect lldb by hand:

```sh
# Terminal 1 — launch Firefox + platform server
URL=http://localhost:8080/index.html npm run launch

# Terminal 2 — connect lldb
lldb
(lldb) platform select remote-gdb-server
(lldb) platform connect connect://localhost:1234
(lldb) platform process launch -- http://localhost:8080/index.html
```

Connect to an already-running Firefox instead of launching a new one:

```sh
npm run connect
```

### Flags

| Flag               | Default           | Description                             |
| ------------------ | ----------------- | --------------------------------------- |
| `--port`           | `1234`            | Platform server RSP port                |
| `--rdp-port`       | `6080`            | Firefox RDP port                        |
| `--url`            | —                 | Page to load when lldb spawns a process |
| `--firefox`        | system Firefox    | Path to Firefox binary                  |
| `--headless`       | off               | Run Firefox headlessly                  |
| `--launch`         | (default)         | Launch a fresh Firefox                  |
| `--connect`        | —                 | Connect to an already-running Firefox   |
| `--verbose` / `-v` | off               | Log debug output                        |
| `--lldb`           | `$LLDB` or `lldb` | lldb binary (wrapper only)              |

## What works

| Feature                                              | Status                                  |
| ---------------------------------------------------- | --------------------------------------- |
| Call stack + DWARF symbolication                     | ✅                                      |
| Breakpoints (by name, file:line)                     | ✅                                      |
| Continue, StepInstruction, StepOver, StepIn, StepOut | ✅                                      |
| Locals and globals                                   | ✅                                      |
| Linear memory reads                                  | ✅                                      |
| Struct/pointer inspection via SB API                 | ✅                                      |
| Operand stack (`qWasmStackValue`)                    | ✗ — SpiderMonkey does not expose it yet |
| Expression evaluation (`expr`)                       | ✗ — no wasm JIT backend in lldb         |
| Multithreading                                       | ✗ — gdbstub-component is single-thread  |

## Development

```sh
npm install                          # install dependencies
npm test                             # unit tests
LLVM=/path/to/llvm npm run test:e2e  # e2e suite (needs wasm-plugin lldb + Firefox)
npm run build:fixtures               # rebuild emscripten test fixtures (needs emsdk)
npm run component                    # rebuild the vendored gdbstub-component (needs Rust + jco)
```

See [INTERNALS.md](INTERNALS.md) for architecture, protocol details, and
implementation notes.

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
vendor/              vendored wasmtime gdbstub-component (+ MODIFICATIONS.md)
scripts/             patch-generated.mjs (jco patch), wasm-offsets.mjs
```
