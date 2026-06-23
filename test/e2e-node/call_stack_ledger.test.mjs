/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Ledger fixture call-stack and locals tests. Ported from
// test/e2e/test_call_stack.py (ledger entry) and test/e2e/test_locals.py
// (test_struct_pointer_arg, test_global_array). All tests share one session.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

const skip = process.env.FIREFOX_LLDB_WASM_ATTACH === "1"
  ? false
  : "requires headless Firefox + fixtures; set FIREFOX_LLDB_WASM_ATTACH=1";

let s;
before(async () => { if (!skip) s = await Session.stoppedAtBreakpoint("ledger"); });
after(async () => { await s?.shutdown(); });

test("stopped in apply_transaction at ledger.cpp (call stack + DWARF)", { skip }, async () => {
  const f0 = await s.topFrame();
  assert.match(f0.function, /apply_transaction/);
  assert.equal(f0.file?.endsWith("ledger.cpp"), true);
  assert.ok(f0.line > 0, "line number is positive");
});

test("txn->amount == 30 (struct through pointer)", { skip }, async () => {
  const amount = await s.variable(0, "txn->amount");
  assert.equal(amount.valid, true);
  assert.equal(amount.unsigned, 30);
});

test("g_accounts[0].balance is accessible as a global", { skip }, async () => {
  // g_accounts is a static global; the balance is 100 before the transaction
  // modifies it (or 70 after). Either is correct depending on stop timing.
  const balance = await s.variable(0, "g_accounts[0].balance");
  assert.equal(balance.valid, true);
  assert.ok(
    balance.signed === 100 || balance.signed === 70,
    `expected 100 or 70, got ${balance.signed}`,
  );
});
