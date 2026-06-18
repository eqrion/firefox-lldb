#!/usr/bin/env python3
"""JS-source breakpoint and stepping tests."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *

# math.js line 725 is `assert(args.length <= nargs, ...)` inside the export
# wrapper closure, which runs on every wasm export call.
_JS_BP_FILE = "math.js"
_JS_BP_LINE = 725


class TestJsDebugging(TestBase):
    def _stopped_at_js_breakpoint(self):
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        fx = {**fx, "fire": "runFactorial(); setTimeout(runFactorial, 800)"}
        platform_port = self._start_platform(fx)
        target, process = self._connect_via_platform(platform_port)
        wasm_bp = target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "stopped at wasm breakpoint")

        js_bp = target.BreakpointCreateByLocation(_JS_BP_FILE, _JS_BP_LINE)
        self.assertTrue(js_bp.IsValid() and js_bp.GetNumLocations() >= 1,
                        "JS breakpoint %s:%d resolved" % (_JS_BP_FILE, _JS_BP_LINE))

        target.BreakpointDelete(wasm_bp.GetID())
        process.Continue()
        return target, process

    def test_js_breakpoint_fires(self):
        """A breakpoint set by JS file:line actually fires on continue."""
        target, process = self._stopped_at_js_breakpoint()
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "JS breakpoint fired")
        t = process.GetSelectedThread()
        self.assertEqual(t.GetStopReason(), lldb.eStopReasonBreakpoint,
                         "stop reason is breakpoint")
        frame0 = t.GetFrameAtIndex(0)
        self.assertEqual(frame0.GetLineEntry().GetFileSpec().GetFilename(),
                         _JS_BP_FILE)
        line = frame0.GetLineEntry().GetLine()
        self.assertGreaterEqual(line, _JS_BP_LINE)
        self.assertLessEqual(line - _JS_BP_LINE, 5,
                             "fired near the requested line (got %d)" % line)

    def test_js_step_advances_one_source_line(self):
        """thread step-over in a JS frame advances by one source line."""
        target, process = self._stopped_at_js_breakpoint()
        t = process.GetSelectedThread()
        line_before = t.GetFrameAtIndex(0).GetLineEntry().GetLine()
        t.StepOver()
        self.assertEqual(process.GetState(), lldb.eStateStopped, "stopped after step")
        f0 = process.GetSelectedThread().GetFrameAtIndex(0)
        self.assertEqual(f0.GetLineEntry().GetFileSpec().GetFilename(), _JS_BP_FILE)
        line_after = f0.GetLineEntry().GetLine()
        self.assertGreater(line_after, line_before, "advanced forward")
        self.assertLessEqual(line_after - line_before, 5,
                             "advanced by a source line, not a wild jump (got %d -> %d)"
                             % (line_before, line_after))


if __name__ == "__main__":
    unittest.main(verbosity=2)
