/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Apply the two jco 1.24.3 workarounds after npm run component:transpile.
// Idempotent; changed/ambiguous anchors fail before writing. Removal criteria
// and regression coverage are recorded in docs/COMPATIBILITY.md.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src/gdb/generated/gdbstub.js"
);
// Catch-block diagnostics reference an undeclared currentSubtask in some
// trampolines. Inner declarations shadow this fallback where they exist.
const MARKER = "let currentSubtask; // jco-patch";
const ANCHOR =
  "export function instantiate(getCoreModule, imports, instantiateCore = WebAssembly.instantiate) {";

// Completing an AsyncSubtask removes it from its parent but not the handle
// table. Release that handle too, matching stream/future completion ownership.
const MARKER2 = "this.#getComponentState().handles.remove(this.waitableRep()); // jco-patch";
const ANCHOR2 = "this.#parentTask.removeSubtask(this);";

let src = readFileSync(file, "utf8");

// Refuse ambiguous output: silently patching one of several matches leaves a
// build that looks regenerated but still contains an unfixed trampoline.
for (const [name, anchor, marker] of [
  ["currentSubtask", ANCHOR, MARKER],
  ["AsyncSubtask", ANCHOR2, MARKER2],
]) {
  const anchors = src.split(anchor).length - 1;
  const markers = src.split(marker).length - 1;
  if (anchors !== 1 || markers > 1) {
    throw new Error(
      `patch-generated: ${name}: expected one anchor and at most one marker, got ${anchors}/${markers}`
    );
  }
}

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

// Generated whitespace has no semantic role; normalize it deterministically so
// regenerated diffs can be checked with the same whitespace gate as source.
writeFileSync(file, src.replace(/[\t ]+$/gm, ""));
