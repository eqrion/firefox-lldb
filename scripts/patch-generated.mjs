/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Post-transpile patch for the jco-generated component module.
//
// jco 1.24 has a codegen bug: trampoline catch-block debug logs reference a
// bare `currentSubtask` that is only declared in some scopes, so when a debuggee
// import throws/rejects (e.g. to signal a WIT `result` Err) the error path
// raises `ReferenceError: currentSubtask is not defined` instead of lifting the
// Err. We declare `currentSubtask` at the top of instantiate(); the legitimate
// inner `let currentSubtask` declarations shadow it where they exist.
//
// Run after every `jco transpile` (wired into the justfile). Idempotent.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src/gdb/generated/gdbstub.js"
);
const MARKER = "let currentSubtask; // jco-patch";
const ANCHOR =
  "export function instantiate(getCoreModule, imports, instantiateCore = WebAssembly.instantiate) {";

// Patch 2: AsyncSubtask inserted into cstate.handles but never removed.
// When resolve() fires it calls removeSubtask() on the parent task's array
// but never calls cstate.handles.remove(), so every completed async call leaks
// one AsyncSubtask + Waitable + Promise into the RepTable forever. Streams and
// futures already call cstate.handles.remove() at the equivalent point.
const MARKER2 = "this.#getComponentState().handles.remove(this.waitableRep()); // jco-patch";
const ANCHOR2 = "this.#parentTask.removeSubtask(this);";

let src = readFileSync(file, "utf8");

if (!src.includes(MARKER)) {
  if (!src.includes(ANCHOR)) {
    console.error("patch-generated: anchor 1 not found — jco output changed?");
    process.exit(1);
  }
  src = src.replace(ANCHOR, `${ANCHOR}\n  ${MARKER}`);
  console.log("patch-generated: applied currentSubtask fix");
}

if (!src.includes(MARKER2)) {
  if (!src.includes(ANCHOR2)) {
    console.error("patch-generated: anchor 2 not found — jco output changed?");
    process.exit(1);
  }
  src = src.replace(ANCHOR2, `${ANCHOR2}\n      ${MARKER2}`);
  console.log("patch-generated: applied AsyncSubtask handles leak fix");
}

writeFileSync(file, src);
