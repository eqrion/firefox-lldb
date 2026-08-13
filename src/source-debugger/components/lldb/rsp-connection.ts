/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import net from "node:net";

/** Private LLDB-engine byte stream. RSP does not cross the
 * SourceDebuggerComponentHost boundary; both this connection and its TCP
 * socket live inside the LLDB component isolation domain. */
export interface LldbRspConnection {
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export async function connectLldbRsp(tcpPort: number): Promise<LldbRspConnection> {
  const socket = net.connect(tcpPort, "127.0.0.1");
  socket.setNoDelay(true);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const chunks: Uint8Array[] = [];
  const readers: Array<(data: Uint8Array | null) => void> = [];
  let ended = false;

  const finish = (): void => {
    if (ended) return;
    ended = true;
    for (const resolve of readers.splice(0)) resolve(null);
  };
  socket.on("data", (data) => {
    const chunk = new Uint8Array(data);
    const reader = readers.shift();
    if (reader) reader(chunk);
    else chunks.push(chunk);
  });
  socket.on("close", finish);
  socket.on("error", finish);

  return {
    read(): Promise<Uint8Array | null> {
      const chunk = chunks.shift();
      if (chunk) return Promise.resolve(chunk);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => readers.push(resolve));
    },
    write(data: Uint8Array): Promise<void> {
      if (ended) return Promise.reject(new Error("LLDB RSP connection is closed"));
      return new Promise((resolve, reject) =>
        socket.write(Buffer.from(data), (error) => (error ? reject(error) : resolve()))
      );
    },
    async close(): Promise<void> {
      if (ended) return;
      finish();
      socket.destroy();
    },
  };
}
