#!/usr/bin/env python3
"""Recursive call-stack depth and frame inspection tests."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *


class TestRecursion(TestBase):
    def test_deep_call_stack(self):
        """parser: break in parse_factor, call stack is >= 3 frames deep."""
        fx = next(f for f in FIXTURES if f["name"] == "parser")
        target, process = self._stopped_at_breakpoint(fx)
        thread = process.GetThreadAtIndex(0)
        self.assertGreaterEqual(thread.GetNumFrames(), 3,
                                "expected parse_factor / parse_term / parse_expr stack")

    def test_parent_frame_names(self):
        """parser: frame0=parse_factor, frame1=parse_term, frame2=parse_expr."""
        fx = next(f for f in FIXTURES if f["name"] == "parser")
        target, process = self._stopped_at_breakpoint(fx)
        thread = process.GetThreadAtIndex(0)
        f0 = thread.GetFrameAtIndex(0).GetFunctionName() or ""
        f1 = thread.GetFrameAtIndex(1).GetFunctionName() or ""
        f2 = thread.GetFrameAtIndex(2).GetFunctionName() or ""
        self.assertIn("parse_factor", f0)
        self.assertIn("parse_term", f1)
        self.assertIn("parse_expr", f2)

    def test_locals_in_callee(self):
        """parse_factor: local 'value' is visible."""
        fx = next(f for f in FIXTURES if f["name"] == "parser")
        target, process = self._stopped_at_breakpoint(fx)
        frame0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        value = frame0.FindVariable("value")
        self.assertTrue(value.IsValid(), "FindVariable('value') in parse_factor")

    def test_factorial_recursion_depth(self):
        """factorial(10) recurses; stack has multiple compute_factorial/factorial frames."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        target, process = self._stopped_at_breakpoint(fx)
        target.BreakpointCreateByName("factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        thread = process.GetThreadAtIndex(0)
        names = [thread.GetFrameAtIndex(i).GetFunctionName() or ""
                 for i in range(thread.GetNumFrames())]
        factorial_frames = [n for n in names if "factorial" in n]
        self.assertGreaterEqual(len(factorial_frames), 2,
                                "expected at least 2 factorial frames in recursion")


if __name__ == "__main__":
    unittest.main(verbosity=2)
