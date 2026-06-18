#!/usr/bin/env python3
"""Source listing and file-backed line entry tests."""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *


class TestSourceListing(TestBase):
    def _source_lines(self, target, file_spec, line, context=2):
        stream = lldb.SBStream()
        count = target.GetSourceManager().DisplaySourceLinesWithLineNumbers(
            file_spec, line, context, context, "->", stream
        )
        return stream.GetData() if count > 0 else ""

    def test_wasm_source_listing(self):
        """Source listing on the innermost wasm frame shows C++ source lines."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        target, process = self._stopped_at_breakpoint(fx)
        frame0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        self.assertIn("compute_factorial", frame0.GetFunctionName() or "")
        entry = frame0.GetLineEntry()
        self.assertTrue(entry.IsValid(), "wasm frame has a valid line entry")
        filename = entry.GetFileSpec().GetFilename()
        self.assertEqual(filename, "math.cpp")
        line = entry.GetLine()
        self.assertGreater(line, 0, "line number is positive")
        local_spec = lldb.SBFileSpec(str(REPO / fx["page_dir"] / filename))
        content = self._source_lines(target, local_spec, line)
        self.assertIn("compute_factorial", content,
                      f"expected compute_factorial in source listing:\n{content}")

    def test_js_source_listing(self):
        """Source listing on a JS frame shows JavaScript source lines from the temp file."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._connect_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        thread = process.GetThreadAtIndex(0)
        js_frame = None
        for i in range(thread.GetNumFrames()):
            f = thread.GetFrameAtIndex(i)
            if f.GetLineEntry().GetFileSpec().GetFilename().endswith(".js"):
                js_frame = f
                break
        self.assertIsNotNone(js_frame, "no JS frame with a .js source file found in call stack")
        entry = js_frame.GetLineEntry()
        self.assertTrue(entry.IsValid(), "JS frame has a valid line entry")
        line = entry.GetLine()
        self.assertGreater(line, 0, "JS frame line number is positive")
        content = self._source_lines(target, entry.GetFileSpec(), line)
        self.assertGreater(len(content), 0, "source listing for JS frame should be non-empty")
        js_keywords = ("function", "var ", "const ", "let ", "return", "Module", "=>")
        self.assertTrue(
            any(kw in content for kw in js_keywords),
            f"JS source listing does not look like JavaScript:\n{content!r}",
        )

    def test_js_source_line_number_is_accurate(self):
        """The JS frame's line number falls within the source file's line count."""
        fx = next(f for f in FIXTURES if f["name"] == "factorial")
        platform_port = self._start_platform(fx)
        target, process = self._connect_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        thread = process.GetThreadAtIndex(0)
        for i in range(thread.GetNumFrames()):
            f = thread.GetFrameAtIndex(i)
            entry = f.GetLineEntry()
            if not entry.GetFileSpec().GetFilename().endswith(".js"):
                continue
            line = entry.GetLine()
            self.assertGreater(line, 0, "JS frame line > 0")
            path = os.path.join(
                entry.GetFileSpec().GetDirectory(),
                entry.GetFileSpec().GetFilename(),
            )
            if os.path.exists(path):
                with open(path) as fh:
                    total_lines = sum(1 for _ in fh)
                self.assertLessEqual(
                    line, total_lines,
                    f"frame line {line} exceeds file length {total_lines} in {path}",
                )
            break


if __name__ == "__main__":
    unittest.main(verbosity=2)
