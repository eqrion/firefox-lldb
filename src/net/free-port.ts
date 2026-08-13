/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import net from "node:net";
import type { AddressInfo } from "node:net";

// TOCTOU: this probes an OS-assigned port and releases it before the caller
// binds. Use port 0 directly whenever the receiving API supports it.
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}
