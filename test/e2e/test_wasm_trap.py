#!/usr/bin/env python3
"""Wasm trap surface behaviour test."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *


class TestWasmTrap(TestBase):
    def test_wasm_trap_surfaces_as_signal(self):
        """Wasm integer divide-by-zero pauses at the trapping frame as a signal.

        With pauseOnExceptions + ignoreCaughtExceptions, the uncaught trap pauses
        and surfaces to LLDB as a SIGSEGV signal stop.
        """
        fx = next(f for f in FIXTURES if f["name"] == "trap")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "stopped at the wasm trap")
        stop_reason = process.GetSelectedThread().GetStopReason()
        self.assertEqual(stop_reason, lldb.eStopReasonSignal,
                         "stop reason should be a signal")


if __name__ == "__main__":
    unittest.main(verbosity=2)
