/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Constants shared across the RdpWasmSession <-> RdpDebuggee seam (session.ts
// and gdb/rdp-debuggee.ts), kept together so the two grace timers below stay
// visibly comparable instead of drifting apart as independent copies.

// A minimal valid wasm binary (magic + version only, no sections). Used as a
// placeholder module body wherever real bytecode can't be fetched or a module
// ref was already cleared by a navigation, so callers get no DWARF/debug info
// for that module instead of a hard failure.
export const EMPTY_WASM_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

// Fission can destroy-and-recreate the top-level target as an internal process
// swap (e.g. the process reassignment that often follows the very first
// cross-origin navigation from about:blank) with no signal distinguishing it
// from a real tab close, and the replacement's target-available-form can
// arrive after the destroy. session.ts waits this long for a replacement
// before treating a top-level target-destroyed-form as a genuine close.
export const DETACH_GRACE_MS = 250;

// After a navigation swaps in a new top-level target while LLDB is waiting on
// a stop (a Debuggee.continue is armed), rdp-debuggee.ts gives a buffered
// breakpoint on the new page this long to fire naturally through the normal
// all-stop path before forcing a re-sync stop. Same order of magnitude as
// DETACH_GRACE_MS above, but a distinct concern: that one decides whether a
// target swap was a real close, this one decides whether to force a stop so
// the gdbstub component's update_on_stop -> all_modules re-sync ever runs.
export const RESYNC_GRACE_MS = 250;
