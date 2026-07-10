/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// RSP man-in-the-middle that makes the gdbstub component obey LLDB's native
// `process attach` contract.
//
// The component presents an already-attached, stopped process (pid 1) the
// instant LLDB connects. LLDB's PlatformRemoteGDBServer::Attach connects first
// (ConnectRemote, which then treats the connection as a completed attach and
// relocates modules) and THEN calls Process::Attach, whose ClearAllLoadedSections
// wipes that relocation without reapplying it — so breakpoints never arm.
//
// A real lldb-server spawned for attach is *unattached* on connect: ConnectRemote
// sees no process and defers everything to the `vAttach` that Process::Attach
// sends. This shim emulates that: until it sees `vAttach`, it answers the three
// pid-discovery queries LLDB uses (qProcessInfo -> chain) as "no process yet",
// so ConnectRemote lands in eStateConnected and the real attach happens at
// vAttach. Once vAttach is forwarded, the shim is a transparent byte pipe, so
// no binary RSP payloads are ever parsed.

import net from "node:net";

// Replies that keep LLDB's ConnectRemote in eStateConnected (no process yet),
// so the real attach happens at vAttach. LLDB derives the current pid from this
// set (qProcessInfo -> qC -> qfThreadInfo chain, plus the `?` stop reply).
//   - `?`  -> E02  (LLGS Handle_stop_reason with no process)
//   - qC   -> E44  (LLGS Handle_qC, error 68)
//   - qProcessInfo -> E01 (transient error: pid invalid, packet not marked
//     unsupported, so the post-vAttach arch query still works)
//   - qfThreadInfo -> E01. NOT an empty list (`l`) or `OK`: GetCurrentProcess-
//     AndThreadIDs has a "bare-iron target" fallback that assumes pid=tid=1
//     when qfThreadInfo gives a *normal* response with no threads. An error
//     response is neither normal nor unsupported, so it skips that fallback.
const PRE_ATTACH_REPLIES: Record<string, string> = {
  "?": "E02",
  qProcessInfo: "E01",
  qC: "E44",
  qfThreadInfo: "E01",
};

function checksum(payload: string): string {
  let sum = 0;
  for (let i = 0; i < payload.length; i++) sum = (sum + payload.charCodeAt(i)) & 0xff;
  return sum.toString(16).padStart(2, "0");
}

function frame(payload: string): Buffer {
  return Buffer.from(`$${payload}#${checksum(payload)}`, "latin1");
}

export interface AttachShim {
  port: number;
  close(): Promise<void>;
}

/**
 * Start an RSP shim listening on `listenPort` that forwards to a gdbstub
 * component on `componentPort`, emulating an unattached server until `vAttach`.
 */
export function startAttachShim(opts: {
  listenPort: number;
  componentPort: number;
  host?: string;
  trace?: (m: string) => void;
}): Promise<AttachShim> {
  const host = opts.host ?? "127.0.0.1";
  const trace = opts.trace;

  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    const upstream = net.connect(opts.componentPort, host);
    let attached = false;
    let noAck = false;
    let buf = Buffer.alloc(0);

    // component -> LLDB is always a transparent pipe.
    upstream.on("data", (d) => client.write(d));
    upstream.on("close", () => {
      // When the component closes after vAttach, send a clean exit notification
      // so LLDB reports "exited with status = 0" instead of "lost connection".
      if (attached && client.writable) client.write(frame("W00"));
      client.end();
    });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.end());
    client.on("error", () => upstream.destroy());

    const replyToClient = (payload: string) => {
      if (!noAck) client.write("+");
      client.write(frame(payload));
    };

    client.on("data", (chunk) => {
      if (attached) {
        upstream.write(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);

      // Parse complete RSP units out of `buf`. Pre-attach traffic is all simple
      // ASCII query packets (no `}`-escaped binary), so locating `#` is safe.
      for (;;) {
        if (buf.length === 0) break;
        const b0 = buf[0];

        // Acks / interrupt: forward the single byte untouched.
        if (b0 === 0x2b /* + */ || b0 === 0x2d /* - */ || b0 === 0x03 /* ^C */) {
          upstream.write(buf.subarray(0, 1));
          buf = buf.subarray(1);
          continue;
        }

        if (b0 === 0x24 /* $ */) {
          const hash = buf.indexOf(0x23 /* # */);
          if (hash === -1 || buf.length < hash + 3) break; // incomplete packet
          const payload = buf.toString("latin1", 1, hash);
          const raw = buf.subarray(0, hash + 3);
          buf = buf.subarray(hash + 3);

          if (payload.startsWith("QStartNoAckMode")) {
            upstream.write(raw);
            noAck = true;
            continue;
          }
          if (payload.startsWith("vAttach")) {
            upstream.write(raw);
            attached = true;
            trace?.("vAttach forwarded; switching to transparent pipe");
            if (buf.length) {
              upstream.write(buf);
              buf = Buffer.alloc(0);
            }
            return;
          }
          const synthetic = PRE_ATTACH_REPLIES[payload];
          if (synthetic !== undefined) {
            trace?.(`intercept ${payload} -> ${synthetic}`);
            replyToClient(synthetic);
            continue;
          }
          upstream.write(raw);
          continue;
        }

        // Unexpected leading byte: forward it and resync.
        upstream.write(buf.subarray(0, 1));
        buf = buf.subarray(1);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.listenPort, host, () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => {
          // Without this, server.close() would wait indefinitely for LLDB
          // (or the upstream component connection) to disconnect voluntarily.
          for (const s of sockets) s.destroy();
          return new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}
