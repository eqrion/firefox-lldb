// Loads and instantiates the vendored gdbstub component (transpiled by jco).
//
// The component embeds the Rust `gdbstub` state machine, opens its own TCP
// listener (via the WASI sockets shim), and speaks the GDB remote protocol to
// LLDB. We supply the imported `debuggee` interface (the RDP bridge) plus a
// WASI environment.
//
// jco's generated module is treated as an untyped boundary: its emitted .d.ts
// disagrees with the runtime (versioned interface keys in the types,
// unversioned at runtime) and references DOM globals, so we wrap it behind a
// small hand-written contract instead.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WASIShim } from "@bytecodealliance/preview2-shim/instantiation";
import * as generated from "./generated/gdbstub.js";

const GENERATED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "generated");

type Instantiate = (
  getCoreModule: (corePath: string) => Promise<unknown>,
  imports: Record<string, unknown>
) => Promise<Record<string, unknown>>;

const instantiate = (generated as unknown as { instantiate: Instantiate }).instantiate;

/** The imported `debuggee` namespace: resource classes the component calls into. */
export interface DebuggeeImports {
  Debuggee: new (...args: never[]) => unknown;
  [resource: string]: unknown;
}

export interface GdbStubExports {
  debug(debuggee: unknown, args: string[]): void | Promise<void>;
}

export async function instantiateGdbStub(
  debuggee: DebuggeeImports,
  onInfo: (message: string) => void
): Promise<GdbStubExports> {
  const wasi = new WASIShim().getImportObject();
  const imports: Record<string, unknown> = {
    ...wasi,
    "print-debugger-info": { default: onInfo },
    "bytecodealliance:wasmtime/debuggee": debuggee,
  };

  const wasm = (globalThis as unknown as { WebAssembly: { compile(b: Uint8Array): Promise<unknown> } })
    .WebAssembly;
  const root = await instantiate(
    async (corePath) => wasm.compile(await readFile(path.join(GENERATED_DIR, corePath))),
    imports
  );
  return (root["debugger"] ?? root["bytecodealliance:wasmtime/debugger@44.0.0"]) as GdbStubExports;
}
