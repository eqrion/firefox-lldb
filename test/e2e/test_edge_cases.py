#!/usr/bin/env python3
"""Edge case and boundary behaviour tests."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *


class TestEdgeCases(TestBase):
    def test_watchpoint_behavior(self):
        """WatchAddress on a wasm local: documents what the bridge returns.

        Watchpoints are not supported for wasm. The bridge should return an
        invalid watchpoint or a clear error without crashing. We do not
        continue the process after the attempt — the gdbstub doesn't handle
        watchpoint packets and would hang waiting for a response.
        """
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        frame0 = process.GetSelectedThread().GetFrameAtIndex(0)
        n = frame0.FindVariable("n")
        self.assertTrue(n.IsValid())
        error = lldb.SBError()
        addr = n.GetLoadAddress()
        wp = target.WatchAddress(addr, 4, False, True, error)
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "process still stopped after WatchAddress attempt")

    def test_interleaved_js_wasm_frames(self):
        """JS caller frames are visible above the wasm breakpoint frame."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        thread = process.GetThreadAtIndex(0)

        frame0 = thread.GetFrameAtIndex(0)
        self.assertIn("compute_factorial", frame0.GetFunctionName() or "")
        self.assertEqual(frame0.GetLineEntry().GetFileSpec().GetFilename(), "math.cpp")

        js_frame_idx = None
        for i in range(thread.GetNumFrames()):
            if thread.GetFrameAtIndex(i).GetLineEntry().GetFileSpec().GetFilename().endswith(".js"):
                js_frame_idx = i
                break

        frame_files = [
            thread.GetFrameAtIndex(i).GetLineEntry().GetFileSpec().GetFilename()
            for i in range(thread.GetNumFrames())
        ]
        self.assertIsNotNone(js_frame_idx,
                             f"no JS frame found; frame source files: {frame_files}")
        self.assertGreater(js_frame_idx, 0,
                           "JS frame must be an outer caller of the wasm frame at frame 0")


if __name__ == "__main__":
    unittest.main(verbosity=2)
