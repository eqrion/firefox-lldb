# Source debugger components

The long-term goal is language-generic, mixed JavaScript/WebAssembly source
debugging without implementing every language debugger in Firefox. A
`SourceDebuggerComponent` embeds an existing debugger engine—LLDB, Dart, .NET,
and so on—while a `SourceDebuggerSession` coordinates all components attached
to one browser debug target.

The name "component" describes the isolation and API boundary. The prototype
uses TypeScript interfaces and workers; the wire-friendly types are intended to
be translatable to WebAssembly Component Model interfaces later.

## Invariants

- Exactly one source debugger component owns each Wasm module.
- One component may own several modules.
- Firefox owns physical execution and the raw mixed-language stack.
- A component provides source semantics only for frames in modules it owns.
- The session creates frontend frame IDs. They are scoped to one stop and do
  not depend on LLDB's `SBFrame::GetFrameID()`.
- Components arm as observers before the run-control driver starts an
  operation, preventing fast stops from being missed.
- Core frontend operations use `SourceDebuggerSession`; debugger-native
  commands are an explicit transitional escape hatch.

## Current vertical slice

The first implementation lives under `src/source-debugger/`:

- `types.ts` defines structured-cloneable protocol records and opaque IDs.
- `component.ts` defines the imported/exported component contracts.
- `rsp-byte-channel.ts` adapts host-owned TCP endpoints to transferable RSP
  streams without exposing sockets to debugger isolates.
- `lldb-component.ts` adapts the real wasm-compiled LLDB and its public API.
- `lldb-runtime.ts` owns one isolated LLDB worker, pthread pool, and in-process
  channels, and imports host-supplied RSP byte streams.
- `lldb-isolate.ts` is the host proxy for an outer component worker. The worker
  owns the LLDB adapter, its runtime, and the nested `lldb-wasm` worker; the
  host owns TCP bridges, component proxies, and physical run-lease proxies.
- `rpc.ts` exposes an instance over concurrent request/response calls on a
  `MessagePort`, preserving optional operations, errors, and configurable call
  deadlines.
- `session.ts` composes component frame projections, routes frame/value work,
  owns module assignments and logical breakpoint IDs, invalidates stop-scoped
  handles, and implements the driver/observer run and stop barriers.

The `firefox-lldb` CLI now presents a language-generic `(sdb)` prompt. Its core
commands call only `SourceDebuggerSession`:

```text
components
modules
threads
bt
frame 0
locals
p n + 1
break math.cpp:24
break compute_factorial
breakpoints
continue
step
next
finish
```

When more than one component is present, ambiguous commands accept an explicit
route: `break lldb-b::compute_factorial`, `continue lldb-b`, and
`lldb lldb-b::thread list`. Frame-relative commands (`locals`, `p`, `step`,
`next`, and `finish`) route through the selected logical frame automatically.

Existing LLDB commands continue to work during the migration. `lldb <command>`
makes the debugger-specific escape hatch explicit.

The first e2e proves the generic API against a real Firefox, gdbstub, RSP
transport, and embedded LLDB. A second proof now creates two independent LLDB
wasm workers and filtered RSP/gdbstub projections over one shared physical RDP
debuggee session. Two query-distinguished Wasm modules are assigned to LLDB-A
and LLDB-B; both resolve independent breakpoint 1, observers arm before the
driver releases the shared run lease, stops fan out to both LLDBs, and each
source backtrace excludes opaque foreign activations.

The proof first stops in A, then hands the run-control driver to B. During the
second run, A calls a JavaScript import which enters B, leaving a real
Wasm-B/JavaScript/Wasm-A activation chain stopped at B's breakpoint. The
generic session composes B above A by physical frame position and routes
`n = 6` to LLDB-B and the non-top `n = 7` to LLDB-A. The previous driver also
performs LLDB's internal step-off without stealing the shared physical run
lease. From that mixed stop, a generic `stepOut` runs LLDB-B's complete thread
plan through its many physical instruction stops, returns to JavaScript, and
preserves LLDB-A's suspended Wasm caller. The e2e drives this sequence through
the real `(sdb)` REPL, including component-qualified breakpoints and driver
selection, composed backtraces, frame selection, locals, and `finish`.

The production CLI proof exercises the inverse handoff without a breakpoint in
the destination module. One generic `step` starts in LLDB-A, consumes the
source-transparent stop at the opaque JavaScript import, preserves RDP
instruction stepping instead of stepping over the foreign Wasm call as one JS
line, and discovers LLDB-B's new top frame. LLDB-B then adopts the raw
`SIGTRAP` entry stop with one source step so its prologue and parameters are
materialized before the frontend sees the stop. A real destination breakpoint
is never adopted and therefore preempts this thread plan.

The multithreaded proof combines an emscripten pthread module with a separate
main-thread Wasm module. Two outer-worker LLDB components hand accepted stops
worker → main → worker without deadlock. When a sibling stop catches an
observer locally stepping a stale worker breakpoint, the debuggee interface's
internal `synchronized(tid)` event ends that connection's LLDB operation with a
local `SIGSTOP`; it does not resume Firefox and is classified as synchronization
rather than a user stop. Session state/thread queries follow the component whose
stop was accepted.

Cross-component step-over is now covered in both directions. With no
destination breakpoint, LLDB-A's real `thread step-over` suppresses the opaque
LLDB-B activation and returns at A's next source line with the call result
materialized. If LLDB-B owns a breakpoint encountered during that same plan,
the observer preempts before A can resume again. A private synthetic abort
breakpoint stabilizes LLDB-A at its first owned caller without moving the
physical target; the session then publishes B's real breakpoint and composes
the logical B-over-A backtrace. The abort breakpoint is internal and does not
install a Firefox breakpoint. The production proof also attaches a passive
third LLDB with no owned module. It must converge on the same preempting stop,
which exercises the coordinator as an N-component barrier rather than a
two-party handoff. Every generic call in that proof crosses the outer worker's
`MessagePort` RPC adapter, including concurrent `waitForStop` and abort calls;
the session no longer depends on direct in-realm calls to an LLDB adapter. If
the worker exits, its component port closes and outstanding calls reject. An
unreleased physical resume lease is dropped rather than executed, leaving
Firefox paused while the failure propagates. Bounded component operations also
have an isolation watchdog; timeout closes the RPC client and terminates the
worker. Run waits and debugger-native commands remain unbounded because waiting
for the debuggee is part of their contract.

`SourceDebuggerSession` treats either transport failure as terminal for only
that component. It quarantines the route, invalidates its stop-scoped frames and
logical breakpoint IDs, excludes it from future inspection and run barriers,
and reports the reason through the generic `components` command. Healthy
siblings continue to provide state, stacks, breakpoint operations, and run
control. If a failure happens during a run, the session interrupts/cancels the
surviving debugger plans and advances the stop scope before returning the
failure; a later command can inspect or continue with the remaining components.
Modules keep their original owner rather than being silently reassigned to a
debugger that may interpret their debug information incorrectly.

The imported debuggee side now has a concrete TypeScript seam as well.
`SourceDebuggerComponentHost.connectGdbRsp()` returns an ordered, pull-based
`GdbRspConnection` resource. In the production prototype the outer host opens
localhost platform/per-process sockets, transfers a `MessagePort`, and the
worker adapts it to that resource before handing it to LLDB. Thus LLDB still
gets its required GDB RSP protocol while the isolated component never imports
TCP, Firefox RDP, or Node socket APIs. Endpoint lookup is still wired during
LLDB runtime bootstrap; routing it through the component factory's
`instantiate(host)` call is the remaining API cleanup before a Component Model
translation.

LLDB scopes currently select and materialize frames through the public command
interpreter. The bulk SB wrapper runs on a different wasm pthread, cannot
materialize non-top `DW_OP_WASM_location`, and can leave the next run-control
command unable to acknowledge its resume. This presentation adapter keeps
inspection and run control on the session pthread until lldb-wasm exposes the
corrected structured path. Expression evaluation uses the same temporary
adapter.

## Staged path to two isolated LLDBs

1. **Complete the LLDB source adapter (in progress).** Extend the wasm LLDB SB wrapper with
   structured thread, source, breakpoint-location, scope, and lazy `SBValue`
   operations. Remove presentation parsing from `lldb-component.ts`.
2. **Move raw debuggee ownership into the session (shared-host and RSP-import proofs complete).** The
   platform can now lend one physical `RdpWasmSession` to multiple filtered
   gdbstub projections without transferring its lifetime. TCP stays in the
   outer host and each LLDB isolate imports only a `GdbRspConnection`. Extract
   endpoint creation into the component factory's first-class session-owned
   host rather than the current platform/bootstrap options.
3. **Make module assignment explicit (prototype complete).** Probe components when modules arrive,
   assign one owner, expose foreign frames opaquely, and reject breakpoint
   mutations outside the owner's module set.
4. **Instantiate two LLDB components (prototype complete).** Each gets a separate LLDB worker,
   gdbstub, RSP endpoint, pthread pool, and disjoint module set. Both observe
   the same physical Firefox process.
5. **Synchronize stops and continues (handoff prototype complete).** Arm every observer,
   let one component hold the physical run-control lease, fan out stops, and
   synchronize debugger-internal resume sequences before committing the stop.
6. **Compose the real mixed stack in the TUI (CLI prototype complete).** Merge
   projections by physical frame position and route scopes/evaluation back
   through the selected logical frame's component. The production CLI accepts
   repeatable `--component ID=URL_SUBSTRING` routes, instantiates an isolated
   wasm LLDB for each, and exposes them through the real generic REPL. Replacing
   explicit routes with artifact-driven component discovery remains.
7. **Cross-component stepping (step-in/over/out prototype complete).** The session
   can step into B through opaque JavaScript without a destination breakpoint,
   step over B while suppressing its foreign activation, stop at a real B
   breakpoint encountered during A's active plan, and step out while preserving
   A's foreign caller. A passive third LLDB proves N-component preemption, and
   a pthread-enabled two-component fixture proves driver handoff across
   multiple Firefox threads.
8. **Worker RPC and failure containment (quarantine prototype complete).** The
   production CLI now puts each component adapter and runtime in an outer
   worker, behind a `MessagePort` with structured-cloned records, concurrent
   calls, optional operations, remote errors, and configurable deadlines. Abrupt
   worker exit rejects the remote component and fails closed on physical resume.
   Bounded-call timeouts terminate that isolate; the session quarantines its
   routes and continues with healthy siblings. Automatic component restart and
   breakpoint restoration remain future recovery work.
9. **Activation-ID hardening.** Add stable physical activation identities to
   the debuggee/RSP/LLDB path for identical-PC recursion, non-top-frame
   step-out, tail calls, exception unwinding, and frame selection across stops.

Stable activation IDs are deliberately not a prerequisite for the two-LLDB
prototype. Stop-scoped IDs built from `(stop, thread, physical frame position,
inline position, component)` are sufficient for the TUI, frame selection,
variables, and the initial cross-component control experiments.

Cross-component stepping uses one shared scheduling primitive: each LLDB runtime
sequences every physical resume requested by its active thread plan. The
session holds the driver's resume lease until each observer has either issued
its own next continue (and therefore re-armed its local stop wait) or completed
and been started again. A preempting observer aborts the driver at the already
paused target before the lease can be released. Step-in additionally treats a
semantically unchanged composed source stack as an opaque transition, preserves
instruction granularity through JavaScript, and transfers the next source-plan
phase to a newly entered owner.

The first experiment also exposed a separate wasm LLDB threading hazard: the
bulk SB variable wrapper could leave LLDB's async remote thread unable to
acknowledge the next resume. Keeping component inspection on the public
session-thread command API avoids that race while preserving full LLDB variable
materialization.

## Proof target

The architectural proof is one Firefox tab with two Wasm modules deliberately
assigned to two isolated LLDB components, JavaScript calls between them, and
one `(sdb)` session that can:

- set and hit source breakpoints in either module;
- display one correctly ordered JS/LLDB-A/LLDB-B backtrace;
- inspect values through the selected frame's owning component;
- step in, over, and out across ownership boundaries;
- surface a breakpoint from one component during the other's active step; and
- repeat that sequence with multiple Firefox threads without deadlock.
