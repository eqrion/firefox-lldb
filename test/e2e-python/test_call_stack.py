#!/usr/bin/env python3
"""Call-stack + DWARF symbolication tests."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import *


class TestCallStack(TestBase):
    pass


def _make_test(fx):
    def test(self):
        self._check_call_stack(fx)

    test.__name__ = "test_%s" % fx["name"]
    test.__doc__ = "%s: wasm call stack + DWARF symbolication" % fx["name"]
    return test


for _fx in [f for f in FIXTURES if f["name"] in {
    "factorial", "oop", "parser", "ledger", "sum_range", "types", "heap",
}]:
    setattr(TestCallStack, "test_%s" % _fx["name"], _make_test(_fx))


if __name__ == "__main__":
    unittest.main(verbosity=2)
