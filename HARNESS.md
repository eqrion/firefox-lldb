# Agent QA harness

This lets a coding agent drive firefox-lldb's **real REPL** against a real
Firefox, exactly as a human user does, so we can do manual QA and surface real
bugs. Two MCP servers cooperate (see `.mcp.json`):

- **firefox-lldb** (this repo, `src/mcp/server.ts`) — drives the debugger. It
  pty-spawns the actual `firefox-lldb` CLI, so you get the same readline,
  `(lldb)` prompt, `js` subcommands, console streaming, and Ctrl-C a user gets.
- **firefox-devtools** (`firefox-devtools-mcp`) — drives the _page_ over
  Marionette/WebDriver-BiDi: navigate, click, `evaluate_script`, screenshots,
  console, network. It cannot drive LLDB; it complements the debugger.

Both attach to the **same** Firefox: `firefox-lldb` launches Firefox with both
the RDP debugger server and Marionette enabled (`--marionette-port`, default
2828), and `firefox-devtools` `--connect-existing` to that Marionette port.

## Debugger tools (firefox-lldb)

- `lldb_launch { url, headless?, fire? }` — launch Firefox + REPL, attach to the
  wasm process, wait for `(lldb)`. Returns the marionette port to connect the
  page driver to. `fire` runs JS in the page on the first continue, to trigger a
  workload without the page driver (e.g. `"runMatmul()"`). **Call this first.**
- `lldb_send { command, timeoutMs? }` — type one command, get its output. Any
  LLDB command works (`breakpoint set`, `continue`, `thread list`,
  `frame variable`, `disassemble`, `memory read`, ...) plus `js p/bt/frame`.
  `continue` returns when the target next stops; if it keeps running the call
  times out (`prompt=false`) — use `lldb_interrupt`.
- `lldb_interrupt {}` — Ctrl-C a running target, wait for the stop.
- `lldb_read { timeoutMs? }` — drain async output (console messages, tab hints).
- `lldb_shutdown {}` — quit the REPL and tear down Firefox.

## Ordering

1. `lldb_launch { url }` — brings up Firefox + Marionette and attaches.
2. Then use `firefox-devtools` tools; they connect-existing lazily on first use.

Calling a `firefox-devtools` tool before `lldb_launch` has no Firefox to attach
to. Keep one Firefox alive at a time (Marionette uses the fixed port 2828;
override with `FIREFOX_LLDB_MARIONETTE_PORT`).

## QA checklist (burndown items #2, #6–#8)

Run each against a representative fixture (or any real page) and record findings:

- **#6 disassembly + memory** — at a wasm stop: `disassemble`,
  `disassemble --frame`, `memory read &local`, `x/8xw <addr>`. Do the LLDB
  commands work against wasm?
- **#7 threads** — multi-threaded fixture (`threaded`, `runMatmul()`):
  `thread list` — are workers listed? `thread select N` + `bt` — can you see
  paused stacks of other workers? Is a `js workers` command needed?
- **#8 multi-threaded breakpoints** — set a breakpoint in worker code; can it be
  hit by any worker? Confirm the hit reports the right thread.
- **#2 workflows** — exercise large programs, threading, exception handling, and
  JS-PI end to end: set breakpoints, step, inspect locals/heap, drive the page
  via `firefox-devtools` (click/eval) to reach interesting states.

Fixtures live in `test/fixtures/`; serve one with a static server and pass its
URL to `lldb_launch` (`build:fixtures` rebuilds them). For real apps, pass any
URL.
