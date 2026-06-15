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

let src = readFileSync(file, "utf8");
if (src.includes(MARKER)) {
  console.log("patch-generated: already patched");
} else if (src.includes(ANCHOR)) {
  src = src.replace(ANCHOR, `${ANCHOR}\n  ${MARKER}`);
  writeFileSync(file, src);
  console.log("patch-generated: applied currentSubtask fix");
} else {
  console.error("patch-generated: anchor not found — jco output changed?");
  process.exit(1);
}
