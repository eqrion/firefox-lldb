#!/usr/bin/env python3
"""Standalone lldb bridge test harness — no lldb-dotest or LLVM source tree needed.

Usage:
    # Fake backend only (fast, no browser):
    FIREFOX_LLDB_LLDB=../llvm-project/build/bin/lldb \\
        python3 test/lldb/run_bridge_tests.py

    # Fake + live-Firefox (opt-in):
    FIREFOX_LLDB_LIVE=1 FIREFOX_LLDB_LLDB=../llvm-project/build/bin/lldb \\
        python3 test/lldb/run_bridge_tests.py

Environment variables:
    FIREFOX_LLDB_LLDB   Path to the lldb binary with the wasm plugin (required).
    LLDB_PYTHON_PATH    lldb Python module dir override (derived from FIREFOX_LLDB_LLDB if unset).
    FIREFOX_LLDB_NODE   Node binary to use (default: "node").
    FIREFOX_LLDB_LIVE   Set to 1 to run the live-Firefox tests.
"""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote

# ---- env / paths -------------------------------------------------------

REPO = Path(__file__).resolve().parent.parent.parent
WASM_DEBUG = REPO.parent
NODE = os.environ.get("FIREFOX_LLDB_NODE", "node")
LLDB_BINARY = os.environ.get("FIREFOX_LLDB_LLDB", "lldb")
LIVE = bool(os.environ.get("FIREFOX_LLDB_LIVE"))


def _bootstrap_lldb():
    pypath = os.environ.get("LLDB_PYTHON_PATH")
    if not pypath:
        try:
            r = subprocess.run(
                [LLDB_BINARY, "-P"], capture_output=True, text=True, timeout=10
            )
            if r.returncode == 0:
                pypath = r.stdout.strip()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
    if pypath and pypath not in sys.path:
        sys.path.insert(0, pypath)
    try:
        import lldb as _lldb

        return _lldb
    except ImportError as e:
        sys.exit(
            f"Cannot import lldb from {pypath!r}: {e}\n"
            "Set FIREFOX_LLDB_LLDB=<path to lldb binary> or LLDB_PYTHON_PATH=<python dir>."
        )


lldb = _bootstrap_lldb()

# ---- fixtures ----------------------------------------------------------

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
        "fake_call_stack": [0x776],
        "expect_func": "area",
        "expect_file": "oop.cpp",
        "page_dir": "examples/oop",
        "fire": "run()",
        "break_func": "area",
    },
    {
        "name": "parser",
        "module": "examples/parser/parser.wasm",
        "fake_call_stack": [0x649],
        "expect_func": "parse_factor",
        "expect_file": "parser.cpp",
        "page_dir": "examples/parser",
        "fire": "run()",
        "break_func": "parse_factor",
    },
    {
        "name": "ledger",
        "module": "examples/ledger/ledger.wasm",
        "fake_call_stack": [0x31D],
        "expect_func": "apply_transaction",
        "expect_file": "ledger.cpp",
        "page_dir": "examples/ledger",
        "fire": "run()",
        "break_func": "apply_transaction",
    },
]

skip_unless_live = unittest.skipUnless(
    LIVE, "set FIREFOX_LLDB_LIVE=1 to run live Firefox tests"
)

# ---- helpers -----------------------------------------------------------

MIME = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".wasm": "application/wasm",
    ".json": "application/json",
}


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def send_rsp(sock, packet):
    """Send one RSP packet (ack mode) and return the response payload."""
    data = packet.encode("latin-1")
    checksum = sum(data) % 256
    framed = b"$" + data + b"#" + ("%02x" % checksum).encode()
    sock.sendall(framed)
    buf = b""
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("socket closed waiting for RSP response")
        buf += chunk
        # Skip ack/nak bytes at the front.
        i = 0
        while i < len(buf) and buf[i : i + 1] in (b"+", b"-"):
            i += 1
        rest = buf[i:]
        s = rest.find(b"$")
        if s < 0:
            continue
        e = rest.find(b"#", s + 1)
        if e >= 0 and len(rest) >= e + 3:
            sock.sendall(b"+")
            return rest[s + 1 : e].decode("latin-1")


def launch_gdb_server(platform_port):
    """Connect to the platform RSP server, send qLaunchGDBServer, return the spawned port."""
    s = socket.socket()
    s.connect(("127.0.0.1", platform_port))
    s.settimeout(30)
    resp = send_rsp(s, "qLaunchGDBServer:port:0;host:localhost;")
    s.close()
    m = re.search(r"port:(\d+)", resp)
    if not m:
        raise RuntimeError(f"qLaunchGDBServer returned: {resp!r}")
    return int(m.group(1))


def start_static_server(page_dir):
    """HTTP server with COOP/COEP headers for a page directory. Returns (server, port)."""

    class _Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            rel = unquote(self.path.split("?")[0]).lstrip("/") or "index.html"
            full = Path(page_dir) / rel
            try:
                body = full.read_bytes()
            except FileNotFoundError:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", MIME.get(full.suffix, "application/octet-stream"))
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.end_headers()
            self.wfile.write(body)

    server = HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


# ---- test base ---------------------------------------------------------


class BridgeTestCase(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.dbg = lldb.SBDebugger.Create()
        self.dbg.SetAsync(False)
        self._tmpdir = tempfile.mkdtemp(prefix="ff-bridge-")

    def tearDown(self):
        lldb.SBDebugger.Destroy(self.dbg)
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def artifact(self, name):
        return os.path.join(self._tmpdir, name)

    def _spawn(self, argv, *, ready, timeout=30):
        """Start a subprocess; block until `ready` string appears in output."""
        proc = subprocess.Popen(
            argv,
            cwd=str(REPO),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self.addCleanup(proc.kill)
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            if ready in line:
                return proc
        self.fail("server did not become ready: %s" % " ".join(str(a) for a in argv))

    def _start_fake(self, fx):
        port = free_port()
        mod = fx["module"]
        cfg = {
            "modulePath": mod if os.path.isabs(mod) else str(WASM_DEBUG / mod),
            "callStack": fx["fake_call_stack"],
        }
        if "frameLocals" in fx:
            cfg["frameLocals"] = fx["frameLocals"]
        if "memory" in fx:
            cfg["memory"] = fx["memory"]
        cfg_path = self.artifact("fake-config-%s.json" % fx["name"])
        with open(cfg_path, "w") as f:
            json.dump(cfg, f)
        self._spawn(
            [
                NODE, "--import", "tsx",
                str(REPO / "src" / "cli" / "fake-wasm-server.ts"),
                "--config", cfg_path,
                "--port", str(port),
            ],
            ready="listening",
        )
        return port

    def _start_platform(self, fx, timeout=120):
        """Start the unified CLI in launch+headless mode. Returns the platform port."""
        platform_port = free_port()
        rdp_port = free_port()
        static_server, http_port = start_static_server(str(WASM_DEBUG / fx["page_dir"]))
        self.addCleanup(static_server.shutdown)
        url = f"http://127.0.0.1:{http_port}/index.html"
        self._spawn(
            [
                NODE, "--import", "tsx",
                str(REPO / "src" / "cli" / "firefox-lldb.ts"),
                "--launch", "--headless",
                "--port", str(platform_port),
                "--rdp-port", str(rdp_port),
                "--url", url,
                "--fire", fx["fire"],
            ],
            ready="platform server ready",
            timeout=timeout,
        )
        return platform_port

    def _connect(self, port):
        """Direct wasm gdbstub connect (fake backend)."""
        target = self.dbg.CreateTarget("")
        error = lldb.SBError()
        process = target.ConnectRemote(
            self.dbg.GetListener(),
            "connect://127.0.0.1:%d" % port,
            "wasm",
            error,
        )
        self.assertTrue(error.Success(), "connect: %s" % error.GetCString())
        return target, process

    def _connect_via_platform(self, platform_port):
        """Trigger qLaunchGDBServer on the platform then connect to the spawned gdb server."""
        gdb_port = launch_gdb_server(platform_port)
        return self._connect(gdb_port)

    def _stopped_at_breakpoint(self, fx, backend):
        self.dbg.SetAsync(False)
        if backend == "fake":
            target, process = self._connect(self._start_fake(fx))
        else:
            platform_port = self._start_platform(fx)
            target, process = self._connect_via_platform(platform_port)
            bp = target.BreakpointCreateByName(fx["break_func"])
            self.assertTrue(
                bp.IsValid() and bp.GetNumLocations() >= 1,
                "breakpoint on %s" % fx["break_func"],
            )
            process.Continue()
            self.assertEqual(process.GetState(), lldb.eStateStopped)
        return target, process

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


# ---- locals tests ------------------------------------------------------


class TestLocals(BridgeTestCase):
    def test_locals_fake(self):
        """qWasmLocal: shadow-stack pointer; lldb reads values from linear memory."""
        WASM_LOCAL_ADDR = 0x103E0
        local_bytes = (
            "0000000000000000020000000100000000000000020000000100000000000000"
        )
        port = self._start_fake(
            {
                "name": "simple-locals",
                "module": str(REPO / "test" / "lldb" / "simple.wasm"),
                "fake_call_stack": [0x019C, 0x01E5, 0x01FE],
                "frameLocals": [[0, 0, WASM_LOCAL_ADDR]],
                "memory": {
                    "base": WASM_LOCAL_ADDR,
                    "size": 0x20000,
                    "bytesHex": local_bytes,
                },
            }
        )
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
        """Live-Firefox locals (M4): compute_factorial(n=10) -> n == 10."""
        fx = FIXTURES[0]
        target, process = self._stopped_at_breakpoint(fx, "firefox")
        frame0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        n = frame0.FindVariable("n")
        self.assertTrue(n.IsValid(), "FindVariable('n')")
        self.assertEqual(n.GetValueAsUnsigned(), 10)


# ---- call-stack tests (per-fixture × backend) --------------------------


class TestCallStack(BridgeTestCase):
    pass


def _make_call_stack_test(fx, backend):
    def test(self):
        self._check_call_stack(fx, backend)

    test.__name__ = "test_%s_%s" % (fx["name"], backend)
    test.__doc__ = "%s: wasm call stack + DWARF symbolication (%s)" % (
        fx["name"],
        backend,
    )
    if backend == "firefox":
        test = skip_unless_live(test)
    return test


for _fx in FIXTURES:
    for _backend in ("fake", "firefox"):
        _t = _make_call_stack_test(_fx, _backend)
        setattr(TestCallStack, _t.__name__, _t)


# ---- live-Firefox-only tests -------------------------------------------


class TestLiveFirefox(BridgeTestCase):
    @skip_unless_live
    def test_breakpoint_by_line(self):
        """Source breakpoint by file:line resolves and is hit."""
        platform_port = self._start_platform(FIXTURES[0])
        target, process = self._connect_via_platform(platform_port)
        bp = target.BreakpointCreateByLocation("math.cpp", 24)
        self.assertGreaterEqual(bp.GetNumLocations(), 1, "bp at math.cpp:24")
        process.Continue()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        frame0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        self.assertIn("compute_factorial", frame0.GetFunctionName() or "")
        self.assertEqual(
            frame0.GetLineEntry().GetFileSpec().GetFilename(), "math.cpp"
        )

    @skip_unless_live
    def test_two_breakpoints_continue(self):
        """Two breakpoints; continue hits them in execution order."""
        platform_port = self._start_platform(FIXTURES[0])
        target, process = self._connect_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        target.BreakpointCreateByName("factorial")
        process.Continue()
        f0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        self.assertIn("compute_factorial", f0.GetFunctionName() or "")
        process.Continue()
        name = process.GetThreadAtIndex(0).GetFrameAtIndex(0).GetFunctionName() or ""
        self.assertIn("factorial", name)
        self.assertNotIn("compute", name)

    @skip_unless_live
    def test_struct_variable(self):
        """Inspect a struct through a pointer arg: ledger txn->amount == 30."""
        fx = next(f for f in FIXTURES if f["name"] == "ledger")
        platform_port = self._start_platform(fx)
        target, process = self._connect_via_platform(platform_port)
        target.BreakpointCreateByName("apply_transaction")
        process.Continue()
        f0 = process.GetThreadAtIndex(0).GetFrameAtIndex(0)
        txn = f0.FindVariable("txn")
        self.assertTrue(txn.IsValid(), "FindVariable('txn')")
        self.assertNotEqual(txn.GetValueAsUnsigned(), 0, "txn is non-null")
        amount = txn.Dereference().GetChildMemberWithName("amount")
        self.assertTrue(amount.IsValid(), "txn->amount")
        self.assertEqual(amount.GetValueAsUnsigned(), 30)

    @skip_unless_live
    def test_step_instruction(self):
        """StepInstruction advances the wasm PC without leaving the function."""
        platform_port = self._start_platform(FIXTURES[0])
        target, process = self._connect_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        process.Continue()
        t = process.GetSelectedThread()
        pc_before = t.GetFrameAtIndex(0).GetPC()
        self.assertNotEqual(pc_before, 0)
        t.StepInstruction(False)
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        pc_after = process.GetSelectedThread().GetFrameAtIndex(0).GetPC()
        self.assertNotEqual(pc_after, pc_before)
        self.assertIn(
            "compute_factorial",
            process.GetSelectedThread().GetFrameAtIndex(0).GetFunctionName() or "",
        )

    @skip_unless_live
    def test_step_in_out(self):
        """StepInstruction into callee; StepOut returns to caller."""
        platform_port = self._start_platform(FIXTURES[0])
        target, process = self._connect_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        target.BreakpointCreateByName("factorial")
        process.Continue()
        self.assertIn(
            "compute_factorial",
            process.GetSelectedThread().GetFrameAtIndex(0).GetFunctionName() or "",
        )
        process.Continue()
        t = process.GetSelectedThread()
        self.assertIn("factorial", t.GetFrameAtIndex(0).GetFunctionName() or "")
        depth_in = t.GetNumFrames()
        self.assertGreaterEqual(depth_in, 2)
        t.StepOut()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        t = process.GetSelectedThread()
        self.assertLess(t.GetNumFrames(), depth_in)
        self.assertIn(
            "compute_factorial", t.GetFrameAtIndex(0).GetFunctionName() or ""
        )

    @skip_unless_live
    def test_step_over(self):
        """StepOver advances the PC without increasing call stack depth."""
        platform_port = self._start_platform(FIXTURES[0])
        target, process = self._connect_via_platform(platform_port)
        target.BreakpointCreateByName("compute_factorial")
        target.BreakpointCreateByName("factorial")
        process.Continue()
        process.Continue()
        t = process.GetSelectedThread()
        self.assertIn("factorial", t.GetFrameAtIndex(0).GetFunctionName() or "")
        depth_before = t.GetNumFrames()
        pc_before = t.GetFrameAtIndex(0).GetPC()
        t.StepOver()
        self.assertEqual(process.GetState(), lldb.eStateStopped)
        t = process.GetSelectedThread()
        self.assertNotEqual(t.GetFrameAtIndex(0).GetPC(), pc_before)
        self.assertLessEqual(t.GetNumFrames(), depth_before)

    @skip_unless_live
    def test_dynamic_dispatch(self):
        """Virtual call through a base pointer resolves to the concrete override."""
        fx = next(f for f in FIXTURES if f["name"] == "oop")
        platform_port = self._start_platform(fx)
        target, process = self._connect_via_platform(platform_port)
        target.BreakpointCreateByName("area")
        process.Continue()
        thread = process.GetThreadAtIndex(0)
        f0 = thread.GetFrameAtIndex(0)
        self.assertIn("area", f0.GetFunctionName() or "")
        self.assertEqual(f0.GetLineEntry().GetFileSpec().GetFilename(), "oop.cpp")
        self.assertIn("shape_area", thread.GetFrameAtIndex(1).GetFunctionName() or "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
