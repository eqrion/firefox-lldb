#!/usr/bin/env python3
"""Attach-path tests: `process attach --plugin wasm` via the platform server.

The rest of the suite connects with `process connect --plugin wasm`. These
cover the documented attach flow (vAttach), which goes through a different LLDB
process plugin path and was previously untested.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *


@unittest.skip(
    "process attach is not yet usable: LLDB's wasm plugin loads the module at a "
    "flat base on attach instead of relocating to the qXfer:libraries section "
    "address, so breakpoints resolve to bogus addresses (0x07 vs 0x4000...) and "
    "are never inserted, hanging `continue`. vAttach itself works; this is an "
    "LLDB-side relocation bug. Use `process connect --plugin wasm` until fixed."
)
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
