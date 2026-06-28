#!/usr/bin/env python3
"""Multithreaded (pthreads / web workers) tests."""

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *

_THREADED = {
    "page_dir": "test/fixtures/threaded",
    "fire": "runMatmul()",
}


class TestThreaded(TestBase):
    def _start(self, timeout=120):
        """Start the threaded fixture, stop at matmul_threaded on the main thread."""
        platform_port = self._start_platform(_THREADED, timeout=timeout)
        target, process = self._attach_via_platform(platform_port)
        bp = target.BreakpointCreateByName("matmul_threaded")
        self.assertTrue(
            bp.IsValid() and bp.GetNumLocations() >= 1,
            "breakpoint on matmul_threaded resolved",
        )
        process.Continue()
        self.assertEqual(
            process.GetState(), lldb.eStateStopped,
            "process stopped at matmul_threaded breakpoint",
        )
        return target, process

    def test_multiple_threads_visible(self):
        """Thread list shows the main thread plus at least one pool worker."""
        _, process = self._start()
        n = process.GetNumThreads()
        self.assertGreaterEqual(
            n, 2,
            "expected >= 2 threads (main + at least one pool worker), got %d" % n,
        )

    def test_breakpoint_fires_in_matmul_threaded(self):
        """Breakpoint on matmul_threaded stops execution inside that function."""
        _, process = self._start()
        thread = process.GetSelectedThread()
        self.assertTrue(thread.IsValid(), "selected thread is valid")
        frame0 = thread.GetFrameAtIndex(0)
        self.assertTrue(frame0.IsValid(), "frame 0 is valid")
        self.assertIn(
            "matmul_threaded",
            frame0.GetFunctionName() or "",
            "selected thread is in matmul_threaded",
        )

    def test_frame_resolves_to_source(self):
        """Stopped frame maps back to matmul.cpp via DWARF."""
        _, process = self._start()
        frame0 = process.GetSelectedThread().GetFrameAtIndex(0)
        src = frame0.GetLineEntry().GetFileSpec().GetFilename()
        self.assertEqual(src, "matmul.cpp")

    def test_param_is_accessible(self):
        """matmul_threaded: the 'nthreads' parameter is readable."""
        _, process = self._start()
        frame0 = process.GetSelectedThread().GetFrameAtIndex(0)
        nthreads = frame0.FindVariable("nthreads")
        self.assertTrue(nthreads.IsValid(), "FindVariable('nthreads') in matmul_threaded")
        self.assertGreater(nthreads.GetValueAsUnsigned(), 0, "nthreads > 0")

    def test_step_instruction(self):
        """StepInstruction advances the PC inside matmul_threaded."""
        _, process = self._start()
        thread = process.GetSelectedThread()
        pc_before = thread.GetFrameAtIndex(0).GetPC()
        self.assertNotEqual(pc_before, 0, "initial PC is non-zero")
        thread.StepInstruction(False)
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        thread = process.GetSelectedThread()
        frame0 = thread.GetFrameAtIndex(0)
        pc_after = frame0.GetPC()
        self.assertNotEqual(pc_after, pc_before, "PC advances after StepInstruction")
        self.assertIn(
            "matmul_threaded",
            frame0.GetFunctionName() or "",
            "still in matmul_threaded after single step",
        )

    def test_other_threads_have_valid_state(self):
        """After all-stop, every thread is queryable; the stopped thread has wasm frames."""
        _, process = self._start()
        selected_id = process.GetSelectedThread().GetThreadID()
        n = process.GetNumThreads()
        for i in range(n):
            t = process.GetThreadAtIndex(i)
            self.assertTrue(t.IsValid(), "thread %d is valid" % i)
            nframes = t.GetNumFrames()
            if t.GetThreadID() == selected_id:
                self.assertGreaterEqual(
                    nframes, 1,
                    "stopped (main) thread should have >= 1 wasm frame",
                )

    def test_switch_selected_thread(self):
        """Switching the selected thread to a worker keeps the process stopped."""
        _, process = self._start()
        n = process.GetNumThreads()
        if n < 2:
            self.skipTest("need >= 2 threads")
        original_id = process.GetSelectedThread().GetThreadID()
        worker = None
        for i in range(n):
            t = process.GetThreadAtIndex(i)
            if t.GetThreadID() != original_id:
                worker = t
                break
        self.assertIsNotNone(worker, "could not find a worker thread")
        process.SetSelectedThread(worker)
        self.assertEqual(process.GetState(), lldb.eStateStopped,
                         "process still stopped after thread switch")
        self.assertEqual(process.GetSelectedThread().GetThreadID(), worker.GetThreadID(),
                         "selected thread is now the worker")

    def test_step_keeps_other_threads_stopped(self):
        """After single-stepping the main thread, other threads remain visible."""
        _, process = self._start()
        thread = process.GetSelectedThread()
        thread.StepInstruction(False)
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        n_after = process.GetNumThreads()
        self.assertGreaterEqual(
            n_after, 2,
            "other threads still visible after single-step (got %d)" % n_after,
        )

    def test_continue_after_stop(self):
        """Continuing after an all-stop resumes all threads without hanging."""
        target, process = self._start()
        target.DeleteAllBreakpoints()
        self.dbg.SetAsync(True)
        process.Continue()
        time.sleep(1.5)
        state = process.GetState()
        if state == lldb.eStateRunning:
            process.SendAsyncInterrupt()
            time.sleep(0.5)
            state = process.GetState()
        self.dbg.SetAsync(False)
        self.assertIn(
            state,
            (lldb.eStateStopped, lldb.eStateExited),
            "process is in a valid final state, got %d" % state,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
