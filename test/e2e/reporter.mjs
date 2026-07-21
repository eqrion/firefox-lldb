/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Custom test reporter for the e2e-node suite: prints each test name as soon
// as it starts (so you can see what's in progress), then prints a pass/fail
// line when it completes. Failures are also shown in a block at the end.

import path from "node:path";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

// A custom reporter replaces node:test's own output entirely -- console.log/
// error calls inside a test file arrive here as test:stdout/test:stderr
// events, not on the real stdout/stderr fds. Route verbose diagnostics back to
// the real stderr fd instead of yielding them as reporter output: CI redirects
// stderr to a trace file, keeping multi-megabyte RSP logs off the live Actions
// stream while still making their tail available on failure.
const VERBOSE = process.env.DEBUG === "1";

export async function* report(
  source,
  { verbose = VERBOSE, writeDiagnostic = (message) => process.stderr.write(message) } = {}
) {
  let pass = 0;
  let fail = 0;
  const failures = [];

  for await (const event of source) {
    const { type, data } = event;
    const indent = "  ".repeat(data?.nesting ?? 0);

    switch (type) {
      case "test:start": {
        const file = data.file ? ` [${path.basename(data.file)}]` : "";
        yield `${indent}▶ ${data.name}${file}\n`;
        break;
      }
      case "test:stdout":
      case "test:stderr": {
        if (verbose) writeDiagnostic(data.message);
        break;
      }
      case "test:pass": {
        if (data.skip) break;
        pass++;
        const ms = Math.round(data.details?.duration_ms ?? 0);
        yield `${indent}${GREEN}✓${RESET} ${data.name} ${DIM}(${ms}ms)${RESET}\n`;
        break;
      }
      case "test:fail": {
        fail++;
        const ms = Math.round(data.details?.duration_ms ?? 0);
        yield `${indent}${RED}✗${RESET} ${data.name} ${DIM}(${ms}ms)${RESET}\n`;
        const err = data.details?.error;
        if (err) {
          failures.push({ name: data.name, err });
          for (const line of (err.message ?? "").split("\n")) {
            yield `${indent}  ${RED}${line}${RESET}\n`;
          }
        }
        break;
      }
    }
  }

  const failColor = fail > 0 ? RED : "";
  yield `\n${GREEN}${pass} passed${RESET}, ${failColor}${fail} failed${fail > 0 ? RESET : ""}\n`;

  for (const { name, err } of failures) {
    yield `\n${RED}FAIL:${RESET} ${name}\n`;
    const stack = err.stack ?? err.message ?? String(err);
    for (const line of stack.split("\n")) {
      yield `  ${line}\n`;
    }
  }
}

export default report;
