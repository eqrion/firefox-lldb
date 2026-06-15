"""
TDD harness: drive a real lldb wasm client against OUR gdbstub component,
backed by a deterministic FakeDebuggee (no Firefox needed). Modeled on
llvm's lldb/test/.../TestWasm.py, but lldb connects to our real server.

Run with the lldb we built (has the wasm plugin + python):
  build/bin/lldb-dotest -p TestRdpBridge.py /path/to/firefox-lldb/test/lldb
"""

import lldb
import os
import json
import socket
import subprocess
import time
from lldbsuite.test.lldbtest import *
from lldbsuite.test.decorators import *

# Absolute paths (this file is symlinked into the lldb test tree, so __file__
# can't locate the repo). Override with FIREFOX_LLDB_REPO if needed.
REPO = os.environ.get("FIREFOX_LLDB_REPO", "/Users/ryanhunt/src/wasm-debug/firefox-lldb")
WASM_DEBUG = os.path.abspath(os.path.join(REPO, ".."))
NODE = os.environ.get("FIREFOX_LLDB_NODE", os.path.expanduser("~/.nvm/versions/node/v24.14.0/bin/node"))
MATH_WASM = os.path.join(WASM_DEBUG, "examples", "simple", "math.wasm")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class TestRdpBridge(TestBase):
    NO_DEBUG_INFO_TESTCASE = True

    def _start_server(self, config):
        port = free_port()
        cfg_path = self.getBuildArtifact("fake-config.json")
        with open(cfg_path, "w") as f:
            json.dump(config, f)
        proc = subprocess.Popen(
            [NODE, "--experimental-wasm-jspi", "--import", "tsx",
             os.path.join(REPO, "src", "cli", "fake-wasm-server.ts"),
             "--config", cfg_path, "--port", str(port)],
            cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        self.addTearDownHook(lambda: proc.kill())
        # Wait for "listening".
        deadline = time.time() + 30
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            if "listening" in line:
                return port
        self.fail("fake-wasm-server did not start listening")

    def _connect(self, port):
        target = self.dbg.CreateTarget("")
        error = lldb.SBError()
        process = target.ConnectRemote(
            self.dbg.GetListener(), "connect://127.0.0.1:%d" % port, "wasm", error
        )
        self.assertTrue(error.Success(), "connect: %s" % error.GetCString())
        return target, process

    @skipIfAsan
    @skipIfXmlSupportMissing
    def test_wasm_call_stack_and_symbols(self):
        """lldb connects to our component, loads the wasm module, and resolves
        the wasm call stack to source via the embedded DWARF."""
        port = self._start_server(
            {"modulePath": MATH_WASM, "callStack": [0x1B0]}  # compute_factorial
        )
        target, process = self._connect(port)

        self.assertEqual(target.GetNumModules(), 1)

        thread = process.GetThreadAtIndex(0)
        self.assertTrue(thread.IsValid())
        frame0 = thread.GetFrameAtIndex(0)
        self.assertTrue(frame0.IsValid())
        self.assertIn("compute_factorial", frame0.GetFunctionName())
        line_entry = frame0.GetLineEntry()
        self.assertEqual(line_entry.GetFileSpec().GetFilename(), "math.cpp")
