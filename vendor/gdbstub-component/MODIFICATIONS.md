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
  `wait()` is a no-op and `result()` calls `EventFuture::finish`, which blocks
  until the next event (bridged synchronously by the host worker RPC).
- `src/lib.rs` — the Running-state arm drops the wstd `select!` over a wasi
  pollable + the connection; it awaits `resumption.result()` directly. `Debugger`
  now carries per-thread state (`BTreeMap<Tid, ThreadState>`) for multithread support.
- `src/target.rs` — all `Target` trait callbacks that previously ignored `_tid`
  now index `self.threads[&tid]`; `list_active_threads` iterates the full map.
  `get_libraries()` calls `m.name()` instead of `"wasm-{i}"` for real source names.
- `src/addr.rs` — `modules_with_addrs()` pairs each module with its base address.
- `src/lib.rs` (RSP tracing) — `Conn` gains a `trace_in: Vec<u8>` field and a
  `log_inbound` method that reconstructs complete `$<body>#<cc>` RSP frames from
  individual bytes and emits them via `log::trace!("<< ...")`. `flush` logs
  `">> ..."` before writing the outbound buffer. Both are gated behind the
  existing `-v` / `env_logger` trace level, matching the platform server's
  `>>` / `<<` convention.
- `src/lib.rs` (library change signal) — `update_on_stop()` now returns `bool`
  (true when new modules were added to `addr_space`). On `Event::Breakpoint`,
  if new modules appeared, the stop reply uses `MultiThreadStopReason::Library`
  instead of `SwBreak`, emitting `library:;` in the T packet so LLDB re-reads
  `qXfer:libraries` and loads the newly registered synthetic JS modules.
- `src/addr.rs` — `AddrSpace::update()` now returns `bool` (true when new
  modules were registered).
- `wit/world.wit` — extended the `debuggee` resource with `list-threads`,
  `stopped-thread`; `exit-frames` and `single-step` now take an explicit `tid: u32`.
  `resource module` gains `name: func() -> string` for source URL basenames.

To diff against pristine upstream: re-fetch the upstream files and compare, or
keep this list current when editing.

## 2. jco-generated JS patch (regenerated; reapplied by a script)

`jco transpile` regenerates `../../src/gdb/generated/` and would clobber any hand
edit. There is exactly one needed patch (a jco 1.24 codegen bug: a bare
`currentSubtask` referenced in trampoline catch blocks, which throws a
`ReferenceError` instead of lifting a WIT `result` Err). It is applied by
`scripts/patch-generated.mjs`, which is:

- **idempotent** (skips if already applied),
- **guarded** (errors loudly if jco's output format changes — the anchor it
  inserts after is gone), and
- **wired into `npm run component:transpile`**, so every regeneration reapplies it.

The patched output is also committed, so a fresh checkout runs without rust/jco.

`@bytecodealliance/jco` is pinned via `package-lock.json`; bumping it may move or
fix the bug — re-run `npm run component` and the guard will tell you if the anchor
changed.

## 3. Not patches (our own committed source)

Fixes like `src/gdb/worker/component-worker.mjs` attaching `.payload` to thrown
errors (so jco lifts them as WIT `result` Err) are in our own source, not
generated or vendored-from-upstream — normal version control.

## Build

`npm run component` = `cargo build --release --target wasm32-wasip2` then
`jco transpile ... --instantiation async` then `node scripts/patch-generated.mjs`.
Needs `rustup target add wasm32-wasip2`. The transpile is SYNC mode (no
`--async-mode jspi`): the component runs on a worker and blocks synchronously on
the SAB RPC, so debuggee imports are synchronous and no JSPI / Node >=24 is
required.
