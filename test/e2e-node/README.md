# Node e2e suite (embedded wasm LLDB)

An e2e suite that drives the **embedded wasm LLDB** (the same path the
`firefox-lldb` command uses) instead of a native lldb. It mirrors the Python
suite in `../e2e/` but needs no external lldb — everything runs in this Node
process. The Python suite is unchanged and still the reference.

Run:

```sh
# Infrastructure smoke test only (no Firefox needed):
npm run test:e2e-node

# Full suite incl. attach/breakpoint/stepping (needs headless Firefox + fixtures):
npm run build:fixtures   # once
FIREFOX_LLDB_WASM_ATTACH=1 npm run test:e2e-node
```

## How it works

`harness.mjs` exposes a `Session` that:

1. starts the platform server in-process (`startPlatformServer`),
2. creates an `LLDBClient` (wasm LLDB) and bridges its RSP connections to the
   platform / per-tab servers through in-memory channels (the wasm module can't
   open sockets — see `INTERNALS.md`),
3. drives LLDB through the **off-worker session API** (`sessionCommand`,
   `sessionState`, `sessionFrames`, `sessionVariable`), which runs on a dedicated
   session pthread so blocking GDB-remote round-trips don't stall the worker that
   pumps the bridge.

## Tests

- `session_smoke.test.mjs` — no Firefox. The off-worker session + transport
  bridge end-to-end: platform connect, `version`, process state.
- `attach.test.mjs` — attach to a wasm tab, stop at a breakpoint, and verify the
  function/file/line, the call stack (`qWasmCallStack`, with JS frames), and a
  local (`qWasmLocal`).
- `stepping.test.mjs` — instruction stepping (`ThreadPlanWasmStep`).
- `locals_args.test.mjs` — multiple arguments on a second function.

## Why one attach per file + `--test-concurrency=1`

Each attach spins up a wasm LLDB worker, an in-wasm gdbstub component, and a
headless Firefox. Tearing all of that down and standing it up again **within one
process** is currently racy, and running attach tests **concurrently** spawns
competing Firefoxes. So each attach-based file performs a single attach in
`before()` and asserts against that one stopped session, and the suite runs with
`--test-concurrency=1` (each file is a fresh, serial process — the same process
isolation the Python `run.py` relies on). Making multiple sequential attaches
reliable within one process is a known follow-up.
