/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./harness.mjs";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Move real fixture custom sections before code. DWARF addresses are relative
// to the code section; source-map columns instead need the file-offset delta.
function reorderedFixture() {
  let delta;
  return (path, bytes) => {
    if (path.endsWith(".wasm")) {
      let pos = 8,
        oldCode,
        codeInStandard = 8;
      const custom = [],
        standard = [];
      while (pos < bytes.length) {
        const start = pos,
          id = bytes[pos++];
        let size = 0,
          shift = 0,
          byte;
        do {
          byte = bytes[pos++];
          size += (byte & 127) * 2 ** shift;
          shift += 7;
        } while (byte & 128);
        pos += size;
        const section = bytes.subarray(start, pos);
        (id === 0 ? custom : standard).push(section);
        if (id === 10) oldCode = start;
        else if (id !== 0 && oldCode === undefined) codeInStandard += section.length;
      }
      assert.notEqual(oldCode, undefined);
      delta = codeInStandard + custom.reduce((n, section) => n + section.length, 0) - oldCode;
      assert.ok(delta > 0);
      return Buffer.concat([bytes.subarray(0, 8), ...custom, ...standard]);
    }
    if (path.endsWith(".wasm.map")) {
      assert.notEqual(delta, undefined, "the browser requests wasm before its source map");
      const map = JSON.parse(bytes);
      let pos = 0,
        value = 0,
        shift = 0,
        digit;
      do {
        digit = alphabet.indexOf(map.mappings[pos++]);
        value += (digit & 31) * 2 ** shift;
        shift += 5;
      } while (digit & 32);
      assert.equal(value & 1, 0, "the first generated offset is nonnegative");
      value += delta * 2;
      let encoded = "";
      do {
        digit = value % 32;
        value = Math.floor(value / 32);
        encoded += alphabet[digit | (value ? 32 : 0)];
      } while (value);
      map.mappings = encoded + map.mappings.slice(pos);
      return Buffer.from(JSON.stringify(map));
    }
    return bytes;
  };
}

for (const fixture of ["factorial", "sourcemap_factorial"]) {
  test(
    `custom sections before code preserve breakpoint and step offsets: ${fixture}`,
    { timeout: 45_000 },
    async (t) => {
      const session = await Session.stoppedAtBreakpoint(fixture, {
        setupAttempts: 1,
        transformResponse: reorderedFixture(),
      });
      t.after(() => session.shutdown());
      const before = await session.topFrame();
      assert.match(before.function, /compute_factorial/);
      assert.match(before.file, /math\.cpp$/);
      await session.stepInstruction();
      const after = await session.topFrame();
      assert.match(after.function, /compute_factorial/);
      assert.notEqual(after.pc, before.pc);
    }
  );
}
