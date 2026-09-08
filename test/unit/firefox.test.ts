/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { findFirefoxBinary, launchFirefox } from "../../src/rdp/firefox.js";
import net from "node:net";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
  return port;
}

test("findFirefoxBinary returns a string or undefined (never throws)", () => {
  let result: string | undefined;
  assert.doesNotThrow(() => {
    result = findFirefoxBinary();
  });
  assert.ok(
    result === undefined || typeof result === "string",
    `expected string or undefined, got ${typeof result}`
  );
});

test("findFirefoxBinary result, when present, is a non-empty path string", () => {
  const result = findFirefoxBinary();
  if (result !== undefined) {
    assert.ok(result.length > 0, "binary path should not be empty");
    assert.match(result, /firefox/i, "path should contain 'firefox'");
  }
});

for (const channel of ["beta", "nightly"] as const) {
  test(`findFirefoxBinary(${channel}) returns a string or undefined (never throws)`, () => {
    let result: string | undefined;
    assert.doesNotThrow(() => {
      result = findFirefoxBinary(channel);
    });
    assert.ok(
      result === undefined || typeof result === "string",
      `expected string or undefined, got ${typeof result}`
    );
  });
}

test("launchFirefox rejects a spawn failure instead of emitting an unhandled child error", async () => {
  await assert.rejects(
    launchFirefox({
      rdpPort: await freePort(),
      binary: "/definitely/not/a/firefox-binary",
      headless: true,
    }),
    /could not start Firefox/
  );
});

test("launchFirefox creates its configured log directory and bounds normal cleanup", async (t) => {
  if (process.platform === "win32") {
    t.skip("fixture uses a POSIX shell script");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "firefox-lldb-launch-test-"));
  const binary = join(root, "fake-firefox");
  const logDir = join(root, "nested", "logs");
  const previousLogDir = process.env.FIREFOX_LLDB_LOG_DIR;
  let firefox: Awaited<ReturnType<typeof launchFirefox>> | undefined;
  try {
    await writeFile(binary, "#!/bin/sh\nwhile :; do sleep 60; done\n");
    await chmod(binary, 0o755);
    process.env.FIREFOX_LLDB_LOG_DIR = logDir;
    firefox = await launchFirefox({
      rdpPort: await freePort(),
      binary,
      headless: true,
    });
    assert.equal((await stat(logDir)).isDirectory(), true);
    await firefox.close();
  } finally {
    await firefox?.close().catch(() => {});
    if (previousLogDir === undefined) delete process.env.FIREFOX_LLDB_LOG_DIR;
    else process.env.FIREFOX_LLDB_LOG_DIR = previousLogDir;
    await rm(root, { recursive: true, force: true });
  }
});
