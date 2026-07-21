# firefox-lldb

Bridge that lets upstream LLDB debug WebAssembly running inside Firefox, via Firefox's Remote Debugging Protocol (RDP). Speaks RSP (GDB remote serial protocol) to LLDB on one side and RDP to Firefox on the other.

Read INTERNALS.md for a summary of the architecture, and docs/RDP-USAGE.md for
the full Firefox RDP surface this tool depends on.

## Layout

```
src/protocol/      RSP framing + TCP server + attach-shim
src/platform/      LLDB platform server (process list, qLaunchGDBServer)
src/rdp/           RDP client, RdpWasmSession, headless Firefox launcher
src/gdb/           RdpDebuggee, worker + SAB-RPC, jco-generated gdbstub
src/sourcemap/     source-map -> DWARF converter (host glue + jco-generated component)
src/core/          shared Firefox + per-tab launcher + platform server bring-up
src/cli/           CLI entry points (firefox-lldb, firefox-lldb-server) + REPL
src/mcp/           MCP server that drives the real REPL for coding agents
test/unit/         unit tests (protocol + platform server)
test/e2e/          Node e2e suite (primary)
test/fixtures/     emscripten test fixtures (shared by both e2e suites)
test/e2e-python/   deprecated Python e2e suite
vendor/            vendored gdbstub-component + source-map-dwarf crate/component (Rust, wasm32-wasip2)
```

## Development

```sh
npm install                    # install deps
npm test                       # unit tests (no external deps)
npm run check                  # typecheck + prettier
npm run test:e2e               # Node e2e suite (primary correctness signal)
```

The Node e2e suite drives the full bridge against headless Firefox using the embedded wasm LLDB — no native lldb required. It runs at concurrency 4 by default; override with `E2E_CONCURRENCY=N`. Unit tests are rarely useful here.

Run `npm run check` before committing.

### Tests are required

**Every significant change must add or update an e2e test** under `test/e2e/`.
The e2e suite is the primary correctness signal — a feature or fix that the
suite doesn't exercise is considered unverified. Add a focused `*.test.mjs`
(see the existing files and `test/e2e/README.md` for the per-file attach
convention), and a new emscripten fixture under `test/fixtures/`
plus a `build:fixture-*` script when an existing fixture can't reproduce the
behavior. Unit tests are for the protocol/platform layers only.

### Rebuild the gdbstub component (Rust)

```sh
npm run component         # cargo build --target wasm32-wasip2 + jco transpile + patch
```

### Rebuild test fixtures (emscripten)

```sh
EMSDK=~/src/emsdk npm run build:fixtures
```

## Running a debug session

The primary path is the embedded wasm LLDB: `firefox-lldb` launches Firefox,
runs the platform server in-process, and drops you into an interactive `(lldb)`
prompt — no native lldb binary involved.

```sh
URL=http://localhost:8080/index.html npm run launch
# then, at the prompt:
(lldb) attach --pid 1          # alias for: process attach --plugin wasm --pid 1
(lldb) breakpoint set -n compute_factorial
(lldb) continue
```

## Driving the REPL from a coding agent

`src/mcp/server.ts` is an MCP server that pty-spawns the real CLI and exposes
the `(lldb)` REPL as tools (`lldb_launch`/`lldb_send`/`lldb_interrupt`/...), so
an agent can do manual QA against a real Firefox the way a user would. Page
automation comes from firefox-devtools-mcp on the same Firefox via Marionette.
See HARNESS.md and `.mcp.json`.

The standalone server + external native lldb is a secondary, manual path (needs
a wasm-plugin lldb build from `../llvm-project`):

```sh
# Terminal 1
URL=http://localhost:8080/index.html npm run launch-server
# Terminal 2
../llvm-project/build/bin/lldb
(lldb) platform select remote-gdb-server
(lldb) platform connect connect://127.0.0.1:1234
(lldb) process attach --plugin wasm --pid 1
```
