#!/usr/bin/env python3
"""Type-breadth variable inspection tests."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *


class TestInspectTypes(TestBase):
    def _setup(self):
        fx = next(f for f in FIXTURES if f["name"] == "types")
        target, process = self._stopped_at_breakpoint(fx)
        thread = process.GetThreadAtIndex(0)
        frame = thread.GetFrameAtIndex(1)
        self.assertTrue(frame.IsValid(), "check_types frame (frame1) is valid")
        return frame

    def test_int32_negative(self):
        """int32_t i = -42 is readable as a signed value."""
        frame = self._setup()
        var = frame.FindVariable("i")
        self.assertTrue(var.IsValid(), "FindVariable('i')")
        self.assertEqual(var.GetValueAsSigned(), -42)

    def test_uint32(self):
        """uint32_t u = 0xDEADBEEF is readable as unsigned."""
        frame = self._setup()
        var = frame.FindVariable("u")
        self.assertTrue(var.IsValid(), "FindVariable('u')")
        self.assertEqual(var.GetValueAsUnsigned(), 0xDEADBEEF)

    def test_float32(self):
        """float f = 3.14f is readable with correct approximation."""
        frame = self._setup()
        var = frame.FindVariable("f")
        self.assertTrue(var.IsValid(), "FindVariable('f')")
        err = lldb.SBError()
        raw = var.GetData().GetFloat(err, 0)
        self.assertTrue(err.Success(), "GetData().GetFloat: %s" % err.GetCString())
        self.assertAlmostEqual(raw, 3.14, places=2)

    def test_float64(self):
        """double d = 2.718... is readable with correct approximation."""
        frame = self._setup()
        var = frame.FindVariable("d")
        self.assertTrue(var.IsValid(), "FindVariable('d')")
        err = lldb.SBError()
        raw = var.GetData().GetDouble(err, 0)
        self.assertTrue(err.Success(), "GetData().GetDouble: %s" % err.GetCString())
        self.assertAlmostEqual(raw, 2.718281828, places=6)

    def test_pointer_nonnull(self):
        """int32_t* p = &i is a non-null wasm pointer."""
        frame = self._setup()
        var = frame.FindVariable("p")
        self.assertTrue(var.IsValid(), "FindVariable('p')")
        self.assertNotEqual(var.GetValueAsUnsigned(), 0, "pointer is non-null")

    def test_pointer_deref(self):
        """*p == i == -42."""
        frame = self._setup()
        p = frame.FindVariable("p")
        self.assertTrue(p.IsValid(), "FindVariable('p')")
        deref = p.Dereference()
        self.assertTrue(deref.IsValid(), "p.Dereference()")
        self.assertEqual(deref.GetValueAsSigned(), -42)

    def test_struct_float_members(self):
        """Point pt = {1.5f, 2.5f}: pt.x and pt.y are readable."""
        frame = self._setup()
        pt = frame.FindVariable("pt")
        self.assertTrue(pt.IsValid(), "FindVariable('pt')")
        x = pt.GetChildMemberWithName("x")
        y = pt.GetChildMemberWithName("y")
        self.assertTrue(x.IsValid(), "pt.x")
        self.assertTrue(y.IsValid(), "pt.y")
        err = lldb.SBError()
        x_val = x.GetData().GetFloat(err, 0)
        self.assertTrue(err.Success())
        self.assertAlmostEqual(x_val, 1.5, places=2)
        err2 = lldb.SBError()
        y_val = y.GetData().GetFloat(err2, 0)
        self.assertTrue(err2.Success())
        self.assertAlmostEqual(y_val, 2.5, places=2)

    def test_bitfield_members(self):
        """Packed pk = {3, 5, 255, 0}: bitfield members a==3, b==5 via DWARF."""
        frame = self._setup()
        pk = frame.FindVariable("pk")
        self.assertTrue(pk.IsValid(), "FindVariable('pk')")
        a = pk.GetChildMemberWithName("a")
        b = pk.GetChildMemberWithName("b")
        self.assertTrue(a.IsValid(), "pk.a")
        self.assertTrue(b.IsValid(), "pk.b")
        self.assertEqual(a.GetValueAsUnsigned(), 3)
        self.assertEqual(b.GetValueAsUnsigned(), 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
