# firefox-wasm-debugger

Language-generic source debugger for WebAssembly running inside Firefox. A
`SourceDebuggerSession` coordinates isolated debugger components; the current
production components are embedded LLDB and a direct WebAssembly-text debugger.

Read INTERNALS.md for a summary of the architecture, and docs/RDP-USAGE.md for
the full Firefox RDP surface this tool depends on.

## Layout

```
src/source-debugger/protocol/ portable, published SourceDebugger contracts
src/source-debugger/session/  catalog, ownership, routing, mixed-debugger coordinator
src/source-debugger/transport/worker RPC + imported-resource RPC
src/source-debugger/target/firefox/ Firefox target, RDP, and WasmDebuggee adapter
src/source-debugger/components/lldb/ embedded LLDB plus private RSP/platform/gdbstub
src/source-debugger/components/wasm-text/ independent generated-WAT debugger
src/sourcemap/     source-map -> DWARF converter
src/wasm/          debugger-neutral Wasm parsing/synthetic module helpers
src/cli/           firefox-wasm-debugger entry point + generic REPL
src/mcp/           MCP entry point that drives the real CLI
test/unit/         unit tests (protocol + platform server)
test/e2e/          Node e2e suite (primary)
test/fixtures/     emscripten test fixtures
vendor/            vendored gdbstub-component + source-map-dwarf crate/component (Rust, wasm32-wasip2)
```

## Development

```sh
npm install                    # install deps
npm test                       # unit tests (no external deps)
npm run check                  # typecheck + prettier
npm run test:conformance       # real LLDB + Wasm-text public-interface contract
npm run test:e2e               # Node e2e suite (primary correctness signal)
```

The Node e2e suite drives the full bridge against headless Firefox using the embedded wasm LLDB — no native lldb required. It runs at concurrency 4 by default; override with `E2E_CONCURRENCY=N`. Unit tests are rarely useful here.

Language-generic behavior should use the production harness in
`test/e2e/support/source-debugger-session.ts`. The reusable conformance helper
in the same directory must remain independent of LLDB, Firefox, and RSP
internals. The legacy `harness.mjs` path is reserved for LLDB-specific
compatibility checks whose raw structured APIs are intentionally absent from
the portable protocol.

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

The primary path is the embedded wasm LLDB: `firefox-wasm-debugger` launches Firefox,
runs the platform server in-process, and drops you into an interactive `(sdb)`
prompt — no native lldb binary involved.

```sh
URL=http://localhost:8080/index.html npm run launch
# then, at the prompt (generic commands shown):
(sdb) break compute_factorial
(sdb) continue
```

## Driving the REPL from a coding agent

`src/mcp/server.ts` is an MCP server that pty-spawns the real CLI and exposes
the `(sdb)` REPL as tools (`debugger_launch`/`debugger_send`/`debugger_interrupt`/...), so
an agent can do manual QA against a real Firefox the way a user would. Page
automation comes from firefox-devtools-mcp on the same Firefox via Marionette.
See `.mcp.json`.
