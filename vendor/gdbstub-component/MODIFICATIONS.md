# Vendoring & patch maintenance

This crate is vendored from wasmtime `crates/gdbstub-component` (+ the WIT from
`crates/debugger/wit`). We carry a few modifications. Here is every change away
from a clean upstream + jco pipeline, and how it is kept from being clobbered.

## 1. Vendored Rust source edits (committed; never auto-clobbered)

These live in `src/` and `Cargo.toml` and are under version control. `npm run component` only *builds + transpiles* them — it never re-downloads, so they are
safe. They would only need re-applying on a deliberate re-vendor from upstream
wasmtime, which is a manual, rare action. Each edit is commented in place.

- `Cargo.toml` — standalone manifest pinning crates.io dep versions (instead of
  wasmtime's workspace). Upstream uses `version.workspace = true`, etc.
- `src/api.rs` — `wit_bindgen::generate!` path changed `../debugger/wit` -> `wit`
  (we co-locate the WIT). `Resumption` no longer uses the wstd `AsyncPollable`
  reactor (unavailable under jco from gdbstub's synchronous `resume()`):
  `result()` calls `EventFuture::finish`, which blocks
  until the next event (bridged synchronously by the host worker RPC).
- `src/lib.rs` — the Running-state arm drops the wstd `select!` over a wasi
  pollable + the connection; it awaits `resumption.result()` directly. `Debugger`
  now carries per-thread state (`BTreeMap<Tid, ThreadState>`) for multithread support.
- `src/target.rs` — all `Target` trait callbacks that previously ignored `_tid`
  now index `self.threads[&tid]`; `list_active_threads` iterates the full map.
  `get_libraries()` calls `m.name()` instead of `"wasm-{i}"` for real source names.
- `src/addr.rs` — `modules_with_addrs()` pairs each module with its base address.
- `src/diagnostics.rs`, `src/lib.rs` — producer-side bounded tracing retains
  a 1 KiB RSP prefix, full byte count and omitted count without rescanning a
  growing packet. The WIT logger caps formatting at 3 KiB before crossing to
  JavaScript. `Conn` reports incomplete input/output on teardown.
- `src/lib.rs` (library change signal) — `update_on_stop()` now returns `bool`
  (true when new modules were added to `addr_space`). On `Event::Breakpoint`,
  if new modules appeared, the stop reply uses `MultiThreadStopReason::Library`
  instead of `SwBreak`, emitting `library:;` in the T packet so LLDB re-reads
  `qXfer:libraries` and loads the newly registered synthetic JS modules.
- `wit/world.wit`, `src/lib.rs`, and `src/target.rs` (snapped breakpoints) —
  `module.add-breakpoint` returns the effective PC armed by the host. The
  component retains the exact requested-to-armed mapping, uses it to identify
  stops without a distance-based guess, and reports the logical LLDB PC
  consistently through T05, registers, and the innermost wasm call-stack frame.
- `src/addr.rs` — `AddrSpace::update()` now returns `bool` when the module set
  *changes* (added or removed), not just grows — a page navigation drops the
  old page's modules from `all_modules()`, and that needs to surface as a
  library change too. Module storage moved from a dense `Vec` (id = array
  index) to a sparse `BTreeMap<u32, Module>` keyed by a monotonic, never-reused
  id: pruning a dense array's entry would shift every later module's id (and
  with it, its `WasmAddr` and any breakpoints LLDB has bound against that
  address). `lookup()` looks up by id instead of assuming a dense range, so a
  stale `WasmAddr` from before a prune correctly misses instead of aliasing
  whatever now occupies that slot.
- `wit/world.wit` — extended the `debuggee` resource with `list-threads`,
  `stopped-thread`; `exit-frames` and `single-step` now take an explicit `tid: u32`.
  `resource module` gains `name: func() -> string` for source URL basenames.
- `wit/world.wit`, `src/lib.rs` — `debugger-listening(u16)` reports readiness
  explicitly after initial state and socket binding. Run errors trap instead
  of returning as a successful debugger exit.
- `rust-toolchain.toml`, `Cargo.lock` — pin the build toolchain and resolved
  dependencies. CI regenerates the component and checks the resulting artifacts.

To diff against pristine upstream: re-fetch the upstream files and compare, or
keep this list current when editing.

## 2. jco-generated JS patch (regenerated; reapplied by a script)

`jco transpile` regenerates `../../src/gdb/generated/`. Two jco 1.24.3 patches
are applied by `scripts/patch-generated.mjs`: declare `currentSubtask` in
trampoline error paths, and release completed `AsyncSubtask` handles. The script is:

- **idempotent** (skips if already applied),
- **guarded** (errors loudly if jco's output format changes — the anchor it
  inserts after is gone), and
- **wired into `npm run component:transpile`**, so every regeneration reapplies it.

The patched output is also committed, so a fresh checkout runs without rust/jco.

`@bytecodealliance/jco` is pinned in `package.json` and the lockfile; bumping it may move or
fix the bug — re-run `npm run component` and the guard will tell you if the anchor
changed.

## 3. Not patches (our own committed source)

Fixes like `src/gdb/worker/component-worker.mjs` attaching `.payload` to thrown
errors (so jco lifts them as WIT `result` Err) are in our own source, not
generated or vendored-from-upstream — normal version control.

## Build

`npm run component` = `cargo build --locked --release --target wasm32-wasip2` then
`jco transpile ... --instantiation async` then `node scripts/patch-generated.mjs`.
Needs `rustup target add wasm32-wasip2`. The transpile is SYNC mode (no
`--async-mode jspi`): the component runs on a worker and blocks synchronously on
the SAB RPC, so debuggee imports are synchronous and no JSPI / Node >=24 is
required.
## Per-thread snapshot and read availability

`debuggee.exit-frames` returns a WIT result. Thread state retains whether its
snapshot is available; register reads reject unavailable snapshots instead of
reporting a fabricated zero PC. Other threads remain inspectable when Firefox
cannot serialize a suspended worker's frames.

Frame instance/parent/PC lookups propagate unavailability instead of unwrapping
fallible WIT results. A target arriving during LLDB inspection can retire the
published stop: register reads validate their live frame, and call-stack replies
are assembled before any address is emitted. The duplicate return-address helper
was removed; it performed the same lookup as the frame-PC helper.

`frame.get-local` reads a single value without requiring every local to be
available. `memory.size-bytes` is fallible, and memory handles are rebound on
each stop so a reload cannot retain the old module's memory. Missing module
bytecode is represented by the existing WIT option, not synthetic wasm bytes.
