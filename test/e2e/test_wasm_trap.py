#!/usr/bin/env python3
"""Wasm trap surface behaviour test."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *


class TestWasmTrap(TestBase):
    @unittest.expectedFailure
    def test_wasm_trap_surfaces_as_exception(self):
        """Wasm integer divide-by-zero should surface as eStopReasonException.

        Currently marked xfail: Firefox does not pause on wasm traps with
        pauseOnExceptions=false, so the process exits rather than stopping.
        """
        fx = next(f for f in FIXTURES if f["name"] == "trap")
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("cause_trap")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "stopped at cause_trap breakpoint")
        process.GetSelectedThread().StepOver()
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "stopped after trap")
        stop_reason = process.GetSelectedThread().GetStopReason()
        self.assertEqual(stop_reason, lldb.eStopReasonException,
                         "stop reason should be exception/trap")


if __name__ == "__main__":
    unittest.main(verbosity=2)
