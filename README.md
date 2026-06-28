# firefox-lldb

Debug WebAssembly running inside Firefox with LLDB.

The `firefox-lldb` command embeds LLDB compiled to WebAssembly (the `lldb-wasm`
package) and runs it in-process, so no separate lldb binary is required. It
wraps that wasm LLDB in a terminal REPL that adds command history, Ctrl-C to
interrupt a running target, `js` commands that query the page over Firefox's
RDP, and live console output. It only supports the embedded wasm LLDB; to drive
the debugger from your own native wasm-plugin lldb, run the standalone platform
server instead (see [Manual two-step](#manual-two-step)).

```
(lldb) process attach --plugin wasm --pid 1
* thread #1, stop reason = signal SIGTRAP
    frame #0: wasm-0`compute_factorial(n=...) at math.cpp:23
```

## Requirements

- Node.js 20+
- Firefox 120+
- For the manual two-step flow only: a wasm-plugin lldb build (Apple's
  `/usr/bin/lldb` lacks the wasm process plugin — build from `../llvm-project`).
  The bundled `firefox-lldb` command does not need this.

## Install

```sh
npm install
```

## Usage

### One-command debug session

`firefox-lldb` launches Firefox, starts the platform server in-process, and
drops you into an interactive lldb prompt backed by the embedded wasm LLDB. Once
the page loads, it prints a hint above the prompt:

```sh
node --import tsx src/cli/firefox-lldb.ts \
  --launch --url http://localhost:8080/index.html
```

```
tab available: http://localhost:8080/
  attach --pid 1
```

From the lldb prompt (`attach` is aliased to `process attach --plugin wasm`, so
the plugin is supplied for you):

```
(lldb) platform process list        # see open tabs and their PIDs
(lldb) attach --pid <N>             # attach to the wasm tab
(lldb) breakpoint set -n compute_factorial
(lldb) continue
```

Use the up/down arrows for command history, and Ctrl-C to interrupt a running
target (press it again at an empty prompt to quit). The prompt is redrawn after
any asynchronous notice (tab hints, console output) so input is never lost.

#### Inspecting JavaScript (`js`)

The wasm LLDB cannot evaluate JS, so `firefox-lldb` answers JS questions over
RDP through `js` subcommands that run against the attached tab:

```
(lldb) js p document.title          # evaluate a JS expression (in the stopped frame, if any)
(lldb) js bt                        # JS backtrace of the stopped thread
(lldb) js frame 0                   # show a JS frame and its locals
```

#### Console output

Console messages and uncaught errors from the page are streamed to the terminal
as they happen. Type `console off` to mute them and `console on` to resume.

Wasm targets must be driven through LLDB's `wasm` process plugin. If you attach
with the bare `process attach` (no `--plugin wasm`), LLDB falls back to the
generic gdb-remote plugin, which misreads the wasm address space — the session
will not work. The server bounds the bogus reads such a plugin produces so it
fails instead of exhausting memory; run with `-v` to trace the protocol.

### Manual two-step

Start the platform server separately, then connect lldb by hand:

```sh
# Terminal 1 — launch Firefox + platform server
URL=http://localhost:8080/index.html npm run launch

# Terminal 2 — connect lldb
lldb
(lldb) platform select remote-gdb-server
(lldb) platform connect connect://localhost:1234
(lldb) platform process list          # find the tab's PID
(lldb) process attach --plugin wasm --pid <N>   # server pauses the tab automatically
```

(In your own lldb the `attach` alias is not defined, so pass `--plugin wasm`
explicitly.)

Connect to an already-running Firefox instead of launching a new one:

```sh
npm run connect
```

### Flags

| Flag               | Default        | Description                           |
| ------------------ | -------------- | ------------------------------------- |
| `--port`           | `1234`         | Platform server RSP port              |
| `--rdp-port`       | `6080`         | Firefox RDP port                      |
| `--url`            | —              | URL to navigate to on `process attach` (Firefox starts on `about:blank`) |
| `--firefox`        | auto-detected  | Path to Firefox binary                |
| `--headless`       | off            | Run Firefox headlessly                |
| `--launch`         | (default)      | Launch a fresh Firefox                |
| `--connect`        | —              | Connect to an already-running Firefox |
| `--verbose` / `-v` | off            | Log debug output                      |

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
| JS expression eval / backtrace (`js`)                | ✅ — over Firefox RDP                   |
| Live page console output                             | ✅ — streamed to the terminal           |
| Multithreading (pthreads/web workers)                | ✅ — all-stop via per-thread RDP actors |

### Attach time for large modules

Attaching to a large wasm module (e.g. ~30 MB) takes longer than small
ones because Firefox must download the binary and debug-compile it before
the GDB server can start. Typical breakdown on a local server + M-series Mac:

| Phase                                 | Time      |
| ------------------------------------- | --------- |
| Firefox downloads + compiles (30 MB)  | ~15–25 s  |
| GDB server startup + LLDB handshake   | ~3–5 s    |

The server prints `waiting for wasm sources to appear...` during this wait
so you know it has not hung. For faster iteration, build with a smaller
debug binary or serve the wasm from localhost.

## Development

```sh
npm install                          # install dependencies
npm test                             # unit tests
npm run test:e2e                     # e2e suite (needs Firefox)
LLVM=/path/to/llvm npm run test:e2e-python  # deprecated Python e2e (needs wasm-plugin lldb)
npm run build:fixtures               # rebuild emscripten test fixtures (needs emsdk)
npm run component                    # rebuild the vendored gdbstub-component (needs Rust + jco)
```

The embedded LLDB is the `lldb-wasm` package (LLDB compiled to WebAssembly),
built from `../llvm-project/lldb/tools/lldb-wasm`.
To rebuild it after changing the LLVM fork, run `just build-wasm && npm run build`
in that package's directory (needs emsdk), then `npm install` here.

See [INTERNALS.md](INTERNALS.md) for architecture, protocol details, and
implementation notes.

## Repo layout

```
src/protocol/        RSP packet framing, hex, generic TCP server
src/platform/        platform server (process list, qLaunchGDBServer)
src/rdp/             RDP client + RdpWasmSession + headless Firefox launcher
src/gdb/             RdpDebuggee, worker host + SAB RPC, generated/ (jco output)
src/cli/             firefox-lldb-server (platform server), firefox-lldb (embeds wasm LLDB)
test/unit/              unit tests (protocol + platform server)
test/e2e/               Node e2e suite (primary correctness signal)
test/fixtures/          emscripten test fixtures (shared by both e2e suites)
test/e2e-python/        deprecated Python e2e suite
vendor/              vendored wasmtime gdbstub-component (+ MODIFICATIONS.md)
scripts/             patch-generated.mjs (jco patch), wasm-offsets.mjs
```

## Licensing

This project is licensed under the Mozilla Public License, v. 2.0 (see
[LICENSE](LICENSE)).

`vendor/gdbstub-component/` is vendored from
[wasmtime](https://github.com/bytecodealliance/wasmtime) and remains under its
original Apache License 2.0 with LLVM-exception (see
[vendor/gdbstub-component/LICENSE](vendor/gdbstub-component/LICENSE)). Local
changes are documented in
[vendor/gdbstub-component/MODIFICATIONS.md](vendor/gdbstub-component/MODIFICATIONS.md).
The transpiled output under `src/gdb/generated/` is jco-generated from that
component and derives from the same Apache-2.0 source.
