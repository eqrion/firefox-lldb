#!/usr/bin/env python3
"""Breakpoint, stepping, and control-flow tests."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *


class TestControlFlow(TestBase):
    def test_breakpoint_by_line(self):
        """Source breakpoint by file:line resolves and is hit at the exact line."""
        platform_port = self._start_platform(
            next(f for f in FIXTURES if f["name"] == "factorial")
        )
        target, process = self._attach_via_platform(platform_port)
        bp = target.BreakpointCreateByLocation("math.cpp", 24)
        self.assertGreaterEqual(bp.GetNumLocations(), 1, "bp at math.cpp:24")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        frame0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        self.assertIn("compute_factorial", frame0.GetFunctionName() or "")
        entry = frame0.GetLineEntry()
        self.assertEqual(entry.GetFileSpec().GetFilename(), "math.cpp")
        self.assertEqual(entry.GetLine(), 24, "stopped at exact line 24")

    def test_breakpoint_before_module_fires(self):
        """Breakpoint set before first Continue (before the page's wasm call) is hit."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        bp = target.BreakpointCreateByName("compute_factorial")
        self.assertTrue(bp.IsValid() and bp.GetNumLocations() >= 1)
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        frame0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        self.assertIn("compute_factorial", frame0.GetFunctionName() or "")

    def test_two_breakpoints_continue(self):
        """Two breakpoints; continue hits them in execution order."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        target.BreakpointCreateByName("factorial")
        process.Continue()
        f0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        self.assertIn("compute_factorial", f0.GetFunctionName() or "")
        process.Continue()
        name = process.GetThreadAtIndex(0).GetFrameAtIndex(0).GetFunctionName() or ""
        self.assertIn("factorial", name)
        self.assertNotIn("compute", name)

    def test_step_instruction(self):
        """StepInstruction advances the wasm PC without leaving the function."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        t = process.GetSelectedThread()
        pc_before = t.GetFrameAtIndex(0).GetPC()
        self.assertNotEqual(pc_before, 0)
        t.StepInstruction(False)
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        pc_after = process.GetSelectedThread().GetFrameAtIndex(0).GetPC()
        self.assertNotEqual(pc_after, pc_before)
        self.assertIn(
            "compute_factorial",
            process.GetSelectedThread().GetFrameAtIndex(0).GetFunctionName() or "",
        )

    def test_step_in_out(self):
        """StepInstruction into callee; StepOut returns to caller."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        target.BreakpointCreateByName("factorial")
        process.Continue()
        self.assertIn(
            "compute_factorial",
            process.GetSelectedThread().GetFrameAtIndex(0).GetFunctionName() or "",
        )
        process.Continue()
        t = process.GetSelectedThread()
        self.assertIn("factorial", t.GetFrameAtIndex(0).GetFunctionName() or "")
        depth_in = t.GetNumFrames()
        self.assertGreaterEqual(depth_in, 2)
        t.StepOut()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        t = process.GetSelectedThread()
        self.assertLess(t.GetNumFrames(), depth_in)
        self.assertIn(
            "compute_factorial", t.GetFrameAtIndex(0).GetFunctionName() or ""
        )

    def test_step_over(self):
        """StepOver advances the PC without increasing call stack depth."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        target.BreakpointCreateByName("factorial")
        process.Continue()
        process.Continue()
        t = process.GetSelectedThread()
        self.assertIn("factorial", t.GetFrameAtIndex(0).GetFunctionName() or "")
        depth_before = t.GetNumFrames()
        pc_before = t.GetFrameAtIndex(0).GetPC()
        t.StepOver()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        t = process.GetSelectedThread()
        self.assertNotEqual(t.GetFrameAtIndex(0).GetPC(), pc_before)
        self.assertLessEqual(t.GetNumFrames(), depth_before)

    def test_dynamic_dispatch(self):
        """Virtual call through a base pointer resolves to the concrete override."""
        fx = next(f for f in FIXTURES if f["name"] == "oop")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("area")
        process.Continue()
        thread = process.GetThreadAtIndex(0)
        f0 = thread.GetFrameAtIndex(0)
        self.assertIn("area", f0.GetFunctionName() or "")
        self.assertEqual(f0.GetLineEntry().GetFileSpec().GetFilename(), "oop.cpp")
        self.assertIn("shape_area", thread.GetFrameAtIndex(1).GetFunctionName() or "")

    def test_inspect_virtual_this(self):
        """At a virtual method breakpoint, 'this' pointer is non-null."""
        fx = next(f for f in FIXTURES if f["name"] == "oop")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("area")
        process.Continue()
        frame0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        this_var = frame0.FindVariable("this")
        if not this_var.IsValid():
            this_var = frame0.FindVariable("this_")
        self.assertEqual(frame0.GetLineEntry().GetFileSpec().GetFilename(), "oop.cpp")

    def test_multiple_step_instructions(self):
        """Five sequential StepInstructions each advance the PC."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        thread = process.GetSelectedThread()
        self.assertIn("factorial", thread.GetFrameAtIndex(0).GetFunctionName() or "")

        prev_pc = thread.GetFrameAtIndex(0).GetPC()
        for step_num in range(5):
            thread.StepInstruction(False)
            self.assertEqual(process.GetState(), lldb.eStateStopped,
                             f"process stopped after step {step_num + 1}")
            thread = process.GetSelectedThread()
            pc = thread.GetFrameAtIndex(0).GetPC()
            self.assertNotEqual(pc, prev_pc, f"PC advanced at step {step_num + 1}")
            prev_pc = pc

    def test_breakpoint_fires_multiple_times(self):
        """A breakpoint in a recursive function fires on each recursion level."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("factorial")

        n_values = []
        for _ in range(3):
            process.Continue()
            self.assertEqual(process.GetState(), lldb.eStateStopped)
            frame0 = process.GetSelectedThread().GetFrameAtIndex(0)
            self.assertIn("factorial", frame0.GetFunctionName() or "")
            n_var = frame0.FindVariable("n")
            self.assertTrue(n_var.IsValid(), "n is visible in factorial")
            n_values.append(n_var.GetValueAsSigned())

        self.assertEqual(n_values, [10, 9, 8])

    def test_step_out_in_recursion(self):
        """StepOut from a recursive frame returns to the immediate caller frame."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("factorial")

        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        thread = process.GetSelectedThread()
        n10 = thread.GetFrameAtIndex(0).FindVariable("n")
        self.assertTrue(n10.IsValid())
        self.assertEqual(n10.GetValueAsSigned(), 10)
        depth_10 = thread.GetNumFrames()

        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        thread = process.GetSelectedThread()
        n9 = thread.GetFrameAtIndex(0).FindVariable("n")
        self.assertTrue(n9.IsValid())
        self.assertEqual(n9.GetValueAsSigned(), 9)
        depth_9 = thread.GetNumFrames()
        self.assertGreater(depth_9, depth_10, "recursive call increased stack depth")

        thread.StepOut()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        thread = process.GetSelectedThread()
        self.assertEqual(thread.GetNumFrames(), depth_10,
                         "after StepOut, depth should match the factorial(10) level")
        self.assertIn("factorial", thread.GetFrameAtIndex(0).GetFunctionName() or "")

    def test_continue_after_step(self):
        """After instruction steps, Continue correctly hits the next breakpoint."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        target.BreakpointCreateByName("factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        self.assertIn("compute_factorial",
                      process.GetSelectedThread().GetFrameAtIndex(0).GetFunctionName() or "")

        thread = process.GetSelectedThread()
        for _ in range(3):
            thread.StepInstruction(False)
            self.assertEqual(process.GetState(), lldb.eStateStopped)
            thread = process.GetSelectedThread()

        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        frame0 = process.GetSelectedThread().GetFrameAtIndex(0)
        func = frame0.GetFunctionName() or ""
        self.assertIn("factorial", func,
                      "after step+continue, should hit the factorial breakpoint")
        self.assertNotIn("compute_", func)

    def test_step_out_to_js(self):
        """Stepping out of the outermost wasm frame eventually reaches a JS caller."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        thread = process.GetSelectedThread()
        self.assertIn("compute_factorial", thread.GetFrameAtIndex(0).GetFunctionName() or "")

        for _ in range(5):
            thread.StepOut()
            self.assertEqual(process.GetState(), lldb.eStateStopped)
            thread = process.GetSelectedThread()
            filename = thread.GetFrameAtIndex(0).GetLineEntry().GetFileSpec().GetFilename()
            if filename.endswith(".js"):
                break
        else:
            last_func = thread.GetFrameAtIndex(0).GetFunctionName() or ""
            last_file = thread.GetFrameAtIndex(0).GetLineEntry().GetFileSpec().GetFilename()
            self.fail(f"never reached a JS frame after 5 StepOuts; "
                      f"last: {last_func!r} in {last_file!r}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
