/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Defers process publication until vAttach so LLDB preserves module relocation.
// After attach it forwards bytes unchanged. See docs/COMPATIBILITY.md.

import net from "node:net";
import { PacketParser, framePacket } from "./packet.js";

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
  /** Validate the user-facing platform PID encoded in vAttach. */
  isValidPid?: (pid: number) => boolean;
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
    const parser = new PacketParser(64 * 1024);
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));

    // component -> LLDB is always a transparent pipe.
    upstream.pipe(client);
    upstream.on("close", () => {
      // EOF is not a process exit status. In particular, detach already sent
      // its reply; inventing W00 here races LLDB closing its channel. Only the
      // component can report a target exit, through the transparent data path.
      trace?.("component connection closed; forwarding EOF");
      client.end();
    });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    client.on("error", () => upstream.destroy());

    const resumeClient = () => {
      if (!upstream.writableNeedDrain && !client.writableNeedDrain) client.resume();
    };
    upstream.on("drain", resumeClient);
    client.on("drain", resumeClient);
    const write = (destination: net.Socket, bytes: string | Uint8Array) => {
      if (!destination.write(bytes)) client.pause();
      // A single pre-attach chunk can contain many packets, so pausing reads
      // alone does not bound the writes made while processing that chunk.
      if (destination.writableLength > 4 * 1024 * 1024) {
        trace?.("attach connection closed: 4 MiB queued output limit");
        client.destroy();
        upstream.destroy();
      }
    };

    const replyToClient = (payload: string) => {
      if (!noAck) write(client, "+");
      write(client, framePacket(payload));
    };

    client.on("data", (chunk) => {
      if (attached) {
        write(upstream, chunk);
        return;
      }
      try {
        let input = chunk;
        for (;;) {
          if (client.destroyed || upstream.destroyed) return;
          const [item] = parser.feed(input, 1);
          input = Buffer.alloc(0);
          if (!item) return;
          if (item.type !== "packet") {
            write(
              upstream,
              item.type === "ack" ? "+" : item.type === "nack" ? "-" : Buffer.from([3])
            );
            continue;
          }
          if (!item.valid) {
            trace?.("reject pre-attach packet: invalid checksum");
            if (!noAck) write(client, "-");
            continue;
          }
          const payload = item.payload.toString("latin1");
          const raw = framePacket(item.payload);
          if (payload === "QStartNoAckMode") {
            write(upstream, raw);
            noAck = true;
            continue;
          }
          if (payload.startsWith("vAttach")) {
            const pidHex = payload.startsWith("vAttach;") ? payload.slice("vAttach;".length) : "";
            const pid = /^[0-9a-fA-F]+$/.test(pidHex) ? parseInt(pidHex, 16) : Number.NaN;
            if (
              !Number.isSafeInteger(pid) ||
              pid <= 0 ||
              (opts.isValidPid && !opts.isValidPid(pid))
            ) {
              trace?.(`reject ${payload}: unknown platform pid`);
              replyToClient("E01");
              continue;
            }
            write(upstream, raw);
            attached = true;
            trace?.("vAttach forwarded; switching to transparent pipe");
            const remaining = parser.takeBuffered();
            if (remaining.length) write(upstream, remaining);
            return;
          }
          const synthetic = PRE_ATTACH_REPLIES[payload];
          if (synthetic !== undefined) {
            trace?.(`intercept ${payload} -> ${synthetic}`);
            replyToClient(synthetic);
          } else write(upstream, raw);
        }
      } catch (error) {
        trace?.(`pre-attach framing failed: ${error}`);
        client.destroy();
        upstream.destroy();
      }
    });
  });

  let closing: Promise<void> | undefined;
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.listenPort, host, () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => {
          // Without this, server.close() would wait indefinitely for LLDB
          // (or the upstream component connection) to disconnect voluntarily.
          if (closing) return closing;
          for (const s of sockets) s.destroy();
          return (closing = new Promise<void>((res) => server.close(() => res())));
        },
      });
    });
  });
}
