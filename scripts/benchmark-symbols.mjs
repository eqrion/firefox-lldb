/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Run with node --import tsx scripts/benchmark-symbols.mjs. Measures the real
// converter on a fixture and a synthetic many-function map, including timer
// delay on the thread that services RDP. No browser or logging load is present.
import { readFile } from "node:fs/promises";
import { convert } from "../src/sourcemap/converter.ts";

function leb(value) {
  const bytes = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
}

function manyFunctions(count) {
  const types = [1, 4, 1, 96, 0, 0];
  const declarations = [...leb(count), ...new Array(count).fill(0)];
  const functionSection = [3, ...leb(declarations.length), ...declarations];
  const code = [...leb(count), ...Array.from({ length: count }, () => [2, 0, 11]).flat()];
  const prefix = [
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...types,
    ...functionSection,
    10,
    ...leb(code.length),
  ];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const vlq = (value) => {
    let out = "";
    value *= 2;
    do {
      const digit = value % 32;
      value = Math.floor(value / 32);
      out += alphabet[digit | (value ? 32 : 0)];
    } while (value);
    return out;
  };
  const first = prefix.length + leb(count).length + 2;
  const mappings = [`${vlq(first)}AAA`, ...new Array(count - 1).fill("GACA")].join(",");
  return [
    new Uint8Array([...prefix, ...code]),
    Buffer.from(
      JSON.stringify({
        version: 3,
        sources: ["many.cpp"],
        sourcesContent: ["void f() {}"],
        names: [],
        mappings,
      })
    ),
  ];
}

const fixture = await Promise.all(
  ["math.wasm", "math.wasm.map"].map((name) => readFile(`test/fixtures/sourcemap/${name}`))
);
await convert(...fixture, "/benchmark");
for (const [name, input] of [
  ["fixture", fixture],
  ["10000-functions", manyFunctions(10_000)],
]) {
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    const timer = new Promise((resolve) => setTimeout(() => resolve(performance.now() - start), 0));
    const result = await convert(...input, "/benchmark");
    const elapsedMs = performance.now() - start;
    samples.push({ elapsedMs, timerDelayMs: await timer, outputBytes: result.wasm.length });
  }
  console.log(
    JSON.stringify({ name, wasmBytes: input[0].length, mapBytes: input[1].length, samples })
  );
}
