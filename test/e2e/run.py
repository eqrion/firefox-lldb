#!/usr/bin/env python3
"""firefox-lldb e2e test suite runner.

Usage:
    python3 test/e2e/run.py [--core] [-j JOBS]

Options:
    --core      Run only the core subset (call-stack, locals, control-flow)
    -j JOBS     Parallel workers (default: 4)

Environment variables (forwarded to each worker):
    LLDB                  Path to the wasm-plugin lldb binary (default: "lldb")
    LLDB_PYTHON_PATH      lldb Python module dir override
    FIREFOX_LLDB_NODE     Node binary (default: "node")
"""

import argparse
import concurrent.futures
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Core tests run on every PR.
CORE_MODULES = [
    "test_call_stack",
    "test_locals",
    "test_control_flow",
]

# Extended tests run on push to main or on demand.
EXTENDED_MODULES = [
    "test_attach",
    "test_inspect_types",
    "test_inspect_heap",
    "test_recursion",
    "test_source_listing",
    "test_edge_cases",
    "test_js_debugging",
    "test_threaded",
    "test_wasm_trap",
    "test_mixed_js",
]


def _build_env():
    """Return an env dict with LLDB resolved to an absolute path."""
    env = os.environ.copy()
    lldb = env.get("LLDB", "lldb")
    if lldb != "lldb":
        resolved = Path(lldb).resolve()
        if resolved.exists():
            env["LLDB"] = str(resolved)
    return env


_ENV = _build_env()


def _run_module(module):
    result = subprocess.run(
        [sys.executable, "-m", "unittest", module, "-v"],
        cwd=str(HERE),
        env=_ENV,
        capture_output=True,
        text=True,
    )
    return module, result.returncode, result.stdout + result.stderr


def main():
    parser = argparse.ArgumentParser(description="firefox-lldb e2e test runner")
    parser.add_argument("--core", action="store_true",
                        help="Run only core tests (call-stack, locals, control-flow)")
    parser.add_argument("-j", "--jobs", type=int, default=4,
                        help="Parallel workers (default: 4)")
    args = parser.parse_args()

    modules = CORE_MODULES if args.core else CORE_MODULES + EXTENDED_MODULES
    print(f"Running {len(modules)} module(s) with {args.jobs} parallel worker(s)...")

    failed = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as executor:
        futures = {executor.submit(_run_module, m): m for m in modules}
        for future in concurrent.futures.as_completed(futures):
            name, rc, output = future.result()
            status = "PASS" if rc == 0 else "FAIL"
            print(f"\n{'=' * 60}\n[{status}] {name}\n{'=' * 60}")
            print(output, end="")
            if rc != 0:
                failed.append(name)

    print(f"\n{'=' * 60}")
    if failed:
        print(f"FAILED ({len(failed)}/{len(modules)}): {', '.join(sorted(failed))}")
        sys.exit(1)
    else:
        print(f"All {len(modules)} module(s) passed.")


if __name__ == "__main__":
    main()
