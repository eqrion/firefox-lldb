# Node e2e suite (embedded wasm LLDB)

An e2e suite that drives the **embedded wasm LLDB** (the same path the
`firefox-lldb` command uses) instead of a native lldb. This is the primary
correctness signal.

Run:

```sh
npm run build:fixtures   # once
npm run test:e2e
```

Requires Firefox installed in a standard location (see `findFirefoxBinary` in
`src/rdp/firefox.ts`) and pre-built fixtures.

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

### Infrastructure (no Firefox required)

- `session_smoke.test.mjs` — platform connect, `version`, process state before attach.

### Launch safety (Firefox binary must be present, but none is spawned)

- `launch_port_conflict.test.mjs` — launch refuses an occupied RDP port and rolls Firefox back when the platform port bind fails.

### Channel launch

- `launch_nightly.test.mjs` — when Firefox Nightly is installed, `--nightly` launches it, verifies its RDP endpoint, and cleans it up without hanging.

### Core (call stack, locals, control flow)

- `attach.test.mjs` — attach, breakpoint, DWARF symbols, call stack with JS frames, locals (factorial).
- `locals_args.test.mjs` — call stack + multiple arguments (sum_range).
- `stepping.test.mjs` — instruction stepping (ThreadPlanWasmStep).
- `call_stack_oop.test.mjs` — OOP fixture: call stack, dynamic virtual dispatch.
- `call_stack_parser.test.mjs` — parser fixture: deep call stack, recursive frame names.
- `call_stack_ledger.test.mjs` — ledger fixture: call stack, struct pointer arg, global array.
- `breakpoint_by_line.test.mjs` — source breakpoint by file:line.
- `two_breakpoints.test.mjs` — two breakpoints fire in execution order.
- `step_in_out.test.mjs` — StepOut from callee returns to caller with shallower depth.
- `step_over.test.mjs` — StepOver advances PC without increasing stack depth.
- `multi_step.test.mjs` — five sequential StepInstructions each advance the PC.
- `bp_fires_multiple.test.mjs` — breakpoint in recursive function fires on each level.
- `step_out_recursion.test.mjs` — StepOut from recursive frame matches expected depth.
- `continue_after_step.test.mjs` — step 3x then continue hits the next breakpoint.
- `step_out_to_js.test.mjs` — StepOut of outermost wasm frame reaches a JS caller.
- `loop_variable.test.mjs` — loop variable 'i' becomes visible after stepping into the loop.
- `recursion_depth.test.mjs` — recursive call stack has >= 2 factorial frames.

### Extended (type inspection, JS debugging, threading)

- `inspect_types.test.mjs` — types fixture: integers, floats, pointers, bitfields, structs.
- `expression_pointer_deref.test.mjs` — pointer expressions complete without LLDB internal diagnostics.
- `inspect_heap.test.mjs` — heap fixture: heap-allocated struct/array through pointer.
- `edge_cases.test.mjs` — interleaved JS/wasm frames, watchpoint non-crash.
- `lldb_lifecycle_commands.test.mjs` — detach/re-attach, invalid PID rejection, and remote-platform command survival.
- `source_listing.test.mjs` — wasm and JS frames carry valid file/line DWARF info.
- `sourcemap_source_listing.test.mjs` — source-map DWARF resolves inside the per-session materialization directory.
- `js_debugging.test.mjs` — JS file:line breakpoint fires; step-over advances source line.
- `mixed_js.test.mjs` — mixed JS/wasm: source file discovery (app.js, math.js, math.cpp).
- `threaded.test.mjs` — multithreaded fixture: thread list, matmul_threaded frame, step.
- `threaded_repeated_breakpoint.test.mjs` — repeated pthread workloads survive three breakpoint stop/resume cycles.
- `threaded_worker_breakpoint.test.mjs` — a first-load cross-origin-isolated page stops inside a pthread worker without losing the RDP session.
- `wasm_trap.test.mjs` — wasm traps (divide-by-zero, unreachable, out-of-bounds, call_indirect mismatch) pause as a signal stop; trapping frame is inspectable.
- `mcp.test.mjs` — real MCP launch/command flow, including automatic-attach recovery across an initial page reload and the bounded default wait for a command that does not return a prompt.

### Navigation (survival, re-sync, and ergonomics across a top-level target swap)

- `self_redirect.test.mjs` — uncontrolled self-redirect while paused doesn't crash the session (survival only).
- `nav_driven.test.mjs` — our own `session.navigate()`; buffered breakpoint refires on the new page.
- `nav_link_click.test.mjs` — navigation via a user gesture (`<a href>` click).
- `nav_location_assign.test.mjs` — navigation via the page's own `location.href = ...`.
- `nav_reload.test.mjs` — same-URL `location.reload()`; module bytecode is re-fetched, not served stale.
- `nav_module_unload.test.mjs` — navigating to a different wasm URL unloads the old module from `image list`.

A genuine tab close (as opposed to a navigation) still correctly emits
`detached` — covered at the unit level in `test/unit/session.test.ts`
("target-destroyed-form for top-level target emits 'detached'" and the
process-swap-suppression test next to it), not here: `window.close()` is a
no-op on a tab that wasn't opened by script (Firefox blocks it), and there's
no RDP request to close a tab outright.

## Why one attach per file

Each attach spins up a wasm LLDB worker, an in-wasm gdbstub component, and a
headless Firefox. Each attach-based file performs a single attach in `before()`
and asserts against that one stopped session. The suite runs files concurrently
(default `--test-concurrency=4`; override with `E2E_CONCURRENCY=N`) since each
file gets its own process. Making multiple sequential attaches reliable within
one process is a known follow-up.

Tests that mutate state (step/continue) are the only test in their file. Tests
that only read state from one stopped session can share a `before()` attach.
