// Standalone gdbstub server backed by a deterministic FakeDebuggee, for driving
// lldb in tests without a live Firefox. Config comes from a JSON file:
//   { "modulePath": "...wasm", "callStack": [0x1b0],
//     "frameLocals": [[0,0,66016]], "memory": {"base":65536,"bytesHex":"00.."} }
//
// Run with Node >=24 + --experimental-wasm-jspi:
//   node --experimental-wasm-jspi --import tsx fake-wasm-server.ts --config c.json --port 8123

import { readFile } from "node:fs/promises";
import { FakeDebuggee, type FakeConfig } from "../gdb/fake-debuggee.js";
// @ts-expect-error - .mjs host has no type declarations
import { startGdbServer } from "../gdb/worker/host.mjs";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const configPath = arg("--config");
  const port = Number(arg("--port", "8123"));
  if (!configPath) throw new Error("--config <json> required");

  const cfg = JSON.parse(await readFile(configPath, "utf8")) as {
    modulePath: string;
    callStack: number[];
    frameLocals?: number[][];
    memory?: { base: number; size: number; bytesHex: string };
  };

  const fake: FakeConfig = {
    bytecode: new Uint8Array(await readFile(cfg.modulePath)),
    callStack: cfg.callStack,
    frameLocals: cfg.frameLocals,
    memory: cfg.memory
      ? {
          base: cfg.memory.base,
          size: cfg.memory.size,
          bytes: Uint8Array.from(Buffer.from(cfg.memory.bytesHex, "hex")),
        }
      : undefined,
  };

  const debuggee = new FakeDebuggee(fake);
  const { ready } = startGdbServer({
    dispatch: (req: unknown) => debuggee.dispatch(req as never),
    port,
    onInfo: (m: string) => console.error(`[component] ${m}`),
  });
  await ready;
  console.error(`fake-wasm-server listening on ${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
