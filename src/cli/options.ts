/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseArgs } from "node:util";
import type { FirefoxChannel } from "../source-debugger/target/firefox/rdp/firefox.js";

const USAGE = `\
Usage: firefox-wasm-debugger [options]

Modes (default: --launch):
  --launch            Launch a fresh Firefox with a throwaway profile.
  --connect           Connect to an already-running Firefox.

Options:
  --rdp-port <N>      Firefox RDP port (default: 6080).
  --marionette-port <N>  Also start Marionette on this port (for a page driver).
  --url <U>           Navigate to this URL and attach automatically.
  --firefox <path>    Firefox binary (default: auto-detected).
  --beta              Launch Firefox Beta instead of stable.
  --nightly           Launch Firefox Nightly instead of stable.
  --default-profile   Reuse the channel's real default profile.
  --headless          Run Firefox headlessly.
  --fire <js>         Evaluate JS after the first breakpoint arms (test use).
  --component <ID=TEXT>  Route matching Wasm module URLs to a component.
                      Repeat to configure multiple components.
  -v, --verbose       Log debug output (may include page/protocol data).
  -h, --help          Show this message.
`;

export interface FirefoxWasmDebuggerCliOptions {
  connect: boolean;
  headless: boolean;
  rdpPort: number;
  marionettePort?: number;
  url?: string;
  firefox?: string;
  channel: FirefoxChannel;
  defaultProfile: boolean;
  fire?: string;
  components: string[];
  verbose: boolean;
}

export function parseCliArgs(argv: string[]): FirefoxWasmDebuggerCliOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        connect: { type: "boolean" },
        launch: { type: "boolean" },
        headless: { type: "boolean" },
        "rdp-port": { type: "string" },
        "marionette-port": { type: "string" },
        url: { type: "string" },
        firefox: { type: "string" },
        beta: { type: "boolean" },
        nightly: { type: "boolean" },
        "default-profile": { type: "boolean" },
        fire: { type: "string" },
        component: { type: "string", multiple: true },
        verbose: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\ntry --help for usage.\n`);
    process.exit(1);
  }

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const rdpPort = parsePort("--rdp-port", values["rdp-port"] ?? "6080");
  const marionettePort =
    values["marionette-port"] === undefined
      ? undefined
      : parsePort("--marionette-port", values["marionette-port"]);

  if (values.beta && values.nightly) {
    fail("--beta and --nightly are mutually exclusive");
  }
  if (values.firefox && (values.beta || values.nightly)) {
    fail("--firefox already specifies a binary; drop --beta/--nightly");
  }

  return {
    connect: values.launch ? false : !!values.connect,
    headless: !!values.headless,
    rdpPort,
    marionettePort,
    url: values.url,
    firefox: values.firefox,
    channel: values.beta ? "beta" : values.nightly ? "nightly" : "release",
    defaultProfile: !!values["default-profile"],
    fire: values.fire,
    components: values.component ?? [],
    verbose: !!values.verbose,
  };
}

function parsePort(name: string, raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`${name} must be an integer from 1 to 65535, got "${raw}"`);
  }
  return port;
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}
