/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

test("component builds own locked inputs, normalized paths and codegen settings", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "component-build-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "bin"));
  for (const component of ["gdbstub-component", "source-map-dwarf-component"]) {
    mkdirSync(join(dir, "vendor", component), { recursive: true });
  }
  const script = join(dir, "scripts/build-component.mjs");
  copyFileSync("scripts/build-component.mjs", script);
  writeFileSync(
    join(dir, "bin/cargo"),
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  flags: process.env.CARGO_ENCODED_RUSTFLAGS.split("\\x1f")
}));
process.exitCode = Number(process.env.COMPONENT_TEST_EXIT || 0);
`,
    { mode: 0o755 }
  );
  const env = {
    ...process.env,
    PATH: join(dir, "bin") + delimiter + process.env.PATH,
    CARGO_HOME: join(dir, "cargo home"),
    RUSTFLAGS: "",
    CARGO_ENCODED_RUSTFLAGS: "",
  };
  const run = (component, overrides = {}) =>
    spawnSync(process.execPath, [script, component], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...env, ...overrides },
    });
  for (const component of ["gdbstub-component", "source-map-dwarf-component"]) {
    const result = run(component);
    assert.equal(result.status, 0, result.stderr);
    const invocation = JSON.parse(result.stdout);
    assert.deepEqual(invocation.args, [
      "build",
      "--locked",
      "--release",
      "--target",
      "wasm32-wasip2",
    ]);
    assert.equal(invocation.cwd, join(dir, "vendor", component));
    assert.deepEqual(invocation.flags, [
      `--remap-path-prefix=${env.CARGO_HOME}=/cargo`,
      `--remap-path-prefix=${dir}=/firefox-lldb`,
      "-Ccodegen-units=1",
      "-Clink-arg=--threads=1",
    ]);
  }
  assert.equal(run("gdbstub-component", { COMPONENT_TEST_EXIT: "17" }).status, 17);
  for (const override of [{ RUSTFLAGS: "-Copt-level=0" }, { CARGO_ENCODED_RUSTFLAGS: "-g" }]) {
    const result = run("gdbstub-component", override);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "", "custom flags must fail before invoking Cargo");
    assert.match(result.stderr, /unset RUSTFLAGS/);
  }
});

test("component regeneration patches are idempotent and fail closed on changed output", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gdbstub-regeneration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "src/gdb/generated"), { recursive: true });
  const script = join(dir, "scripts/patch-generated.mjs");
  copyFileSync("scripts/patch-generated.mjs", script);
  const file = join(dir, "src/gdb/generated/gdbstub.js");
  const generated = readFileSync("src/gdb/generated/gdbstub.js", "utf8");
  const unpatched = generated
    .replace("let currentSubtask; // jco-patch", "")
    .replace("this.#getComponentState().handles.remove(this.waitableRep()); // jco-patch", "");
  const run = () => spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 5000 });
  writeFileSync(file, unpatched);
  assert.equal(run().status, 0);
  const patched = readFileSync(file, "utf8");
  assert.equal(run().status, 0);
  assert.equal(readFileSync(file, "utf8"), patched);
  for (const broken of [
    unpatched + "\nthis.#parentTask.removeSubtask(this);",
    unpatched.replace("this.#parentTask.removeSubtask(this);", ""),
  ]) {
    writeFileSync(file, broken);
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected one anchor/);
    assert.equal(
      readFileSync(file, "utf8"),
      broken,
      "failed validation must not partially patch output"
    );
  }
});
