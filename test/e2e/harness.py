#!/usr/bin/env python3
"""Shared test infrastructure for the firefox-lldb e2e suite.

Imports, fixture definitions, utility helpers, and TestBase all live here.
Individual test modules import with ``from harness import *``.
"""

import json
import os
import re
import shutil
import signal
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
NODE = os.environ.get("FIREFOX_LLDB_NODE", "node")
LLDB_BINARY = os.environ.get("LLDB", "lldb")


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
    # Clear any stale partial import left by the pre-installed lldb package on
    # the system. Without this, `import lldb` returns a broken partially-initialized
    # module when python3-lldb is already wired into Python's site-packages.
    for _key in [k for k in sys.modules if k == "lldb" or k.startswith("lldb.")]:
        del sys.modules[_key]
    try:
        import lldb as _lldb

        return _lldb
    except ImportError as e:
        sys.exit(
            f"Cannot import lldb from {pypath!r}: {e}\n"
            "Set LLDB=<path to wasm-plugin lldb binary> or LLDB_PYTHON_PATH=<python dir>."
        )


lldb = _bootstrap_lldb()


def _check_wasm_plugin():
    """Exit early with a clear message if the wasm process plugin is unavailable."""
    dbg = lldb.SBDebugger.Create()
    dbg.SetAsync(False)
    target = dbg.CreateTarget("")
    error = lldb.SBError()
    # We expect either success (unlikely without a server) or a connection error.
    # A "plugin not found" / "wasm" type unknown error means stock lldb.
    process = target.ConnectRemote(
        dbg.GetListener(), "connect://127.0.0.1:1", "wasm", error
    )
    msg = error.GetCString() or ""
    lldb.SBDebugger.Destroy(dbg)
    if "not found" in msg.lower() or "invalid" in msg.lower() and "wasm" in msg.lower():
        sys.exit(
            f"The wasm process plugin is not available in {LLDB_BINARY!r}.\n"
            "Set LLDB=<path to a wasm-plugin lldb build>, e.g.:\n"
            "  LLDB=../llvm-project/build/bin/lldb python3 test/e2e/run.py"
        )


_check_wasm_plugin()

# ---- fixtures ----------------------------------------------------------

FIXTURES = [
    {
        "name": "factorial",
        "module": "test/e2e/fixtures/simple/math.wasm",
        "expect_func": "compute_factorial",
        "expect_file": "math.cpp",
        "page_dir": "test/e2e/fixtures/simple",
        "fire": "runFactorial()",
        "break_func": "compute_factorial",
    },
    {
        "name": "sum_range",
        "module": "test/e2e/fixtures/simple/math.wasm",
        "expect_func": "sum_range",
        "expect_file": "math.cpp",
        "page_dir": "test/e2e/fixtures/simple",
        "fire": "runSum()",
        "break_func": "sum_range",
    },
    {
        "name": "oop",
        "module": "test/e2e/fixtures/oop/oop.wasm",
        "expect_func": "area",
        "expect_file": "oop.cpp",
        "page_dir": "test/e2e/fixtures/oop",
        "fire": "run()",
        "break_func": "area",
    },
    {
        "name": "parser",
        "module": "test/e2e/fixtures/parser/parser.wasm",
        "expect_func": "parse_factor",
        "expect_file": "parser.cpp",
        "page_dir": "test/e2e/fixtures/parser",
        "fire": "run()",
        "break_func": "parse_factor",
    },
    {
        "name": "ledger",
        "module": "test/e2e/fixtures/ledger/ledger.wasm",
        "expect_func": "apply_transaction",
        "expect_file": "ledger.cpp",
        "page_dir": "test/e2e/fixtures/ledger",
        "fire": "run()",
        "break_func": "apply_transaction",
    },
    {
        "name": "types",
        "module": "test/e2e/fixtures/types/types.wasm",
        "expect_func": "stop_here",
        "expect_file": "types.cpp",
        "page_dir": "test/e2e/fixtures/types",
        "fire": "run()",
        "break_func": "stop_here",
    },
    {
        "name": "heap",
        "module": "test/e2e/fixtures/heap/heap.wasm",
        "expect_func": "check_heap",
        "expect_file": "heap.cpp",
        "page_dir": "test/e2e/fixtures/heap",
        "fire": "run()",
        "break_func": "check_heap",
    },
    {
        "name": "trap",
        "module": "test/e2e/fixtures/trap/trap.wasm",
        "expect_func": "cause_trap",
        "expect_file": "trap.cpp",
        "page_dir": "test/e2e/fixtures/trap",
        "fire": "run()",
        "break_func": "cause_trap",
    },
]

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


def launch_gdb_server(platform_port, attempts=4, backoff=1.0):
    """Connect to the platform RSP server, send qLaunchGDBServer, return the spawned port.

    Retries on a transient E01: under suite-wide load a single launch can lose
    the Firefox cold-start / wasm-observe race in the launcher even though the
    platform server itself is healthy. Each attempt uses a fresh connection.
    """
    last = None
    for attempt in range(attempts):
        s = socket.socket()
        s.connect(("127.0.0.1", platform_port))
        # Generous per-attempt timeout: a cold launch chains connectWithRetry
        # (up to ~20s), navigate, and waitForWasm (~8s) before replying.
        s.settimeout(60)
        try:
            resp = send_rsp(s, "qLaunchGDBServer:port:0;host:localhost;")
            m = re.search(r"port:(\d+)", resp)
            if m:
                return int(m.group(1))
            last = f"returned {resp!r}"
        except OSError as e:
            # socket timeout / connection reset: the launch lost the cold-start
            # race. Retry with a fresh connection.
            last = repr(e)
        finally:
            s.close()
        if attempt + 1 < attempts:
            time.sleep(backoff)
    raise RuntimeError(f"qLaunchGDBServer failed: {last} after {attempts} attempts")


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


_TEST_TIMEOUT = 120  # seconds — each test launches Firefox + LLDB
_WATCHDOG_GRACE = 15  # extra slack before the thread watchdog force-kills


def _timeout_handler(signum, frame):
    raise TimeoutError("test exceeded %ds" % _TEST_TIMEOUT)


class TestBase(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.dbg = lldb.SBDebugger.Create()
        self.dbg.SetAsync(False)
        self._tmpdir = tempfile.mkdtemp(prefix="ff-bridge-")
        self._procs = []
        # A hung LLDB call blocks in C, where SIGALRM can't interrupt it — the
        # test would hang forever and leak its server + Firefox. A daemon thread
        # runs independently of that blocked C call, so on timeout it force-kills
        # the spawned servers; dropping the gdb connection unblocks the call, the
        # test fails, and tearDown cleans up instead of leaking.
        self._done = threading.Event()
        self._watchdog = threading.Thread(target=self._watchdog_run, daemon=True)
        self._watchdog.start()
        signal.signal(signal.SIGALRM, _timeout_handler)
        signal.alarm(_TEST_TIMEOUT)

    def tearDown(self):
        signal.alarm(0)  # cancel the alarm
        self._done.set()  # stop the watchdog
        self._kill_procs(signal.SIGTERM)
        lldb.SBDebugger.Destroy(self.dbg)
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _kill_procs(self, sig):
        """Kill every spawned server's process group (server + Firefox children)."""
        for proc in self._procs:
            try:
                os.killpg(os.getpgid(proc.pid), sig)
            except (ProcessLookupError, OSError):
                pass

    def _watchdog_run(self):
        if not self._done.wait(_TEST_TIMEOUT + _WATCHDOG_GRACE):
            self._kill_procs(signal.SIGKILL)

    def _spawn(self, argv, *, ready, timeout=30):
        """Start a subprocess; block until `ready` string appears in output."""
        proc = subprocess.Popen(
            argv,
            cwd=str(REPO),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            # New process group so killpg() also kills Firefox children.
            preexec_fn=os.setsid,
            # The server is session-detached, so if this test process is killed
            # it would orphan the server + Firefox. Tell it to exit when orphaned.
            env={**os.environ, "FIREFOX_LLDB_EXIT_WHEN_ORPHANED": "1"},
        )
        self._procs.append(proc)
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            if ready in line:
                return proc
        self.fail("server did not become ready: %s" % " ".join(str(a) for a in argv))

    def _start_platform(self, fx, timeout=120):
        """Start the unified CLI in launch+headless mode. Returns the platform port."""
        platform_port = free_port()
        rdp_port = free_port()
        static_server, http_port = start_static_server(str(REPO / fx["page_dir"]))
        self.addCleanup(static_server.shutdown)
        url = f"http://127.0.0.1:{http_port}/index.html"
        self._spawn(
            [
                NODE, "--import", "tsx",
                str(REPO / "src" / "cli" / "firefox-lldb-server.ts"),
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

    def _attach_via_platform(self, platform_port, pid=1):
        """Attach through the platform's `process attach` path (vAttach + wasm plugin).

        Exercises a different code path than _connect_via_platform: LLDB drives
        the session through ProcessGDBRemote with the wasm plugin and the
        component's vAttach support, rather than `process connect`.
        """
        target = self.dbg.CreateTarget("")
        ci = self.dbg.GetCommandInterpreter()

        def run(cmd):
            res = lldb.SBCommandReturnObject()
            ci.HandleCommand(cmd, res)
            self.assertTrue(res.Succeeded(), "%s: %s" % (cmd, res.GetError()))
            return res

        run("platform select remote-gdb-server")
        run("platform connect connect://127.0.0.1:%d" % platform_port)
        # `process attach --pid N` triggers qLaunchGDBServer;pid:N. The platform
        # resolves the tab (or, for an as-yet-unlisted tab, falls back to the
        # configured launch URL) and spawns the stub, which we drive with the
        # wasm plugin. No prior `platform process list` is required.
        run("process attach --plugin wasm --pid %d" % pid)
        process = target.GetProcess()
        self.assertTrue(process.IsValid(), "attached process is valid")
        return target, process

    def _stopped_at_breakpoint(self, fx):
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

    def _check_call_stack(self, fx):
        target, process = self._stopped_at_breakpoint(fx)
        self.assertGreaterEqual(target.GetNumModules(), 1)
        thread = process.GetThreadAtIndex(0)
        self.assertTrue(thread.IsValid())
        frame0 = thread.GetFrameAtIndex(0)
        self.assertTrue(frame0.IsValid())
        self.assertIn(fx["expect_func"], frame0.GetFunctionName() or "")
        self.assertEqual(
            frame0.GetLineEntry().GetFileSpec().GetFilename(), fx["expect_file"]
        )
