"""
Drive a real lldb wasm client against OUR gdbstub component, across two backends:

  - "fake"    : a deterministic FakeDebuggee (canned call stack / locals / memory),
                no browser needed. Fast inner TDD loop; runs by default.
  - "firefox" : the real bridge against headless Firefox running the example wasm
                (RdpDebuggee over RDP). End-to-end, opt-in via FIREFOX_LLDB_LIVE=1.

Each fixture is asserted on both backends where supported: lldb connects to our
real server, loads the module, and resolves the wasm call stack to source via the
embedded DWARF. Locals on the firefox backend depend on the RdpDebuggee M4 path
(still stubbed), so that one test is marked expectedFailure for now.

Run with the lldb we built (has the wasm plugin + python):
  build/bin/lldb-dotest -p TestRdpBridge.py /path/to/firefox-lldb/test/lldb
  FIREFOX_LLDB_LIVE=1 build/bin/lldb-dotest -p TestRdpBridge.py .../test/lldb
"""

import lldb
import os
import json
import socket
import subprocess
import time
import unittest
from lldbsuite.test.lldbtest import *
from lldbsuite.test.decorators import *

# Absolute paths (this file is symlinked into the lldb test tree, so __file__
# can't locate the repo). Override with FIREFOX_LLDB_REPO if needed.
REPO = os.environ.get("FIREFOX_LLDB_REPO", "/Users/ryanhunt/src/wasm-debug/firefox-lldb")
WASM_DEBUG = os.path.abspath(os.path.join(REPO, ".."))
NODE = os.environ.get("FIREFOX_LLDB_NODE", "node")

LIVE = bool(os.environ.get("FIREFOX_LLDB_LIVE"))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# Each fixture: a wasm module + the function we expect to stop in.
#   fake_call_stack : synthetic qWasmCallStack offsets (Firefox `where.line`
#                     space = code-section offset + DWARF address; derive with
#                     scripts/wasm-offsets.mjs).
#   break_func      : lldb breakpoint-by-name for the firefox backend.
#   fire            : page JS that drives the export so execution reaches it.
FIXTURES = [
    {
        "name": "factorial",
        "module": "examples/simple/math.wasm",
        "fake_call_stack": [0x1B0],
        "expect_func": "compute_factorial",
        "expect_file": "math.cpp",
        "page_dir": "examples/simple",
        "fire": "runFactorial()",
        "break_func": "compute_factorial",
    },
    {
        "name": "oop",
        "module": "examples/oop/oop.wasm",
        "fake_call_stack": [0x776],  # Square::area (virtual dispatch), mid-body
        "expect_func": "area",
        "expect_file": "oop.cpp",
        "page_dir": "examples/oop",
        "fire": "run()",
        "break_func": "area",
    },
    {
        "name": "parser",
        "module": "examples/parser/parser.wasm",
        "fake_call_stack": [0x649],  # parse_factor, mid-body
        "expect_func": "parse_factor",
        "expect_file": "parser.cpp",
        "page_dir": "examples/parser",
        "fire": "run()",
        "break_func": "parse_factor",
    },
    {
        "name": "ledger",
        "module": "examples/ledger/ledger.wasm",
        "fake_call_stack": [0x31D],  # apply_transaction, mid-body
        "expect_func": "apply_transaction",
        "expect_file": "ledger.cpp",
        "page_dir": "examples/ledger",
        "fire": "run()",
        "break_func": "apply_transaction",
    },
]


def skip_unless_live(func):
    return unittest.skipUnless(LIVE, "set FIREFOX_LLDB_LIVE=1 to run live Firefox tests")(func)


class TestRdpBridge(TestBase):
    NO_DEBUG_INFO_TESTCASE = True

    # --- server backends -----------------------------------------------------

    def _spawn(self, argv, port, ready="listening", timeout=30):
        proc = subprocess.Popen(
            argv, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        )
        self.addTearDownHook(lambda: proc.kill())
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            if ready in line:
                return port
        self.fail("server did not become ready: %s" % " ".join(argv))

    def _start_fake(self, fx):
        port = free_port()
        mod = fx["module"]
        cfg = {
            "modulePath": mod if os.path.isabs(mod) else os.path.join(WASM_DEBUG, mod),
            "callStack": fx["fake_call_stack"],
        }
        if "frameLocals" in fx:
            cfg["frameLocals"] = fx["frameLocals"]
        if "memory" in fx:
            cfg["memory"] = fx["memory"]
        cfg_path = self.getBuildArtifact("fake-config-%s.json" % fx["name"])
        with open(cfg_path, "w") as f:
            json.dump(cfg, f)
        return self._spawn(
            [NODE, "--import", "tsx",
             os.path.join(REPO, "src", "cli", "fake-wasm-server.ts"),
             "--config", cfg_path, "--port", str(port)],
            port,
        )

    def _start_firefox(self, fx):
        port = free_port()
        rdp_port = free_port()
        return self._spawn(
            [NODE, "--import", "tsx",
             os.path.join(REPO, "src", "cli", "live-wasm-server.ts"),
             "--page-dir", os.path.join(WASM_DEBUG, fx["page_dir"]),
             "--page", "index.html",
             "--fire", fx["fire"],
             "--port", str(port), "--rdp-port", str(rdp_port)],
            port, timeout=120,
        )

    def _connect_firefox(self, fx):
        """Start a live Firefox bridge and connect, stopped at the attach point
        (no breakpoint yet — the caller sets its own before the first continue,
        which is when the live server drives the page's export)."""
        self.dbg.SetAsync(False)
        return self._connect(self._start_firefox(fx))

    def _connect(self, port):
        target = self.dbg.CreateTarget("")
        error = lldb.SBError()
        process = target.ConnectRemote(
            self.dbg.GetListener(), "connect://127.0.0.1:%d" % port, "wasm", error
        )
        self.assertTrue(error.Success(), "connect: %s" % error.GetCString())
        return target, process

    def _stopped_at_breakpoint(self, fx, backend):
        """Connect via the chosen backend and return (target, process) stopped at
        the fixture's expected function."""
        self.dbg.SetAsync(False)
        if backend == "fake":
            target, process = self._connect(self._start_fake(fx))
        else:
            target, process = self._connect(self._start_firefox(fx))
            bp = target.BreakpointCreateByName(fx["break_func"])
            self.assertTrue(bp.IsValid() and bp.GetNumLocations() >= 1,
                            "breakpoint on %s" % fx["break_func"])
            process.Continue()
            self.assertEqual(process.GetState(), lldb.eStateStopped)
        return target, process

    # --- shared assertions ---------------------------------------------------

    def _check_call_stack(self, fx, backend):
        target, process = self._stopped_at_breakpoint(fx, backend)

        self.assertEqual(target.GetNumModules(), 1)
        thread = process.GetThreadAtIndex(0)
        self.assertTrue(thread.IsValid())
        frame0 = thread.GetFrameAtIndex(0)
        self.assertTrue(frame0.IsValid())
        self.assertIn(fx["expect_func"], frame0.GetFunctionName() or "")
        self.assertEqual(
            frame0.GetLineEntry().GetFileSpec().GetFilename(), fx["expect_file"]
        )

    # --- locals (the canonical simple.wasm session, fake backend) ------------

    @skipIfAsan
    @skipIfXmlSupportMissing
    def test_locals_fake(self):
        """qWasmLocal gives the shadow-stack pointer and lldb reads the values
        from linear memory. Uses llvm's simple.wasm (add/main; a=1, b=2)."""
        WASM_LOCAL_ADDR = 0x103E0
        local_bytes = "0000000000000000020000000100000000000000020000000100000000000000"
        port = self._start_fake({
            "name": "simple-locals",
            "module": os.path.join(REPO, "test", "lldb", "simple.wasm"),
            "fake_call_stack": [0x019C, 0x01E5, 0x01FE],  # add, main, _start
            "frameLocals": [[0, 0, WASM_LOCAL_ADDR]],
            "memory": {"base": WASM_LOCAL_ADDR, "size": 0x20000, "bytesHex": local_bytes},
        })
        self.dbg.SetAsync(False)
        target, process = self._connect(port)

        thread = process.GetThreadAtIndex(0)
        frame0 = thread.GetFrameAtIndex(0)
        self.assertIn("add", frame0.GetFunctionName())

        a = frame0.FindVariable("a")
        self.assertTrue(a.IsValid(), "FindVariable('a')")
        self.assertEqual(a.GetValueAsUnsigned(), 1)
        b = frame0.FindVariable("b")
        self.assertTrue(b.IsValid(), "FindVariable('b')")
        self.assertEqual(b.GetValueAsUnsigned(), 2)

    @skip_unless_live
    def test_locals_firefox(self):
        """Live-Firefox locals over RDP (M4): compute_factorial(n=10) -> n == 10.
        lldb reads the wasm frame's locals (RDP environment bindings) and linear
        memory (frame-scoped eval of memory0.buffer) to resolve the variable."""
        fx = FIXTURES[0]
        target, process = self._stopped_at_breakpoint(fx, "firefox")
        frame0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        n = frame0.FindVariable("n")
        self.assertTrue(n.IsValid(), "FindVariable('n')")
        self.assertEqual(n.GetValueAsUnsigned(), 10)

    # --- breakpoints / stepping / inspection / dynamic dispatch (live) -------

    @skip_unless_live
    @skipIfAsan
    @skipIfXmlSupportMissing
    def test_breakpoint_by_line_firefox(self):
        """A source breakpoint set by file:line resolves and is hit."""
        target, process = self._connect_firefox(FIXTURES[0])  # factorial
        bp = target.BreakpointCreateByLocation("math.cpp", 24)
        self.assertGreaterEqual(bp.GetNumLocations(), 1, "bp at math.cpp:24")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        frame0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        self.assertIn("compute_factorial", frame0.GetFunctionName() or "")
        self.assertEqual(frame0.GetLineEntry().GetFileSpec().GetFilename(), "math.cpp")

    @skip_unless_live
    @skipIfAsan
    @skipIfXmlSupportMissing
    def test_breakpoints_continue_to_next_firefox(self):
        """Two breakpoints; continue hits them in execution order (compute_factorial
        then the recursive factorial)."""
        target, process = self._connect_firefox(FIXTURES[0])
        target.BreakpointCreateByName("compute_factorial")
        target.BreakpointCreateByName("factorial")
        process.Continue()
        f0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        self.assertIn("compute_factorial", f0.GetFunctionName() or "")
        process.Continue()
        name = process.GetThreadAtIndex(0).GetFrameAtIndex(0).GetFunctionName() or ""
        self.assertIn("factorial", name)
        self.assertNotIn("compute", name)  # the inner static factorial

    @skip_unless_live
    @skipIfAsan
    @skipIfXmlSupportMissing
    def test_variable_struct_firefox(self):
        """Inspect a struct through a pointer arg via the SB value API (DWARF +
        linear-memory reads, no expression JIT): ledger txn->amount == 30."""
        fx = next(f for f in FIXTURES if f["name"] == "ledger")
        target, process = self._connect_firefox(fx)
        target.BreakpointCreateByName("apply_transaction")
        process.Continue()
        f0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        txn = f0.FindVariable("txn")
        self.assertTrue(txn.IsValid(), "FindVariable('txn')")
        self.assertNotEqual(txn.GetValueAsUnsigned(), 0, "txn is non-null")
        amount = txn.Dereference().GetChildMemberWithName("amount")
        self.assertTrue(amount.IsValid(), "txn->amount")
        self.assertEqual(amount.GetValueAsUnsigned(), 30)  # first txn {0, 1, 30}

    @skip_unless_live
    @skipIfAsan
    @skipIfXmlSupportMissing
    def test_step_instruction_firefox(self):
        """StepInstruction advances the wasm PC without leaving the function."""
        target, process = self._connect_firefox(FIXTURES[0])
        target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        t = process.GetSelectedThread()
        pc_before = t.GetFrameAtIndex(0).GetPC()
        self.assertNotEqual(pc_before, 0)
        t.StepInstruction(False)
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        pc_after = process.GetSelectedThread().GetFrameAtIndex(0).GetPC()
        self.assertNotEqual(pc_after, pc_before)
        self.assertIn("compute_factorial",
                      process.GetSelectedThread().GetFrameAtIndex(0).GetFunctionName() or "")

    @skip_unless_live
    @skipIfAsan
    @skipIfXmlSupportMissing
    def test_step_in_out_firefox(self):
        """StepInstruction into a callee; StepOut returns to the caller with a
        shallower call stack. Uses factorial -> compute_factorial recursion."""
        target, process = self._connect_firefox(FIXTURES[0])
        target.BreakpointCreateByName("compute_factorial")
        target.BreakpointCreateByName("factorial")
        # Stop at compute_factorial first, then continue to factorial (depth 2).
        process.Continue()
        self.assertIn("compute_factorial",
                      process.GetSelectedThread().GetFrameAtIndex(0).GetFunctionName() or "")
        process.Continue()
        t = process.GetSelectedThread()
        self.assertIn("factorial",
                      t.GetFrameAtIndex(0).GetFunctionName() or "")
        depth_in = t.GetNumFrames()
        self.assertGreaterEqual(depth_in, 2)
        # StepOut should return to compute_factorial (depth decreases by 1).
        t.StepOut()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        t = process.GetSelectedThread()
        depth_out = t.GetNumFrames()
        self.assertLess(depth_out, depth_in)
        self.assertIn("compute_factorial",
                      t.GetFrameAtIndex(0).GetFunctionName() or "")

    @skip_unless_live
    @skipIfAsan
    @skipIfXmlSupportMissing
    def test_step_over_firefox(self):
        """StepOver advances the PC without increasing the call stack depth."""
        target, process = self._connect_firefox(FIXTURES[0])
        target.BreakpointCreateByName("compute_factorial")
        target.BreakpointCreateByName("factorial")
        process.Continue()
        process.Continue()  # land at factorial (depth 2)
        t = process.GetSelectedThread()
        self.assertIn("factorial",
                      t.GetFrameAtIndex(0).GetFunctionName() or "")
        depth_before = t.GetNumFrames()
        pc_before = t.GetFrameAtIndex(0).GetPC()
        t.StepOver()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        t = process.GetSelectedThread()
        pc_after = t.GetFrameAtIndex(0).GetPC()
        depth_after = t.GetNumFrames()
        self.assertNotEqual(pc_after, pc_before)
        # depth should not have grown (step-over stays at same depth or returns)
        self.assertLessEqual(depth_after, depth_before)

    @skip_unless_live
    @skipIfAsan
    @skipIfXmlSupportMissing
    def test_dynamic_dispatch_firefox(self):
        """A virtual call through a base pointer resolves to the concrete
        override, and the stack shows the dispatch site."""
        fx = next(f for f in FIXTURES if f["name"] == "oop")
        target, process = self._connect_firefox(fx)
        target.BreakpointCreateByName("area")  # Square::area / Rectangle::area
        process.Continue()
        thread = process.GetThreadAtIndex(0)
        f0 = thread.GetFrameAtIndex(0)
        self.assertIn("area", f0.GetFunctionName() or "")
        self.assertEqual(f0.GetLineEntry().GetFileSpec().GetFilename(), "oop.cpp")
        self.assertIn("shape_area", thread.GetFrameAtIndex(1).GetFunctionName() or "")


# Generate per-fixture call-stack tests for each backend. The fake backend runs
# by default; the firefox backend is opt-in (FIREFOX_LLDB_LIVE=1).
def _make_call_stack_test(fx, backend):
    @skipIfAsan
    @skipIfXmlSupportMissing
    def test(self):
        self._check_call_stack(fx, backend)

    if backend == "firefox":
        test = skip_unless_live(test)
    test.__name__ = "test_%s_call_stack_%s" % (fx["name"], backend)
    test.__doc__ = "%s: wasm call stack + DWARF symbolication (%s backend)" % (
        fx["name"], backend)
    return test


for _fx in FIXTURES:
    for _backend in ("fake", "firefox"):
        _t = _make_call_stack_test(_fx, _backend)
        setattr(TestRdpBridge, _t.__name__, _t)
