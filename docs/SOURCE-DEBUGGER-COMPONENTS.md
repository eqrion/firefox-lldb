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

## TypeScript protocol 0.2

The portable contract is deliberately smaller than a browser debugging API.
It has four surfaces:

| Surface                             | Responsibility                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SourceDebuggerComponentDefinition` | Describe an installed ecosystem and probe normalized module metadata without starting its debugger engine.                                                      |
| `SourceDebuggerComponentHost`       | Import a component-scoped, low-level `WasmDebuggee`. Debugger-engine protocols such as GDB RSP are private component implementation details.                    |
| `SourceDebuggerComponent`           | Accept/revoke owned modules; enumerate sources; inspect stop-scoped state, frames, scopes, and values; manage breakpoints; and begin source run operations.     |
| `SourceDebuggerRun`                 | Represent one armed driver or observer operation, including stop observation, opaque physical-resume permissions, observer rearming, termination, and disposal. |

All boundary records are structured-cloneable data. IDs are opaque strings.
`sourceContent()` is lazy rather than embedding potentially large text in every
source descriptor. An expandable `SourceValue` must have an ID, and
`valueChildren()` is explicitly stop-scoped. The session replaces
component-local source, frame, value, and breakpoint IDs with routed IDs before
returning them to a frontend. A stale frame or value therefore fails locally
instead of accidentally reaching a debugger at a later stop.

Run control is a resource instead of a set of instance methods carrying freely
mixable run IDs and sequence numbers. A component returns a `SourceDebuggerRun`
from `beginRun()`. Physical resume tokens are opaque, scoped to that resource,
and can only be granted on a driver. The session arms every observer first,
then grants the selected driver's token only after the observer barrier is
ready. `terminate("synchronize" | "preempt" | "cancel")` describes intent;
each debugger chooses its own mechanism, such as LLDB's private abort sentinel.

Descriptors, module claims, frames, run resources, stops, and expandable values
have runtime validators in `protocol/validation.ts`. Protocol failures use a
typed `SourceDebuggerError` with stable codes, preserved across worker RPC.
Declared breakpoint/evaluation/stepping capabilities are enforced by the
session rather than treated as documentation.

The remaining deliberate shortcut is physical frame identity. Version 0.2
uses a non-negative, stop-scoped `physicalFrameIndex` for stack composition.
Stable activation IDs are not required for the current two-debugger proof and
remain a hardening item for identical-PC recursion, tail calls, unwinding, and
non-top-frame operations across stops.

## Source organization

The implementation under `src/source-debugger/` mirrors those boundaries:

- `protocol/` is the browser- and transport-neutral public contract, imported
  resource types, errors, target discovery surface, and runtime validation. It
  is published as `firefox-wasm-debugger/protocol`.
- `session/` owns catalog loading, module ownership, component activation, ID
  routing, frame composition, and the driver/observer coordinator.
- `target/` adapts a physical host. `target/firefox/` contains Firefox launch,
  RDP, and the portable raw-Wasm resource implementation; `host.ts` scopes
  imported capabilities without exposing RDP actors to components.
- `transport/` binds the portable interfaces to workers and `MessagePort`.
  Component RPC and imported-resource RPC stay here.
- `components/lldb/` contains the LLDB adapter, worker, loader, and its private
  `platform/`, `rsp/`, and `gdbstub/` stack. It adapts its imported
  `WasmDebuggee` to GDB RSP because that is LLDB's supported Wasm interface;
  neither the session nor component host exposes RSP.
- `components/wasm-text/` contains an independent generated-WAT debugger,
  source generator, worker, and loader. It imports the direct `WasmDebuggee`
  resource and never uses LLDB or RSP.
- `components/run.ts` is a reusable adapter from engine-private numbered resume
  sequences to opaque `SourceDebuggerRun` tokens.

Both production component implementations now run behind the same generic
definition/instance/host worker transport. Firefox RDP appears only in the
Firefox target adapters and in the optional JavaScript REPL extension; the
generic session has no RDP dependency.

The npm package deliberately exposes only the language-generic API at its root
and the narrower `./protocol` subpath. The two executable surfaces are
`firefox-wasm-debugger` and `firefox-wasm-debugger-mcp`; there is no standalone
RSP server product or supported deep-import API.

Component definitions expose `describe()` and `probeModule()` independently of
their target-specific instance API. The installation loader owns
`instantiate(host)`. A probe returns whether it supports a module, a confidence
from 0 through 100, and an optional reason.
The unique highest-confidence supported claim wins. No claims, equal winning
claims, invalid confidence values, and failed probes all stop assignment with
diagnostics; registration order is never a tie-breaker. Each probe has an
independent host-side deadline, so one unresponsive component cannot leave
module refresh pending forever. Once assigned, an owner remains fixed until
that module unloads, including if its component is quarantined. This preserves
the one-owner invariant instead of silently asking a different debugger to
interpret foreign debug information.

The current CLI's `ID=URL_SUBSTRING` syntax is a compatibility constraint for
running several otherwise identical LLDB components. It first selects the one
eligible route, then still calls that component definition's real
`probeModule()` before committing ownership. Explicit routes are eagerly
instantiated so the existing passive-observer/N-component barrier proof stays
intact. Ordinary installed ecosystems are not: Firefox starts, navigates,
reports its module metadata, and reaches a physical stop before the catalog is
probed. Only definitions which own an initial module are then instantiated and
attached. On a later stopped module refresh, a newly selected owner is
instantiated and attached at the current physical stop before the session can
resume; it participates as an observer on the very next run. A real-Firefox
e2e installs an unsupported fake ecosystem alongside LLDB and proves that both
definitions are probed while only LLDB's worker is created. A second e2e loads
a new routed artifact after startup, observes the runtime create a second
isolated LLDB, and stops at that debugger's breakpoint on the next run.
The generated-WAT component provides the first route-free discovery proof
between distinct production ecosystems. LLDB claims `dwarf` and `source-map`
artifacts at higher confidence; `wasm-text` claims modules without source
metadata. The browser target records the selected owner before activation, so
LLDB's filtered `WasmDebuggee` view never silently consumes the WAT-owned image.
The metadata available to probes is currently the module ID, URL, and
host-inspected `dwarf`/`source-map` hints. Raw browser-owned module bytes do not
fan out to candidates. Ecosystems that need to validate custom-section payloads
will eventually need a bounded module-inspection resource or richer normalized
host metadata.

The loader contract now has two phases. `loadDefinition()` returns the small
`describe()`/`probeModule()` discovery surface and must not start the language
debugger. `instantiate(host)` is called only for a selected owner and returns
its definition and instance RPCs plus generic `activate()`/`close()` lifecycle.
The generic isolate transport still creates separate definition, instance, and
imported-host ports for that live engine. The worker receives only its
component-scoped debuggee host proxy. `SourceDebuggerSessionRuntime` owns the
catalog, selected instances, broker, browser target, serialized late
activations, and dependency-ordered teardown. LLDB's catalog definition is pure
TypeScript; its wasm worker is not created until instantiation. Its
loader/runtime privately handle the platform server, attach shim, gdbstub, RSP
connections, native setup commands, and physical run-control wiring. A Dart,
.NET, or other
debugger therefore does not need to implement an LLDB-shaped bootstrap,
discovery, or host protocol.

The production CLI now creates one browser-owned
`FirefoxSourceDebuggerTarget`, then passes its catalog and selected loaders to
the generic session runtime. It no longer creates platform servers, registers
RSP bridges, calls LLDB attach commands, handles LLDB run-control objects, or
tracks per-component teardown. The Firefox target establishes one physical
stop before discovery; component-scoped `WasmDebuggee` resources snapshot that
same stop when opened. LLDB-specific details remain in its loader and are
exercised through the same generic activation path as a future ecosystem
integration.

The `firefox-wasm-debugger` CLI now presents a language-generic `(sdb)` prompt. Its core
commands call only `SourceDebuggerSession`:

```text
components
modules
sources
list
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

The first e2e proves the generic API against a real Firefox and embedded LLDB,
including the LLDB component's private gdbstub/RSP stack. A second proof creates
two independent LLDB wasm workers which import filtered `WasmDebuggee`
resources over one shared physical RDP session. Two query-distinguished Wasm
modules are assigned to LLDB-A
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

The imported debuggee side has one concrete TypeScript seam:
`SourceDebuggerComponentHost.openWasmDebuggee()`. It exposes modules and bytes,
breakpointable byte offsets, physical frames, raw frame variables, stop
observation, broker-controlled resume, and a resource-call projection of the
complete Wasm machine model without leaking Firefox actors. A resume-producing
resource call returns a deferred token. The LLDB component can arm gdbstub's
event future immediately, but only `SourceDebuggerSession` can cause the
component to grant the physical resume.

The LLDB isolate owns its platform server, attach shim, gdbstub worker, TCP
sockets, RSP streams, and in-process LLDB channels. Its private
`LldbWasmDebuggeeAdapter` forwards gdbstub's imported resource calls through
`WasmDebuggee` and synthesizes the LLDB-only abort module/frame locally. The
host and Firefox target therefore have no RSP endpoint API and no knowledge of
LLDB's abort sentinel. A Dart, .NET, or generated-WAT component can use the
same imported debuggee without implementing or observing GDB RSP.

`WasmSourceDebuggerComponent` uses `WasmDebuggee` directly to
generate a virtual `wasm-text://…/module.wat`, annotate only the sparse
instruction positions Firefox actually accepts, and export generic frames,
source/function breakpoints, `$localN` values, continue, and instruction
step-in. It shares the physical stop with LLDB but has no private debugger
thread plan, so sibling synchronization and abort are no-ops rather than an
abort-sentinel implementation. It runs in its own worker through the same
generic component and imported-resource RPC as LLDB. Step-over/out remain
follow-up work.

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
   operations. Remove presentation parsing from `components/lldb/component.ts`.
2. **Move raw debuggee ownership into the session (TypeScript prototype complete).** The
   browser can now lend one physical `RdpWasmSession` through multiple filtered
   `WasmDebuggee` resources without transferring its lifetime. Each LLDB
   isolate privately creates its own gdbstub and RSP stack from that import. A
   first-class `SourceDebuggerSessionHost` scopes resources to the selected
   component and revokes them with the logical session. Translating that
   resource boundary to a language-neutral IDL remains.
3. **Make module assignment explicit (definition-first startup complete).**
   Components are probed asynchronously; a unique best claim gets sticky
   ownership, while ties and unsupported modules fail closed. Firefox and its
   initial physical stop now exist before any debugger instance. The catalog
   loads lightweight definitions, probes host-derived `dwarf`/`source-map`
   hints, and instantiates only initial module owners. A later stopped refresh
   now instantiates and attaches a newly selected owner before the next run;
   the real-Firefox proof dynamically adds a second routed Wasm module and
   stops in its newly-created LLDB. Explicit CLI URL routes keep
   otherwise-identical LLDBs eager for compatibility. Route-free LLDB/WAT
   discovery is complete; richer ecosystem metadata remains.
4. **Instantiate two LLDB components (prototype complete).** Each gets a separate LLDB worker,
   private gdbstub/RSP stack, pthread pool, and disjoint module set. Both observe
   the same physical Firefox process.
5. **Synchronize stops and continues (handoff prototype complete).** Arm every observer,
   let one component hold the physical run-control lease, fan out stops, and
   synchronize debugger-internal resume sequences before committing the stop.
6. **Compose the real mixed stack in the TUI (generic CLI activation complete).** Merge
   projections by physical frame position and route scopes/evaluation back
   through the selected logical frame's component. The production CLI accepts
   repeatable `--component ID=URL_SUBSTRING` routes, instantiates an isolated
   wasm LLDB for each through `SourceDebuggerSessionRuntime`, and exposes them
   through the real generic REPL. All Firefox/RSP/attach details now stay in
   the installed LLDB loader. Replacing explicit routes with artifact-driven
   component discovery remains.
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

The independent-component proof adds one DWARF module owned by real wasm LLDB
and one metadata-free module owned by `wasm-text`. With no URL routes, the real
CLI hits a generated-WAT breakpoint while LLDB drives, composes the WAT callee
over the LLDB caller, lists annotated virtual source and raw locals, then
reverses the roles so an LLDB breakpoint preempts a direct-Wasm-driven run.
