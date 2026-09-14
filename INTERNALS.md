# firefox-lldb internals

This bridge lets upstream LLDB debug wasm running inside Firefox. LLDB speaks
GDB Remote Serial Protocol (RSP); Firefox speaks Remote Debugging Protocol
(RDP). The gdbstub component translates RSP into a synchronous WIT interface,
and the host implements that interface with asynchronous RDP operations.

Read [RDP-USAGE](docs/RDP-USAGE.md) for actor/request shapes and the
[compatibility ledger](docs/COMPATIBILITY.md) for upstream constraints and
workaround removal criteria. This document describes ownership and execution.

## Code map

| Directory          | Owns                                                                            |
| ------------------ | ------------------------------------------------------------------------------- |
| `src/cli/`         | Arguments, REPL/DAP/native-server entry points, user-facing shutdown            |
| `src/lldb/`        | Embedded LLDB channel/TCP bridge and classified automatic attach                |
| `src/core/`        | Browser acquisition, process cleanup, tab inventory, runtime composition        |
| `src/platform/`    | Platform RSP commands and pending/live per-tab server registry                  |
| `src/protocol/`    | RSP framing, TCP listener, pre-attach handshake shim                            |
| `src/rdp/`         | RDP framing/FIFOs, browser discovery, target generations, all-stop, breakpoints |
| `src/gdb/`         | WIT resource/snapshot adapter and worker/SAB boundary                           |
| `src/symbols/`     | Module acquisition, bytecode transforms, source files, separate DWARF registry  |
| `src/sourcemap/`   | Host wrapper and generated source-map/wasm metadata component                   |
| `src/diagnostics/` | Transcript writer, logger contract, bounded RSP/DAP summaries                   |
| `src/mcp/`         | One owned CLI/PTY lifetime and MCP tools that drive it                          |
| `vendor/`          | Rust components, WIT contracts, locked dependencies and toolchains              |

Generated directories are build output. Behavioral fixes belong in Rust/WIT or
the checked-in regeneration scripts, not hand-edited generated JavaScript.

## Follow a command

```text
REPL or upstream lldb-dap
  → embedded wasm LLDB (session/DAP pthread)
  → inprocess channel ↔ EmbeddedLldbBridge ↔ localhost TCP
  → attach shim → gdbstub component (Node worker)
  → synchronous WIT → SharedArrayBuffer RPC
  → RdpDebuggee → RdpWasmSession → actor FIFO → Firefox
```

The platform connection follows the same channel bridge but ends at
`PlatformServer`. Its `qLaunchGDBServer` command creates the per-tab path above.
`firefox-lldb-server` omits embedded LLDB and accepts a native wasm-plugin LLDB
over TCP; everything from the platform/per-tab listeners inward is shared.

[EmbeddedLldbBridge](src/lldb/bridge.ts) owns both ends from channel creation
through destruction. Incoming TCP writes reach LLDB in order; reads pause until
the previous write is accepted. A short write is a failure, not a successful
partial reply. Outgoing queued bytes are bounded. `failed` reports the first
transport failure even while idle; ordinary EOF remains EOF because detach and
failure cannot be distinguished from EOF alone. Cleanup has a deadline, after
which the caller must destroy LLDB to cancel pending channel calls.

The [attach shim](src/protocol/attach-shim.ts) answers process-discovery queries
as unattached until `vAttach`. Without it, LLDB clears connect-time module
relocation during attach. It validates the advertised PID and switches to a
transparent byte pipe after attach. It never invents a process-exit packet.

## Runtime acquisition and shutdown

[startPlatformServer](src/core/platform-session.ts) owns the platform listener,
browser, tab watcher, and [GdbServerSpawner](src/platform/gdb-server-spawner.ts).
The spawner registers a pending entry before invoking the per-tab launcher.
The [launcher](src/core/tab-session.ts) owns rollback until it returns a handle:

1. Connect RDP and establish the initial top-level target.
2. Inspect sources and navigate if wasm observation was not enabled at compile time.
3. Create the WIT adapter and collect a genuine initial stop.
4. Wait for the component's explicit listening notification.
5. Bind the attach shim and publish its port.

Every acquisition checkpoint checks cancellation. Abort closes pending RDP
work and terminates a starting worker; a late bind/result still belongs to the
launcher. Rollback and normal stop use the same resource order: shim, worker,
adapter, RDP session. A failed cleanup remains recorded, including the original
failure when rollback also fails.

Per-entry stop and global shutdown return shared completion promises. Global
shutdown is terminal: no new launch or late port publication is allowed. It
joins pending acquisitions, stops live handles, joins the tab watcher, and
closes the browser. Deadlines report incomplete cleanup; they do not relinquish
ownership. A published worker failure, per-tab RDP disconnect, or launched
browser watcher loss resolves the runtime's `failed` outcome and starts cleanup.
Normal stop marks the handle as stopping before closing its RDP connection.

The CLI owns pending runtime acquisition as well as the returned handle. REPL,
DAP and standalone-server entry points share the same core teardown contract.
Fatal exception/rejection handlers retain the transcript and give that cleanup
a bounded opportunity to finish before exit.

### Browser identity and handoff

[Firefox acquisition](src/core/firefox.ts) creates a temporary profile and
launch token, then verifies the token through RDP. Abort before publication
rolls back the profile and any process already acquired. `--connect` does not
take ownership of an existing browser or profile.

The launcher's PID is not the browser's lifetime. On POSIX,
[process cleanup](src/core/firefox-processes.ts) follows observed descendants
and replacement processes carrying the exact profile and RDP-port arguments.
It checks start times and a quiet interval before removing the profile. Failed
discovery/verification retains the profile and reports failure. This is bounded
process-table verification, not OS containment; Windows retains direct-child
cleanup. Output pipes drain on child `close`, not merely `exit`, with a bound
for inherited pipes. See `launch_handoff.test.mjs` for a real Firefox handoff.

[Browser discovery](src/rdp/browser.ts) uses Firefox `browserId`, not
connection-local actor strings, for tab identity. The attach connection
resolves its own descriptor for that ID and never substitutes a missing tab.
The watcher subscribes before querying, coalesces change bursts, and joins
priming/query work on close. Only `--connect` reconnects an established watcher.

Startup connection retries have one deadline and retry only classified socket
failures. Automatic LLDB attach retries only when a navigation observed after
per-tab initialization invalidated the attempt. Assertions, malformed protocol,
lost identity and cleanup failure are not generic retry conditions.

An unpublished per-tab acquisition may reacquire once if accepted navigation
reaches its five-second deadline with the starting target gone and no replacement.
Ordinary navigation keeps its ten-second budget; the shorter detach grace alone
cannot fail navigation because a replacement may still arrive.
The typed loss must survive successful rollback; a new connection resolves the
same browserId, never whichever tab is now selected. This is not active-session
watcher reconstruction. The frontend retains the original transcript after
recovery, and test output reports the consumed attempt.

## RDP generations and actor FIFOs

[RdpClient](src/rdp/client.ts) correlates ordinary replies FIFO per actor.
`resume` and `interrupt` use event delivery, not ordinary request slots. A
request deadline or malformed frame closes the client and rejects all pending
work; otherwise a late reply could satisfy the wrong request.

An actor-lifetime abort is narrower: it permanently retires that actor,
rejects its pending queue, rejects future requests to it and discards its late
packets. This is safe because connection-local actor IDs are not reused. It is
not a general request-cancellation mechanism for reusable actors. Source,
long-string and ArrayBuffer reads use their generation's lifetime so navigation
does not wait for an old actor's deadline.

[RdpWasmSession](src/rdp/session.ts) owns the live thread table and current
top-level generation. A replacement retires the previous generation whether
Firefox sends destroy-before-available or available-before-destroy. Destroying
an unknown actor also leaves a tombstone, preventing late resurrection. The
top-level LLDB TID stays stable across replacement; its actor and generation do
not. Workers receive their own TIDs and retire with their page generation.

Source caches, symbol acquisition and WIT snapshots carry generation identity.
An asynchronous result checks its owner again before committing. Navigating
retires source directories, pending fetches and module/resource caches. A
navigation completes only after request acceptance and destination readiness;
the previous document's event cannot satisfy the new navigation.
A destination replaced again before its request acknowledgement cannot be
published as a successful navigation either.

Session keeps target and pause state together because a target arrival/removal
changes the same all-stop invariant. Browser discovery, breakpoint reconciliation
and symbol-file ownership are separate components with their own state. Further
splitting the session through callbacks that mutate each other's maps would
obscure that ownership rather than establish a useful boundary.

## Stops, resume and inspection

A [StopOperation](src/rdp/session.ts) owns one execution wait, including its
listeners, cancellation, pause collection and completion. Repeated arming joins
the same operation. A real pause interrupts other live threads; arriving workers
join collection, and destroyed workers cease to participate. Publication requires
every live thread in the generation to be paused. Missing acknowledgements fail
closed with diagnostics, never publish a partial all-stop snapshot.

Each completed stop records its ID, generation, trigger, reason and actual
thread set. Resume/replacement invalidates it immediately. Frame, local, global
and memory reads check that identity before and after asynchronous work.
[RdpDebuggee](src/gdb/rdp-debuggee.ts) owns the WIT handles and the corresponding
per-thread snapshot; it does not reconstruct pause state from event-listener counts.

Resume releases interrupted workers before the thread that triggered the stop.
This preserves pthread synchronization progress. Navigation during a pending
execution wait can force a bounded re-sync stop so LLDB reloads its module list.
Target/source arrivals retain that intent while LLDB is idle; the next
execution wait rearms it. A wasm module announced after the initial empty
library scan schedules another real stop and source query.
The REPL's Ctrl-C calls this real RDP interrupt path. Upstream DAP pause and
running-disconnect remain separate limitations; no DAP-only RDP bypass is added.

### Breakpoints and read results

[RdpBreakpoints](src/rdp/breakpoints.ts) owns desired locations and each target's
applied physical sites. Reconciliation is serialized and revision-checked;
remove-during-replay cannot leave a late installation behind. Multiple desired
locations sharing one physical site keep it installed until its final reference
is removed. Firefox's breakpoint-position tables constrain wasm snapping to the
containing function and JS snapping to executable line/column locations.

Wasm locals/globals use types parsed from the loaded module, not inferred from
JavaScript number values. Reads preserve float width, negative zero and exact
integer grips. Unsafe numeric i64 grips, missing bindings and operand-stack
values are explicitly unavailable. One unavailable local does not hide peers.

Memory handles refer to the primary module's one Emscripten linear memory,
shared by its pthreads. They are rebound on each stop; unrelated module memories
are not aliased into it. Reads select a paused frame in that module. Invalid
lengths, missing memory, failed evaluation or changed stop identity remain errors,
not zeros. Globals use the requesting frame's instance scope. Broader instance
and multi-memory support requires a separately exercised identity contract.

## Symbols and addresses

The wasm address encoding is `type[63:62] | module_id[61:32] | offset[31:0]`.
Linear memory uses type 0; module objects use type 1. Sparse, monotonic module IDs
prevent old addresses from aliasing new modules after navigation. Module names
also include incarnation IDs because LLDB's library diff uses names.

Firefox-loaded module bytes are authoritative. A source actor supplies the
browser's actual bytes, including authenticated/cached loads. HTTP is a bounded
fallback and warns that loaded-module identity cannot be established. Missing
bytes use WIT's absent-bytecode option; the bridge never manufactures an empty
wasm module. Optional symbol enrichment can fall back to the original bytes.

Embedded DWARF takes precedence over wasm names. Hidden custom sections are
renamed at the same encoded length, preserving Firefox's file-relative PCs.
Separate DWARF goes through [DebugFileRegistry](src/symbols/debug-files.ts):
registrations are generation-owned, basename collisions fail explicitly, and
retired/in-flight fetches cannot populate a new owner's cache.

The [source-map component](src/sourcemap/converter.ts) parses module metadata and
converts source maps into appended DWARF. [SourceFiles](src/symbols/source-files.ts)
owns materialized files under per-generation directories, validates containment,
and prevents late writes from recreating retired directories. JS frames use
[synthetic modules](src/symbols/synthetic-module.ts) whose DWARF maps source lines
to addresses; these are distinct from enriched real wasm modules.

## Worker contract and resource limits

The component worker blocks in WIT while the main event loop performs RDP work.
[contract.mjs](src/gdb/worker/contract.mjs) validates method, argument, resource
and sequence envelopes. [wire.mjs](src/gdb/worker/wire.mjs) bounds recursive
metadata and binary allocation. Modeled WIT errors have explicit tags; an
unexpected exception with the same text remains fatal. Resource proxies own
host handles until their final clone is disposed. Worker startup completes only
on the explicit WIT listening callback; information/trace text is not control flow.

Principal bounds are 32 MiB per SAB message, 31 MiB per module, 128 MiB cached
symbol bytecode, 65,536 live host handles, 4,096 modules/desired breakpoints,
16,384 source actors per generation and 1,024 live targets/pending RDP requests.
Source materialization is limited to 4,096 files/64 MiB. Fetch, source-map and
wasm-parser limits apply before expansion. Tombstones are bounded by terminating
the connection when full, not evicting identities that could resurrect stale work.
These are safety budgets, not claims that every workload below them is supported.

## Diagnostics, tests and regeneration

The [transcript](src/diagnostics/session-log.ts) is always on in production and
retained after failure. It handles partial writes, flushes partial stdio lines,
and reports its first I/O failure without recursively logging through itself.
An incomplete transcript is marked as such. Writes are buffered and flushed;
they are not fsync durability guarantees.

RDP records identify connections, request IDs, actors, methods and duration.
State records identify generation, stop, pending work and cleanup stage. The
shared bridge and DAP observer retain bounded packet/operation summaries.
Component traces are bounded before expensive formatting and before crossing
the worker boundary. Debug snapshots observe state without advancing it.
Transcripts can contain sensitive page/source content; review before sharing.

E2E tests drive the production core and bridge against real Firefox and embedded
LLDB. Feature files usually attach once; lifecycle files deliberately repeat
acquisition and teardown. Fault tests hold real replies behind explicit gates.
See the [E2E guide](test/e2e/README.md) and [manual MCP guide](HARNESS.md).

Run `npm test`, `npm run check`, and `npm run test:e2e`. Regenerate with
`npm run component` and `npm run sourcemap`; both use locked Cargo dependencies
and pinned Rust/jco versions. `scripts/build-component.mjs` normalizes source
paths and fixes codegen/linker parallelism; custom Rust flags are rejected.
The converter crates share `vendor/Cargo.toml` and its lockfile so Cargo does
not hash an out-of-workspace dependency's absolute path into crate identities.
The independently vendored gdbstub retains its own workspace and lockfile.
Patches validate expected generated anchors and fail closed. CI regenerates
and checks the diff. Logging replay and complete
debug-session benchmarks live in `scripts/benchmark-logging.mjs` and
`scripts/benchmark-debug-session.mjs`; the latter measures producer work as well
as transcript writes and reports its baseline limitations.
