# Integration contracts and workarounds

This ledger records why integration-specific behavior exists and what evidence
would allow its removal. The runtime Firefox gate currently accepts majors
140–157; the scheduled channel matrix tests beyond that gate. Dependency
versions below describe this checkout, not upstream's latest releases.

Runtime dependencies are pinned to the versions exercised here: lldb-wasm
0.1.8, preview2-shim 0.18.1, node-pty 1.1.0 and MCP SDK 1.29.0. Published
consumers do not inherit this repository's lockfile. Update these pins
deliberately with the relevant E2E and component regeneration checks. Build
inputs use jco 1.24.3, Rust 1.88.0 and committed Cargo lockfiles.

| Contract                                                                                  | Evidence / regression                                                                                                                                                                                            | Removal criterion                                                                                                                |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Enable `observeWasm` before navigation and compilation.                                   | `firefox_compatibility.test.mjs`; thread configuration is installed through the watcher before targets load wasm.                                                                                                | Firefox makes already-compiled wasm fully debuggable without reloading.                                                          |
| Preserve the page's LLDB TID across target replacement, but retire its actor incarnation. | `nav_reload.test.mjs`, `nav_consecutive.test.mjs`; LLDB can continue its breakpoint step-off sequence with the old TID.                                                                                          | The component and LLDB have an exercised exec/thread-retirement protocol.                                                        |
| Navigation requires request acceptance and destination readiness independently.           | `launch_cancellation.test.mjs`, `nav_driven.test.mjs`; Nightly can withhold the `waitForLoad:true` reply.                                                                                                        | A cross-channel regression establishes reliable request-owned load completion, including load-time exceptions.                   |
| Interrupt/resume responses are events, not actor FIFO replies.                            | `session.test.ts`, worker E2E tests; treating acknowledgements as ordinary replies shifts subsequent requests.                                                                                                   | Firefox changes the wire contract and the compatibility matrix validates the replacement.                                        |
| Resume interrupted workers before the thread that triggered all-stop.                     | `threaded_worker_sequence.test.mjs`; otherwise the triggering worker can run into synchronization while peers remain paused.                                                                                     | An exercised Firefox all-thread resume primitive provides equivalent ordering.                                                   |
| An attach shim delays process publication until `vAttach`.                                | `attach.test.mjs`, `lldb_lifecycle_commands.test.mjs`; LLDB clears connect-time module relocation during attach.                                                                                                 | LLDB/component attach works directly with equivalent module and breakpoint coverage.                                             |
| Firefox launchers can hand off to replacement processes outside the initial group.        | `launch_handoff.test.mjs`, `launch_nightly.test.mjs`; see the incident evidence in `CODEBASE-AUDIT.md`.                                                                                                          | OS containment or a verified Firefox lifecycle contract owns all replacements.                                                   |
| DAP pause/running-disconnect remain explicit limitations in lldb-wasm 0.1.8.              | `dap_pause.test.mjs`, `dap_disconnect_running.test.mjs`; the LLDB async halt path reports a timeout without a usable RSP interrupt.                                                                              | A real DAP request stops the running target through the normal LLDB/RSP path, with no DAP-only RDP escape hatch.                 |
| The component currently cannot read RSP while blocked in `EventFuture.finish`.            | `vendor/gdbstub-component/src/lib.rs` Running state takes the resumption and synchronously calls `result`; `api.rs` calls `finish`. This is a second interrupt-path constraint, independent of LLDB's halt path. | Worker-safe concurrent RSP polling and cancellable execution waits pass interrupt, step, disconnect, and navigation regressions. |
| Two jco 1.24.3 output patches are required.                                               | `component_regeneration.test.mjs`; missing `currentSubtask` and unreleased `AsyncSubtask` handles.                                                                                                               | Regeneration with a replacement jco proves the original failure paths and repeated lifecycle resource counts.                    |
| Hide the wasm name custom section when embedded DWARF is authoritative.                   | `source_listing.test.mjs`; LLDB's imported-function indexing can produce duplicate wrong names.                                                                                                                  | Upstream LLDB resolves the same fixture correctly with both name and DWARF sections retained.                                    |
| URL-less wasm sources are explicitly unsupported.                                         | `anon_module.test.mjs`; Firefox breakpoint addressing and this bridge's module identity require a source URL.                                                                                                    | A stable source identity and breakpoint mechanism support anonymous modules end to end.                                          |

The working REPL interrupt path calls the session's real RDP interrupt operation.
It is not evidence that LLDB's protocol interrupt path works. Keep these two
claims separate when changing execution coordination.

## Missing replacement-target announcement during startup

Two concurrency-four acceptance runs on Firefox 154.0.1 accepted navigation from
`about:blank` to the pthread fixture and destroyed the old target, but delivered
no replacement target to the attach connection. The independent tab-list
connection observed the same `browserId` at the loaded URL with a new browsing
context. The bridge's raw transcript contains no dropped/ignored replacement
event; Firefox's captured output contains no relevant protocol error. The exact
Firefox-side cause remains unproven.

When navigation reaches its deadline after acceptance, with its starting target
gone and no replacement observed, it rejects with `NavigationTargetLostError`.
The 250 ms detach grace is not that deadline: delayed replacements remain valid.
Ordinary navigation keeps its ten-second budget; unpublished startup uses five
seconds to leave room within LLDB's attach deadline for recovery.
The unpublished per-tab transaction rolls back and may
reacquire exactly once, resolving the same `browserId` on a new connection. A
missing tab, protocol error, cancellation or failed rollback is not retryable.
Active debug sessions do not reconstruct their watchers this way.

The bridge does not invent a target from tab-list metadata. The controlled real-Firefox
`navigation_target_loss.test.mjs` checks this failure, listener release, retained
diagnostics and late-event behavior, including a replacement withheld past the
detach grace. It also rejects a late request acceptance
if the ready destination has already been replaced again. `startup_target_recovery`
tests real LLDB attach after reacquisition, the one-retry limit and concurrent
shutdown; `startup_retry_log` verifies all three CLI frontends retain the original
failed-attempt transcript even after successful attach and clean exit.

Before this recovery was added, three subsequent concurrency-four runs of
the failing test plus dynamic workers, consecutive navigation and resource
lifetimes passed (12 cases), without production changes. That is bounded
first-attempt evidence, not proof that the startup flake is fixed.

The first incident transcript is
`/tmp/firefox-lldb-acceptance.d1V4wD/firefox-lldb-20260909-014840-89571-1.log`.
The second is
`/tmp/firefox-lldb-final-validation.e2jJjD/firefox-lldb-20260909-015823-93961-1.log`.
Removal requires a reproducible Firefox-side fix that passes both startup
orderings. Extending recovery to published sessions requires a separate
identity/resource design; the startup retry is not evidence for that behavior.

## Unavailable suspended-worker frames

Firefox can reject `frames` with `TypeError: invalid script offset` for a wasm
worker suspended in a futex wait. The bridge records the affected TID and stop,
returns WIT `invalid-frame`, and keeps other threads inspectable. Register reads
for that thread return a nonfatal RSP error. The gdbstub call-stack extension
cannot represent a per-thread nonfatal error, so it returns no frames for this
explicitly unavailable snapshot. Other frame-request failures are not hidden.
Regression: `test/e2e/threaded_interrupt.test.mjs`.

A target may arrive after a stop was published, invalidating its participating
thread set while LLDB is reading frames. The component treats unavailable frame
instance/PC/parent reads as unavailable rather than unwrapping them. Call stacks
are assembled before callbacks publish any addresses; the extension represents
unavailability as an empty reply, not a partial stack. Register reads validate
the current frame and return a nonfatal error. Regressions:
`frame_unavailable.test.mjs`, `threaded_dynamic.test.mjs`.

## Typed values and memory availability

Firefox's wasm scope bindings carry JavaScript number grips, not wasm value
types. The converter's wasmparser metadata supplies local/global types from
the loaded bytes, preserving f32/f64 widths and negative zero. The component
reads one local at a time so one unavailable value does not hide its peers.
`wasm_value_types.test.mjs` verifies exact replies through LLDB's real packet
command. Firefox currently serializes the i64 value `9007199254740993` as the
rounded number `9007199254740992`; unsafe numeric i64 grips are unavailable,
not reconstructed. Safe integer grips and exact BigInt grips are supported.

The same entry-PC fixture also exposed an LLDB rendering limitation: ordinary
`frame variable` displayed zeros/incorrect values despite correct f32/f64 RSP
bytes. This audit does not modify the external LLDB checkout or claim to fix
that renderer. The raw-packet regression covers the bridge-owned contract;
existing stack-resident variable tests retain their end-user assertions.

Memory handles belong to the current module generation and are rebound at
each stop. The supported model is one Emscripten linear memory for the primary
wasm module, shared by its pthread workers; unrelated module memories are not
aliased into it. Global reads use the requesting frame's instance scope, not
the triggering thread. Missing globals, invalid scopes and failed memory-size
evaluations remain errors (`memory_failure.test.mjs`).

The RDP surface does not expose the wasm operand stack, so its values remain
unavailable. Missing module bytes use the WIT absent-bytecode option and produce
failed object-memory reads, not a fabricated empty wasm header
(`protocol_boundaries.test.mjs`).

## Actor retirement and cancellation

A source actor, long-string actor or ArrayBuffer actor belongs to one target
generation. Navigation can destroy it without answering an in-flight request.
An actor-lifetime abort rejects its queue and permanently tombstones the actor;
late replies cannot shift any other actor's FIFO. This relies on actor IDs being
unique within a connection, and is not used as a timeout for reusable actors.
`source_actor_retirement.test.mjs` withholds all three real reply shapes and
verifies replacement actors still work. The MCP reload regression originally
exposed a 30-second old-long-string wait during attach cleanup.

## Tab and module identity

Firefox tab descriptors expose `browserId`, whereas actor names belong to a
connection. The bridge resolves that ID on the connection that will attach;
an explicit missing ID never falls back to another tab. Firefox's descriptor
[form and browser-swap implementation](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/devtools/server/actors/descriptors/tab.js)
documents the identity, and `tab_identity.test.mjs` checks three actual tabs
across connections and removal. The source inspection used Firefox main; the
runtime channel matrix remains the cross-version check.

Embedded LLDB can omit `pid` from `qLaunchGDBServer`, announcing it only in the
later `vAttach`. The current eager per-tab startup cannot then select a different
tab retroactively: it rejects a mismatched PID rather than attaching to the wrong
tab. Explicit-PID platform launches resolve the correct tab. General late-bound
multi-tab selection requires a separate, exercised attach design.

Firefox-loaded module bytes are authoritative. HTTP is used only when the source
actor cannot provide bytes and logs that identity cannot be established. No claim
of HTTP/browser equivalence is made. Regression: `authenticated_module.test.mjs`.

Custom sections hidden from LLDB are renamed without changing their encoded
length. Removing a section can invalidate file-relative breakpoint/source-map
offsets when it precedes code. Regression: `custom_section_offsets.test.mjs`.
