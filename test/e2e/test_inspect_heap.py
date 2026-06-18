#!/usr/bin/env python3
"""Heap allocation inspection tests."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *


class TestInspectHeap(TestBase):
    def _setup(self):
        fx = next(f for f in FIXTURES if f["name"] == "heap")
        target, process = self._stopped_at_breakpoint(fx)
        frame0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        return process, frame0

    def test_heap_pointer_nonnull(self):
        """Heap-allocated Point*: pointer is non-null."""
        _, frame = self._setup()
        pt = frame.FindVariable("pt")
        self.assertTrue(pt.IsValid(), "FindVariable('pt')")
        self.assertNotEqual(pt.GetValueAsUnsigned(), 0, "pt is non-null")

    def test_heap_struct_member(self):
        """pt->x == 1.5 (struct on heap, read through pointer)."""
        _, frame = self._setup()
        pt = frame.FindVariable("pt")
        self.assertTrue(pt.IsValid(), "FindVariable('pt')")
        x = pt.Dereference().GetChildMemberWithName("x")
        self.assertTrue(x.IsValid(), "pt->x")
        err = lldb.SBError()
        x_val = x.GetData().GetFloat(err, 0)
        self.assertTrue(err.Success())
        self.assertAlmostEqual(x_val, 1.5, places=2)

    def test_heap_array_pointer_nonnull(self):
        """Heap-allocated int32_t[5]: pointer is non-null."""
        _, frame = self._setup()
        arr = frame.FindVariable("arr")
        self.assertTrue(arr.IsValid(), "FindVariable('arr')")
        self.assertNotEqual(arr.GetValueAsUnsigned(), 0, "arr is non-null")

    def test_heap_array_first_element(self):
        """arr[0] == 10 (first element of heap array, read via process memory)."""
        process, frame = self._setup()
        arr = frame.FindVariable("arr")
        self.assertTrue(arr.IsValid(), "FindVariable('arr')")
        addr = arr.GetValueAsUnsigned()
        self.assertNotEqual(addr, 0, "arr is non-null")
        err = lldb.SBError()
        raw = process.ReadMemory(addr, 4, err)
        self.assertTrue(err.Success(), "ReadMemory: %s" % err.GetCString())
        value = int.from_bytes(raw, byteorder="little", signed=True)
        self.assertEqual(value, 10)


if __name__ == "__main__":
    unittest.main(verbosity=2)
