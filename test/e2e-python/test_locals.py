#!/usr/bin/env python3
"""Local variable / argument inspection tests."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *


class TestLocals(TestBase):
    def test_int32_param(self):
        """compute_factorial(n=10): n is visible as int32 == 10."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        target, process = self._stopped_at_breakpoint(fx)
        frame0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        n = frame0.FindVariable("n")
        self.assertTrue(n.IsValid(), "FindVariable('n')")
        self.assertEqual(n.GetValueAsUnsigned(), 10)

    def test_multiple_args(self):
        """sum_range(lo=1, hi=100): both arguments visible."""
        fx = next(f for f in FIXTURES if f["name"] == "sum_range")
        target, process = self._stopped_at_breakpoint(fx)
        frame0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        lo = frame0.FindVariable("lo")
        hi = frame0.FindVariable("hi")
        self.assertTrue(lo.IsValid(), "FindVariable('lo')")
        self.assertTrue(hi.IsValid(), "FindVariable('hi')")
        self.assertEqual(lo.GetValueAsSigned(), 1)
        self.assertEqual(hi.GetValueAsSigned(), 100)

    def test_loop_variable(self):
        """sum_range: loop variable 'i' is visible once execution enters the loop."""
        fx = next(f for f in FIXTURES if f["name"] == "sum_range")
        target, process = self._stopped_at_breakpoint(fx)
        thread = process.GetSelectedThread()
        frame0 = thread.GetFrameAtIndex(0)
        for _ in range(20):
            i_var = frame0.FindVariable("i")
            if i_var.IsValid():
                break
            thread.StepInstruction(False)
            if process.GetState() != lldb.eStateStopped:
                break
            thread = process.GetSelectedThread()
            frame0 = thread.GetFrameAtIndex(0)
        i_var = frame0.FindVariable("i")
        self.assertTrue(i_var.IsValid(), "loop variable 'i' not visible after 20 steps")

    def test_struct_pointer_arg(self):
        """apply_transaction(txn): txn->amount == 30 (struct through pointer)."""
        fx = next(f for f in FIXTURES if f["name"] == "ledger")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("apply_transaction")
        process.Continue()
        f0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        txn = f0.FindVariable("txn")
        self.assertTrue(txn.IsValid(), "FindVariable('txn')")
        self.assertNotEqual(txn.GetValueAsUnsigned(), 0, "txn is non-null")
        amount = txn.Dereference().GetChildMemberWithName("amount")
        self.assertTrue(amount.IsValid(), "txn->amount")
        self.assertEqual(amount.GetValueAsUnsigned(), 30)

    def test_global_array(self):
        """g_accounts[] is accessible as a static global via target symbols."""
        fx = next(f for f in FIXTURES if f["name"] == "ledger")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("apply_transaction")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        found = target.FindGlobalVariables("g_accounts", 1)
        self.assertGreater(found.GetSize(), 0, "g_accounts not found in debug info")
        g_accounts = found.GetValueAtIndex(0)
        self.assertTrue(g_accounts.IsValid(), "g_accounts is valid")
        elem0 = g_accounts.GetChildAtIndex(0)
        self.assertTrue(elem0.IsValid(), "g_accounts[0]")
        balance = elem0.GetChildMemberWithName("balance")
        self.assertTrue(balance.IsValid(), "g_accounts[0].balance")
        self.assertIn(balance.GetValueAsSigned(), (100, 70))


if __name__ == "__main__":
    unittest.main(verbosity=2)
