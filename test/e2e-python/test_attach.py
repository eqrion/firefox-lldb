#!/usr/bin/env python3
"""Attach-path test: `process attach --plugin wasm` via the platform server.

The whole suite now attaches via this flow (an RSP shim fronts each spawned
stub so LLDB drives the native qLaunchGDBServer -> connect -> vAttach
handshake; see src/protocol/attach-shim.ts). This is the explicit end-to-end
attach check.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *


class TestAttach(TestBase):
    def test_attach_reaches_breakpoint(self):
        """`process attach --plugin wasm --pid N` stops at a wasm breakpoint."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        bp = target.BreakpointCreateByName(fx["break_func"])
        self.assertTrue(
            bp.IsValid() and bp.GetNumLocations() >= 1,
            "breakpoint on %s" % fx["break_func"],
        )
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        frame0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        self.assertIn(fx["expect_func"], frame0.GetFunctionName() or "")
        self.assertEqual(
            frame0.GetLineEntry().GetFileSpec().GetFilename(), fx["expect_file"]
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
