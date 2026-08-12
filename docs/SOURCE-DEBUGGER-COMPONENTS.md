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
- `lldb-component.ts` adapts the real wasm-compiled LLDB and its public API.
- `lldb-runtime.ts` owns one isolated LLDB worker, pthread pool, in-process
  channels, and the sockets bridging them to its RSP endpoints.
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
2. **Move raw debuggee ownership into the session (shared-host proof complete).** The
   platform can now lend one physical `RdpWasmSession` to multiple filtered
   gdbstub projections without transferring its lifetime. Extract that into a
   first-class session-owned debuggee host rather than a platform option.
3. **Make module assignment explicit (prototype complete).** Probe components when modules arrive,
   assign one owner, expose foreign frames opaquely, and reject breakpoint
   mutations outside the owner's module set.
4. **Instantiate two LLDB components (prototype complete).** Each gets a separate LLDB worker,
   gdbstub, RSP endpoint, pthread pool, and disjoint module set. Both observe
   the same physical Firefox process.
5. **Synchronize stops and continues (handoff prototype complete).** Arm every observer,
   let one component hold the physical run-control lease, fan out stops, and
   synchronize debugger-internal resume sequences before committing the stop.
6. **Compose the real mixed stack in the TUI (REPL prototype complete).** Merge
   projections by physical frame position and route scopes/evaluation back
   through the selected logical frame's component. The e2e proves the real
   generic REPL over two components; making the production CLI discover and
   instantiate multiple component implementations remains.
7. **Cross-component stepping (step-out prototype complete).** The session can
   step out from B through JavaScript while preserving A's foreign caller.
   Implement step-in ownership handoff, step-over suppression of foreign
   activations, and foreign-breakpoint preemption of an active thread plan.
8. **Worker RPC and failure containment.** Put each component behind a
   `MessagePort`, enforce deadlines/cancellation, and recover from one component
   failing without wedging the target.
9. **Activation-ID hardening.** Add stable physical activation identities to
   the debuggee/RSP/LLDB path for identical-PC recursion, non-top-frame
   step-out, tail calls, exception unwinding, and frame selection across stops.

Stable activation IDs are deliberately not a prerequisite for the two-LLDB
prototype. Stop-scoped IDs built from `(stop, thread, physical frame position,
inline position, component)` are sufficient for the TUI, frame selection,
variables, and the initial cross-component control experiments.

The next milestone is defining step-in, step-over, and breakpoint-preemption
behavior when control crosses an ownership boundary. Step-out established the
required scheduling primitive: each LLDB runtime sequences every physical
resume requested by its active thread plan. The session holds the driver's
resume lease until each observer has either issued its own next continue (and
therefore re-armed its local stop wait) or completed and been started again.
Only the driver's completed source-level plan commits the global stop.

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
