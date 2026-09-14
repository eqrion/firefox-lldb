/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Own the build flags for checked-in wasm. Lockfiles alone do not normalize
// source paths, codegen partitions or the linker's host-dependent thread count.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const component = process.argv[2];
if (!["gdbstub-component", "source-map-dwarf-component"].includes(component)) {
  throw new Error("expected gdbstub-component or source-map-dwarf-component");
}
if (process.env.RUSTFLAGS || process.env.CARGO_ENCODED_RUSTFLAGS) {
  throw new Error("unset RUSTFLAGS/CARGO_ENCODED_RUSTFLAGS for reproducible component builds");
}
const cargoHome = resolve(process.env.CARGO_HOME || join(homedir(), ".cargo"));
const flags = [
  `--remap-path-prefix=${cargoHome}=/cargo`,
  `--remap-path-prefix=${root}=/firefox-lldb`,
  "-Ccodegen-units=1",
  "-Clink-arg=--threads=1",
];
const result = spawnSync("cargo", ["build", "--locked", "--release", "--target", "wasm32-wasip2"], {
  cwd: join(root, "vendor", component),
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") },
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`component build terminated by ${result.signal}`);
process.exitCode = result.status ?? 1;
