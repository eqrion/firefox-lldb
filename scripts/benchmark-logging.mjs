/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Replay real transcript records through the production writer. This measures
// formatting and buffered synchronous writes, not producer-side serialization,
// filesystem durability (there is no fsync), or end-to-end debugger latency.
// Usage: node --import tsx scripts/benchmark-logging.mjs SESSION.log [...]

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionLog } from "../src/diagnostics/session-log.ts";

const inputs = process.argv.slice(2);
if (!inputs.length) throw new Error("Pass one or more existing session transcript paths");
const outputDir = mkdtempSync(join(tmpdir(), "firefox-lldb-log-benchmark-"));
const samples = 7;
const results = [];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 1000) / 1000;

for (const input of inputs) {
  const records = readFileSync(input, "utf8")
    .split("\n")
    .flatMap((line) => {
      const match = /^\d{2}:\d{2}:\d{2}\.\d{3} (stdin|stdout|stderr|debug)\s+(.*)$/.exec(line);
      return match ? [{ kind: match[1], text: match[2] }] : [];
    });
  assert.ok(records.length, `No transcript records found in ${input}`);
  const timings = [];
  // One warmup followed by measured samples, each with its own writer/file.
  for (let sample = -1; sample < samples; sample++) {
    const path = join(outputDir, "replay.log");
    const log = openSessionLog(path, ["logging-replay", input]);
    const cpu = process.cpuUsage();
    const start = performance.now();
    let maxRecordMs = 0;
    for (const record of records) {
      const before = performance.now();
      log.record(record.kind, record.text);
      maxRecordMs = Math.max(maxRecordMs, performance.now() - before);
    }
    log.flush();
    const elapsedMs = performance.now() - start;
    const usage = process.cpuUsage(cpu);
    const bytes = statSync(path).size;
    assert.equal(log.failure, undefined, `Replay failed; file retained at ${path}`);
    // Verify the replay before removing only this benchmark-owned file. Open,
    // close, readback, and removal are outside the timed region.
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("#"));
    assert.equal(lines.length - 1, records.length);
    log.close({ remove: true });
    if (sample >= 0)
      timings.push({ elapsedMs, cpuMs: (usage.user + usage.system) / 1000, maxRecordMs, bytes });
  }
  results.push({
    input,
    records: records.length,
    outputBytes: timings[0].bytes,
    medianReplayMs: round(median(timings.map((t) => t.elapsedMs))),
    medianCpuMs: round(median(timings.map((t) => t.cpuMs))),
    medianMsPer1000Records: round(
      (median(timings.map((t) => t.elapsedMs)) * 1000) / records.length
    ),
    worstRecordMs: round(Math.max(...timings.map((t) => t.maxRecordMs))),
    samples: timings.map((t) => ({
      elapsedMs: round(t.elapsedMs),
      cpuMs: round(t.cpuMs),
      maxRecordMs: round(t.maxRecordMs),
    })),
  });
}
rmdirSync(outputDir);
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      samples,
      scope: "record formatting and buffered writes only; not end-to-end overhead",
      results,
    },
    null,
    2
  )
);
