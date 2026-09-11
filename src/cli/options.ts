/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseArgs } from "node:util";
import type { FirefoxChannel } from "../core/firefox.js";
import type { RuntimeOptions } from "../core/platform-session.js";

const USAGE = `\
Usage: firefox-lldb-server [options]

Modes (default: --launch):
  --launch            Launch a fresh Firefox with a throwaway profile.
  --connect           Connect to an already-running Firefox.

Options:
  -p, --port <N>      Platform server RSP port (default: 1234).
  --rdp-port <N>      Firefox RDP port (default: 6080).
  --marionette-port <N>  Also start Marionette on this port (for a BiDi page
                      driver like firefox-devtools-mcp). Off by default.
  --url <U>           URL navigated to when LLDB spawns a process (connect or
                      attach). Firefox itself starts on about:blank.
  --firefox <path>    Firefox binary (default: auto-detected from standard locations).
  --beta              Auto-detect and launch the Beta channel instead of stable.
  --nightly           Auto-detect and launch the Nightly channel instead of stable.
  --default-profile   Reuse the channel's real default profile (history, logins,
                      extensions) instead of a throwaway one. Fails if that
                      profile is already running elsewhere.
  --headless          Run Firefox headlessly.
  --fire <js>         Evaluate JS after the first breakpoint arms (test use).
  -v, --verbose       Log debug output (may include page/protocol data).
  --log               Write a full session transcript (stdin, output, and debug
                      logging) to a file for bug reports; may include page and
                      protocol data.
  -h, --help          Show this message.

LLDB attach sequence:
  (lldb) platform select remote-gdb-server
  (lldb) platform connect connect://localhost:<port>
  (lldb) platform process list          # list open tabs
  (lldb) process attach --pid <N>       # attach to a wasm tab
`;

export interface Args extends RuntimeOptions {
  verbose: boolean;
  log: boolean;
}

export function parseCliArgs(argv: string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        connect: { type: "boolean" },
        launch: { type: "boolean" },
        headless: { type: "boolean" },
        port: { type: "string", short: "p" },
        "rdp-port": { type: "string" },
        "marionette-port": { type: "string" },
        url: { type: "string" },
        firefox: { type: "string" },
        beta: { type: "boolean" },
        nightly: { type: "boolean" },
        "default-profile": { type: "boolean" },
        fire: { type: "string" },
        verbose: { type: "boolean", short: "v" },
        log: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\ntry --help for usage.\n`);
    process.exit(1);
  }

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const port = Number(values.port ?? 1234);
  const rdpPort = Number(values["rdp-port"] ?? 6080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(
      `error: --port must be an integer from 0 to 65535, got "${values.port}"\n`
    );
    process.exit(1);
  }
  if (!Number.isInteger(rdpPort) || rdpPort < 1 || rdpPort > 65535) {
    process.stderr.write(
      `error: --rdp-port must be an integer from 1 to 65535, got "${values["rdp-port"]}"\n`
    );
    process.exit(1);
  }
  let marionettePort: number | undefined;
  if (values["marionette-port"] !== undefined) {
    marionettePort = Number(values["marionette-port"]);
    if (!Number.isInteger(marionettePort) || marionettePort < 1 || marionettePort > 65535) {
      process.stderr.write(
        `error: --marionette-port must be an integer from 1 to 65535, got "${values["marionette-port"]}"\n`
      );
      process.exit(1);
    }
  }
  if (values.beta && values.nightly) {
    process.stderr.write("error: --beta and --nightly are mutually exclusive\n");
    process.exit(1);
  }
  if (values.firefox && (values.beta || values.nightly)) {
    process.stderr.write("error: --firefox already specifies a binary; drop --beta/--nightly\n");
    process.exit(1);
  }
  const channel: FirefoxChannel = values.beta ? "beta" : values.nightly ? "nightly" : "release";

  return {
    connect: values.launch ? false : !!values.connect,
    headless: !!values.headless,
    port,
    rdpPort,
    marionettePort,
    url: values.url,
    firefox: values.firefox,
    channel,
    defaultProfile: !!values["default-profile"],
    fire: values.fire,
    verbose: !!values.verbose,
    log: !!values.log,
  };
}
