#!/usr/bin/env python3
"""
Mixed JS/wasm debugging QA tests.

These tests probe scenarios beyond the basic JS breakpoint and step tests:
  - Application-level JS file breakpoints (not just emscripten glue)
  - JS local variable visibility when stopped in a JS frame
  - Step-in from a JS frame that calls wasm
  - Simultaneous JS + wasm breakpoints
  - Source file discovery (which JS files are visible to the debugger)
  - Step-over stress test in a JS frame

Usage:
    LLDB=../llvm-project/build/bin/lldb python3 test/e2e/test_mixed_js.py
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import expectedFailure

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *  # noqa: E402, F401, F403

MIXED_FX = {
    "name": "mixed-js",
    "module": "test/fixtures/mixed-js/math.wasm",
    "expect_func": "compute_factorial",
    "expect_file": "math.cpp",
    "page_dir": "test/fixtures/mixed-js",
    "fire": "runApp()",
    "break_func": "compute_factorial",
}

# Lines in app.js — verified against the file.
APP_JS_FILE = "app.js"
APP_JS_BREAKLINE = 14   # const factResult = computeFactorial(n);
APP_JS_LOOP_INIT = 11   # for (let i = 0; i < numbers.length; i++) {
APP_JS_RUNBATCH  = 21   # function runBatch() {


def _full_frame_dump(thread):
    """Return a list of (filename, line, funcname) for all frames."""
    out = []
    for i in range(thread.GetNumFrames()):
        f = thread.GetFrameAtIndex(i)
        entry = f.GetLineEntry()
        out.append((
            entry.GetFileSpec().GetFilename(),
            entry.GetLine(),
            f.GetFunctionName() or "",
        ))
    return out


class TestAppJsSourceDiscovery(TestBase):
    """Is application-level JS (app.js) visible to the debugger at all?"""

    def _sources_at_breakpoint(self):
        platform_port = self._start_platform(MIXED_FX)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        thread = process.GetThreadAtIndex(0)
        sources = set()
        for i in range(thread.GetNumFrames()):
            name = thread.GetFrameAtIndex(i).GetLineEntry().GetFileSpec().GetFilename()
            if name:
                sources.add(name)
        return target, process, sources

    def test_math_js_is_visible(self):
        """The emscripten glue (math.js) should appear in the call stack."""
        _, _, sources = self._sources_at_breakpoint()
        self.assertIn("math.js", sources,
                      "math.js (emscripten glue) should be visible; got: %s" % sources)

    def test_app_js_is_visible(self):
        """app.js (application-level JS) should appear in the call stack."""
        _, _, sources = self._sources_at_breakpoint()
        self.assertIn("app.js", sources,
                      "app.js should be visible as a caller frame; got: %s" % sources)

    def test_wasm_source_cpp_is_visible(self):
        """math.cpp (DWARF source) should appear at the innermost wasm frame."""
        _, _, sources = self._sources_at_breakpoint()
        self.assertIn("math.cpp", sources)


class TestAppJsBreakpoints(TestBase):
    """Can we set and hit breakpoints in application-level app.js?"""

    def _setup_second_call(self, line=APP_JS_BREAKLINE):
        """Stop at compute_factorial, set a JS breakpoint, enable a second runApp() call."""
        fx = {**MIXED_FX, "fire": "runApp(); setTimeout(runApp, 600)"}
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)

        wasm_bp = target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "expected stop at compute_factorial")

        js_bp = target.BreakpointCreateByLocation(APP_JS_FILE, line)
        self.assertTrue(js_bp.IsValid() and js_bp.GetNumLocations() >= 1,
                        "%s:%d breakpoint should resolve" % (APP_JS_FILE, line))
        target.BreakpointDelete(wasm_bp.GetID())
        process.Continue()
        return target, process

    def test_app_js_breakpoint_resolves(self):
        """Breakpoint on app.js:%d resolves to at least one location.""" % APP_JS_BREAKLINE
        platform_port = self._start_platform(MIXED_FX)
        target, process = self._attach_via_platform(platform_port)
        wasm_bp = target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        js_bp = target.BreakpointCreateByLocation(APP_JS_FILE, APP_JS_BREAKLINE)
        self.assertTrue(js_bp.IsValid(), "breakpoint object should be valid")
        self.assertGreaterEqual(js_bp.GetNumLocations(), 1,
                                "app.js breakpoint should resolve to >=1 location")
        process.Kill()

    def test_app_js_breakpoint_fires(self):
        """Breakpoint set in app.js processNumbers() actually stops execution."""
        target, process = self._setup_second_call(APP_JS_BREAKLINE)
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "app.js breakpoint should fire on the second runApp()")
        t = process.GetSelectedThread()
        self.assertEqual(t.GetStopReason(), lldb.eStopReasonBreakpoint,
                         "stop reason should be eStopReasonBreakpoint")

    def test_app_js_breakpoint_file_reported(self):
        """When stopped at an app.js breakpoint, frame 0 reports app.js."""
        target, process = self._setup_second_call(APP_JS_BREAKLINE)
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        frame0 = process.GetSelectedThread().GetFrameAtIndex(0)
        fname = frame0.GetLineEntry().GetFileSpec().GetFilename()
        self.assertEqual(fname, APP_JS_FILE,
                         "frame 0 should report app.js; got %r" % fname)

    def test_app_js_breakpoint_line_accurate(self):
        """Line reported when stopped at an app.js breakpoint is near the requested line."""
        target, process = self._setup_second_call(APP_JS_BREAKLINE)
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        frame0 = process.GetSelectedThread().GetFrameAtIndex(0)
        line = frame0.GetLineEntry().GetLine()
        self.assertGreaterEqual(line, APP_JS_BREAKLINE)
        self.assertLessEqual(line - APP_JS_BREAKLINE, 5,
                             "stopped line should be within 5 of requested (got %d)" % line)


class TestJsVariableInspection(TestBase):
    """What can we inspect when stopped in a JS frame?"""

    def _stop_in_app_js(self):
        """Return (process, frame0) stopped at app.js:APP_JS_BREAKLINE."""
        fx = {**MIXED_FX, "fire": "runApp(); setTimeout(runApp, 600)"}
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)

        wasm_bp = target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)

        js_bp = target.BreakpointCreateByLocation(APP_JS_FILE, APP_JS_BREAKLINE)
        self.assertTrue(js_bp.IsValid() and js_bp.GetNumLocations() >= 1)
        target.BreakpointDelete(wasm_bp.GetID())
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "app.js breakpoint should fire")
        frame0 = process.GetSelectedThread().GetFrameAtIndex(0)
        return process, frame0

    def test_js_variables_count(self):
        """Document how many variables LLDB sees in a JS frame.

        Currently 0: the bridge returns no locals for 'call' JS frames.
        If this ever returns non-zero, JS variable support has been added.
        """
        process, frame0 = self._stop_in_app_js()
        vars_list = frame0.GetVariables(True, True, False, False)
        count = vars_list.GetSize()
        print(f"\n[info] JS frame variable count at app.js:{APP_JS_BREAKLINE}: {count}")
        if count > 0:
            for i in range(count):
                v = vars_list.GetValueAtIndex(i)
                print(f"  var[{i}]: {v.GetName()!r} = {v.GetValue()!r}")
        # Document the limitation, don't hard-fail so it self-documents improvement.
        if count == 0:
            self.skipTest("JS frame variable inspection not yet implemented (0 locals — expected)")

    def test_js_frame_is_valid(self):
        """The JS frame object itself should be valid."""
        process, frame0 = self._stop_in_app_js()
        self.assertTrue(frame0.IsValid())

    def test_js_frame_has_line_entry(self):
        """A JS frame stopped in app.js should have a valid line entry."""
        process, frame0 = self._stop_in_app_js()
        entry = frame0.GetLineEntry()
        self.assertTrue(entry.IsValid())
        self.assertGreater(entry.GetLine(), 0)


class TestStepIntoWasmFromJs(TestBase):
    """What happens when you step-in from a JS line that calls a wasm function?"""

    def test_step_in_from_js_call_site(self):
        """Step-in from a JS line calling wasm degrades gracefully.

        The INTERNALS.md comment says 'JS step-in degrades to step-over', but
        empirically it actually ENTERS wasm. This test documents the behavior.
        """
        fx = {**MIXED_FX, "fire": "runApp(); setTimeout(runApp, 600)"}
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)

        wasm_bp = target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)

        js_bp = target.BreakpointCreateByLocation(APP_JS_FILE, APP_JS_BREAKLINE)
        self.assertTrue(js_bp.IsValid() and js_bp.GetNumLocations() >= 1)
        target.BreakpointDelete(wasm_bp.GetID())
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "app.js breakpoint should fire")

        t = process.GetSelectedThread()
        line_before = t.GetFrameAtIndex(0).GetLineEntry().GetLine()
        file_before = t.GetFrameAtIndex(0).GetLineEntry().GetFileSpec().GetFilename()
        self.assertEqual(file_before, APP_JS_FILE,
                         "should be stopped in app.js before step-in")

        t.StepInto()
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "process should stop after StepInto")

        t = process.GetSelectedThread()
        frame0 = t.GetFrameAtIndex(0)
        file_after = frame0.GetLineEntry().GetFileSpec().GetFilename()
        line_after = frame0.GetLineEntry().GetLine()

        print(f"\n[info] step-in: {file_before}:{line_before} -> {file_after}:{line_after}")

        if file_after == "math.cpp":
            print("[info] step-in ENTERED wasm — better than documented!")
        elif file_after == APP_JS_FILE:
            self.assertGreater(line_after, line_before,
                               "step-over behavior should advance the JS line")
        # Either outcome is acceptable — just must not crash or hang.
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "process must remain stopped after StepInto")


class TestSimultaneousBreakpoints(TestBase):
    """JS and wasm breakpoints can coexist and fire in execution order."""

    def test_wasm_then_js_breakpoints_fire_in_order(self):
        """Set a wasm bp; on first stop, arm a JS bp; continue; JS bp fires."""
        fx = {**MIXED_FX, "fire": "runApp(); setTimeout(runApp, 600)"}
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)

        wasm_bp = target.BreakpointCreateByName("compute_factorial")
        self.assertTrue(wasm_bp.IsValid() and wasm_bp.GetNumLocations() >= 1)

        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "first stop: wasm bp")
        frame0 = process.GetSelectedThread().GetFrameAtIndex(0)
        self.assertIn("compute_factorial", frame0.GetFunctionName() or "")

        js_bp = target.BreakpointCreateByLocation(APP_JS_FILE, APP_JS_BREAKLINE)
        self.assertTrue(js_bp.IsValid() and js_bp.GetNumLocations() >= 1,
                        "app.js breakpoint should resolve after first wasm stop")
        target.BreakpointDelete(wasm_bp.GetID())

        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "second stop should be the JS bp")
        t = process.GetSelectedThread()
        reason = t.GetStopReason()
        fname = t.GetFrameAtIndex(0).GetLineEntry().GetFileSpec().GetFilename()
        print(f"\n[info] second stop: {fname}, reason={reason}")
        self.assertEqual(reason, lldb.eStopReasonBreakpoint)
        self.assertEqual(fname, APP_JS_FILE,
                         "second stop should be in app.js; got %r" % fname)

    def test_js_breakpoint_survives_wasm_breakpoint_removal(self):
        """Removing the wasm breakpoint doesn't break the JS breakpoint."""
        fx = {**MIXED_FX, "fire": "runApp(); setTimeout(runApp, 600)"}
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)

        wasm_bp = target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)

        js_bp = target.BreakpointCreateByLocation(APP_JS_FILE, APP_JS_BREAKLINE)
        self.assertTrue(js_bp.IsValid() and js_bp.GetNumLocations() >= 1)
        target.BreakpointDelete(wasm_bp.GetID())

        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        fname = process.GetSelectedThread().GetFrameAtIndex(0).GetLineEntry().GetFileSpec().GetFilename()
        self.assertEqual(fname, APP_JS_FILE,
                         "stop should be in app.js; got %r" % fname)


class TestMultipleJsFiles(TestBase):
    """When multiple JS files are loaded, both should be discoverable."""

    def test_both_js_files_in_call_stack(self):
        """Call stack when stopped in wasm should show both app.js and math.js."""
        platform_port = self._start_platform(MIXED_FX)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)

        thread = process.GetThreadAtIndex(0)
        frames = _full_frame_dump(thread)
        print(f"\n[info] frame dump: {frames}")
        frame_files = [f[0] for f in frames]

        self.assertTrue(any(f == "app.js" for f in frame_files),
                        "app.js should appear in call stack; got: %s" % frame_files)
        self.assertTrue(any(f == "math.js" for f in frame_files),
                        "math.js should appear in call stack; got: %s" % frame_files)

    def test_breakpoint_in_emscripten_glue_still_works(self):
        """After loading app.js, breakpoints in math.js still function."""
        platform_port = self._start_platform(MIXED_FX)
        target, process = self._attach_via_platform(platform_port)

        wasm_bp = target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)

        math_js_bp = target.BreakpointCreateByLocation("math.js", 725)
        self.assertTrue(math_js_bp.IsValid() and math_js_bp.GetNumLocations() >= 1,
                        "math.js:725 breakpoint should still resolve")
        process.Kill()


class TestJsStepOverStress(TestBase):
    """Stress test: step-over repeatedly in a JS frame, watch for hangs or stuck states."""

    def _stop_at_app_js(self, line=APP_JS_BREAKLINE):
        """Return (target, process, thread) stopped at app.js:line on second runApp()."""
        fx = {**MIXED_FX, "fire": "runApp(); setTimeout(runApp, 600)"}
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)

        wasm_bp = target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)

        js_bp = target.BreakpointCreateByLocation(APP_JS_FILE, line)
        self.assertTrue(js_bp.IsValid() and js_bp.GetNumLocations() >= 1,
                        "app.js:%d breakpoint should resolve" % line)
        target.BreakpointDelete(wasm_bp.GetID())
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "app.js breakpoint should fire")
        return target, process, process.GetSelectedThread()

    def test_step_over_stays_in_js(self):
        """Step-over from inside a JS function body should advance within JS, not jump to wasm."""
        target, process, t = self._stop_at_app_js(APP_JS_BREAKLINE)

        frame0 = t.GetFrameAtIndex(0)
        file0 = frame0.GetLineEntry().GetFileSpec().GetFilename()
        line0 = frame0.GetLineEntry().GetLine()
        self.assertEqual(file0, APP_JS_FILE,
                         "must start in app.js; got %r:%d" % (file0, line0))

        t.StepOver()
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "process should stop after step-over in JS")

        t = process.GetSelectedThread()
        frame0_after = t.GetFrameAtIndex(0)
        file_after = frame0_after.GetLineEntry().GetFileSpec().GetFilename()
        line_after = frame0_after.GetLineEntry().GetLine()
        print(f"\n[info] step-over: {file0}:{line0} -> {file_after}:{line_after}")

        # Step-over from app.js:14 (factResult = computeFactorial(n)) should
        # stay in JS, not fall into wasm.
        self.assertEqual(file_after, APP_JS_FILE,
                         "step-over from app.js should remain in JS (not %r)" % file_after)
        self.assertGreater(line_after, line0,
                           "step-over should advance the line (got %d -> %d)" % (line0, line_after))

    def test_five_consecutive_step_overs(self):
        """Five consecutive step-overs in app.js processNumbers() should not hang.

        Note: step-over at the end of a for-loop body (e.g., line 16) legitimately
        jumps BACK to the for-header (line 12) for the next iteration. The assertion
        here checks we made execution progress, not that lines are monotonically
        increasing (they won't be in a loop).
        """
        target, process, t = self._stop_at_app_js(APP_JS_BREAKLINE)

        frame0 = t.GetFrameAtIndex(0)
        file0 = frame0.GetLineEntry().GetFileSpec().GetFilename()
        self.assertEqual(file0, APP_JS_FILE, "must start in app.js")

        lines_seen = set()
        lines_seen.add(frame0.GetLineEntry().GetLine())
        steps_ok = 0

        for step_num in range(5):
            prev_file = t.GetFrameAtIndex(0).GetLineEntry().GetFileSpec().GetFilename()
            prev_line = t.GetFrameAtIndex(0).GetLineEntry().GetLine()
            t.StepOver()
            self.assertEqual(process.GetState(), lldb.eStateStopped,
                             "stuck after step %d" % (step_num + 1))
            t = process.GetSelectedThread()
            f = t.GetFrameAtIndex(0)
            cur_file = f.GetLineEntry().GetFileSpec().GetFilename()
            cur_line = f.GetLineEntry().GetLine()
            print(f"\n  step {step_num + 1}: {prev_file}:{prev_line} -> {cur_file}:{cur_line}")
            if cur_file != APP_JS_FILE:
                print(f"  [info] left app.js after {steps_ok} good steps")
                break
            lines_seen.add(cur_line)
            steps_ok += 1

        # Verify we visited more than one distinct line (made progress).
        self.assertGreater(len(lines_seen), 1,
                           "should visit more than one line during stepping; got: %s" % sorted(lines_seen))

    def test_step_over_does_not_hang(self):
        """Step-over in app.js completes in reasonable time (no infinite wait)."""
        target, process, t = self._stop_at_app_js(APP_JS_BREAKLINE)
        t.StepOver()
        state = process.GetState()
        self.assertIn(state, [lldb.eStateStopped, lldb.eStateRunning],
                      "after step-over, process should be stopped or running (not crashed)")


class TestOuterFrameLineNumbers(TestBase):
    """Outer JS frames in the call stack should report their actual call-site lines.

    When stopped at a wasm breakpoint called from JS, the call stack contains
    multiple JS frames (e.g., processNumbers -> runBatch -> runApp). Each outer
    frame should report the line number where it invoked its callee, not a
    duplicate of the innermost JS frame's line.
    """

    @expectedFailure  # https://github.com/eqrion/firefox-lldb/issues/2
    def test_outer_js_frames_have_distinct_lines(self):
        """JS frames from the same file should report different line numbers."""
        platform_port = self._start_platform(MIXED_FX)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)

        thread = process.GetThreadAtIndex(0)
        frames = _full_frame_dump(thread)
        print(f"\n[info] full frame dump: {frames}")

        # Collect all app.js frames and their reported line numbers.
        app_js_frames = [(fn, line, func) for fn, line, func in frames if fn == APP_JS_FILE]
        print(f"[info] app.js frames: {app_js_frames}")

        self.assertGreaterEqual(len(app_js_frames), 2,
                                "call stack should have at least 2 app.js frames "
                                "(processNumbers, runBatch); got: %s" % app_js_frames)

        lines = [line for _, line, _ in app_js_frames]
        # All frames reporting the same line number is a bug: outer frames
        # (runBatch, runApp) should show their actual call-site lines, not a
        # copy of the innermost active line.
        unique_lines = set(lines)
        self.assertGreater(len(unique_lines), 1,
                           "BUG: all %d app.js frames report the same line %s — "
                           "outer frames should show their actual call-site lines "
                           "(processNumbers at ~14, runBatch at ~23, runApp at ~43)" % (
                               len(app_js_frames), lines))

    @expectedFailure  # known limitation: single-subprogram synthetic modules, see INTERNALS.md
    def test_outer_js_frames_have_meaningful_function_names(self):
        """Outer JS frames should report actual function names, not just the filename."""
        platform_port = self._start_platform(MIXED_FX)
        target, process = self._attach_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)

        thread = process.GetThreadAtIndex(0)
        frames = _full_frame_dump(thread)
        app_js_frames = [(fn, line, func) for fn, line, func in frames if fn == APP_JS_FILE]
        print(f"\n[info] app.js frames with func names: {app_js_frames}")

        func_names = [func for _, _, func in app_js_frames]
        expected_funcs = {"processNumbers", "runBatch", "runApp"}
        actual_funcs = set(func_names)
        self.assertTrue(expected_funcs.intersection(actual_funcs),
                        "JS frame function names should include processNumbers/runBatch/runApp; "
                        "got: %r" % func_names)


class TestLoopBreakpoint(TestBase):
    """Test breakpoints inside loop bodies (a common real-world scenario)."""

    def test_breakpoint_hits_multiple_loop_iterations(self):
        """A breakpoint in a loop body should fire on each iteration that calls it."""
        fx = {**MIXED_FX, "fire": "runApp(); setTimeout(runApp, 600)"}
        platform_port = self._start_platform(fx)
        target, process = self._attach_via_platform(platform_port)

        # Stop at wasm first so app.js is loaded.
        wasm_bp = target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)

        # Set breakpoint at line 14 (the factResult assignment inside the for loop).
        js_bp = target.BreakpointCreateByLocation(APP_JS_FILE, APP_JS_BREAKLINE)
        self.assertTrue(js_bp.IsValid() and js_bp.GetNumLocations() >= 1)
        target.BreakpointDelete(wasm_bp.GetID())

        stops = 0
        # inputs has 4 elements; the bp should fire 4 times per runApp() call.
        # We have two runApp() calls (initial + setTimeout), so up to 8 hits total.
        # Allow at most 10 continues to avoid infinite loops.
        for _ in range(10):
            process.Continue()
            if process.GetState() != lldb.eStateStopped:
                break
            t = process.GetSelectedThread()
            fname = t.GetFrameAtIndex(0).GetLineEntry().GetFileSpec().GetFilename()
            if fname != APP_JS_FILE:
                break
            stops += 1
            if stops >= 3:
                break

        print(f"\n[info] loop breakpoint hit {stops} time(s)")
        self.assertGreaterEqual(stops, 2,
                                "loop breakpoint should fire on multiple iterations (got %d)" % stops)


if __name__ == "__main__":
    unittest.main(verbosity=2)
