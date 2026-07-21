/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The LLDB platform server.
//
// Models the browser as an LLDB platform: tabs are processes and qLaunchGDBServer
// spawns a per-tab GDB server. Implements the platform packet set documented in
// lldb/docs/resources/lldbplatformpackets.md. Wire formats were validated
// against GDBRemoteCommunicationClient.cpp.

import os from "node:os";
import type { RspHandler, RspSession } from "../protocol/rsp-server.js";
import { asciiToHex, hexToAscii } from "../protocol/hex.js";
import type { GdbServerSpawner } from "./gdb-server-spawner.js";
import type { TabInfo } from "../rdp/session.js";

interface ProcessInfo {
  pid: number;
  name: string;
  triple: string;
  parentPid: number;
  uid: number;
  gid: number;
}

export interface PlatformServerDeps {
  spawner: GdbServerSpawner;
  defaultUrl?: string;
  listTabs?: () => Promise<TabInfo[]>;
  /**
   * Optional transform applied to the GDB-server port returned by
   * qLaunchGDBServer. The embedded wasm LLDB cannot open TCP sockets, so in
   * that mode this bridges the per-tab server's TCP port to an in-process
   * channel and returns the channel ID for LLDB to connect to instead.
   */
  wrapConnectPort?: (port: number) => Promise<number>;
}

export class PlatformServer implements RspHandler {
  #spawner: GdbServerSpawner;
  #defaultUrl?: string;
  #listTabs?: () => Promise<TabInfo[]>;
  #wrapConnectPort?: (port: number) => Promise<number>;

  // Stable mapping between synthetic integer PIDs and Firefox tab actors.
  #tabPidMap = new Map<number, string>();
  #tabActorPid = new Map<string, number>();
  #nextTabPid = 1;

  // Deduplication of per-tab GDB server launches. A single promise per actor
  // is shared across concurrent qLaunchGDBServer calls for the same tab, so a
  // retry that races with an in-flight launch re-uses the same server rather
  // than opening a second RDP session. The full response (including the
  // wrapped connect port) is stored so wrapConnectPort is also called once.
  #serverByActor = new Map<string, Promise<{ pid: number; connectPort: number }>>();
  #actorByServerPid = new Map<number, string>();

  // State for the platform's single supported LLDB connection.
  #workingDir = process.cwd();
  #launchArgs: string[] = [];
  #processMatches: ProcessInfo[] = [];

  constructor(deps: PlatformServerDeps) {
    this.#spawner = deps.spawner;
    this.#defaultUrl = deps.defaultUrl;
    this.#listTabs = deps.listTabs;
    this.#wrapConnectPort = deps.wrapConnectPort;
  }

  #tabPid(actor: string): number {
    let pid = this.#tabActorPid.get(actor);
    if (pid === undefined) {
      pid = this.#nextTabPid++;
      this.#tabActorPid.set(actor, pid);
      this.#tabPidMap.set(pid, actor);
    }
    return pid;
  }

  /** Get or assign a stable integer PID for a tab actor. */
  tabPid(actor: string): number {
    return this.#tabPid(actor);
  }

  /** Whether a PID was assigned to a tab advertised by this platform. */
  hasTabPid(pid: number): boolean {
    return this.#tabPidMap.has(pid);
  }

  async #listProcesses(): Promise<ProcessInfo[]> {
    if (!this.#listTabs) return [];
    try {
      const tabs = await this.#listTabs();
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      const gid = typeof process.getgid === "function" ? process.getgid() : 0;
      return tabs.map((tab) => ({
        pid: this.#tabPid(tab.actor),
        name: tab.url || tab.actor,
        triple: "wasm32-unknown-unknown-wasm",
        parentPid: 0,
        uid,
        gid,
      }));
    } catch {
      return [];
    }
  }

  async handle(payload: Buffer, session: RspSession): Promise<Uint8Array | string | null> {
    const data = payload.toString("latin1");

    // QStartNoAckMode must ack before disabling acks (handled by the session).
    if (data === "QStartNoAckMode") {
      session.setNoAckMode(true);
      return "OK";
    }
    if (data === "qHostInfo") return this.#hostInfo();
    if (data === "qGetWorkingDir") return asciiToHex(this.#workingDir);
    if (data.startsWith("QSetWorkingDir:")) {
      this.#workingDir = hexToAscii(data.slice("QSetWorkingDir:".length));
      return "OK";
    }

    if (data === "qProcessInfo") return this.#hostInfo();
    if (data.startsWith("qProcessInfoPID:")) {
      return this.#processInfoPID(parseInt(data.slice("qProcessInfoPID:".length), 10));
    }
    if (data === "qfProcessInfo" || data.startsWith("qfProcessInfo:")) {
      return this.#firstProcessInfo(data);
    }
    if (data === "qsProcessInfo") return this.#nextProcessInfo();

    if (data.startsWith("qLaunchGDBServer")) return this.#launchGdbServer(data);
    if (data === "qQueryGDBServer") return this.#queryGdbServer();
    if (data.startsWith("qKillSpawnedProcess:")) {
      const pid = parseInt(data.slice("qKillSpawnedProcess:".length), 10);
      const actor = this.#actorByServerPid.get(pid);
      if (actor) {
        this.#serverByActor.delete(actor);
        this.#actorByServerPid.delete(pid);
      }
      return (await this.#spawner.kill(pid)) ? "OK" : "E01";
    }
    if (data === "qLaunchSuccess") return "OK";

    // Process-launch configuration packets. We do not launch native processes
    // (the GDB server attaches to a tab), so we accept and remember settings.
    if (data.startsWith("A")) return this.#setLaunchArgs(data);
    if (data.startsWith("QEnvironmentHexEncoded:")) {
      return "OK";
    }
    if (data.startsWith("QEnvironment:")) {
      return "OK";
    }
    if (
      data.startsWith("QSetDetachOnError") ||
      data.startsWith("QSetDisableASLR") ||
      data.startsWith("QSetSTDIN:") ||
      data.startsWith("QSetSTDOUT:") ||
      data.startsWith("QSetSTDERR:")
    ) {
      return "OK";
    }

    if (data.startsWith("qUserName:")) {
      try {
        return asciiToHex(os.userInfo().username);
      } catch {
        // os.userInfo() throws in some container/CI environments where the
        // uid has no passwd entry. Fall back to the process env or "user".
        return asciiToHex(process.env.USER ?? process.env.USERNAME ?? "user");
      }
    }

    // Empty response means "unsupported packet".
    return "";
  }

  #hostInfo(): string {
    const arch = os.arch() === "arm64" ? "arm64" : os.arch() === "x64" ? "x86_64" : os.arch();
    const platform = os.platform();
    const { ostype, vendor, triple } = hostTriple(arch, platform);
    const pairs = [
      `triple:${asciiToHex(triple)}`,
      `ptrsize:8`,
      `endian:${os.endianness() === "LE" ? "little" : "big"}`,
      `ostype:${ostype}`,
      `vendor:${vendor}`,
      `hostname:${asciiToHex(os.hostname())}`,
      `os_version:${os.release()}`,
    ];
    return pairs.join(";") + ";";
  }

  #encodeProcess(p: ProcessInfo): string {
    return (
      `pid:${p.pid};ppid:${p.parentPid};uid:${p.uid};gid:${p.gid};` +
      `euid:${p.uid};egid:${p.gid};name:${asciiToHex(p.name)};` +
      `triple:${asciiToHex(p.triple)};`
    );
  }

  async #processInfoPID(pid: number): Promise<string> {
    const list = await this.#listProcesses();
    const match = list.find((p) => p.pid === pid);
    if (match) return this.#encodeProcess(match);
    // Fall back to the stable map for PIDs assigned in a previous listing.
    const actor = this.#tabPidMap.get(pid);
    if (!actor) return "E01";
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const gid = typeof process.getgid === "function" ? process.getgid() : 0;
    return this.#encodeProcess({
      pid,
      name: actor,
      triple: "wasm32-unknown-unknown-wasm",
      parentPid: 0,
      uid,
      gid,
    });
  }

  async #firstProcessInfo(data: string): Promise<string> {
    const criteria = parseKeyVals(data.includes(":") ? data.slice(data.indexOf(":") + 1) : "");
    let list = await this.#listProcesses();
    const wantName = criteria.get("name");
    if (wantName !== undefined) {
      const name = hexToAscii(wantName);
      const matchType = criteria.get("name_match") ?? "equals";
      list = list.filter((p) => nameMatches(p.name, name, matchType));
    }
    this.#processMatches = list;
    return this.#nextProcessInfo();
  }

  #nextProcessInfo(): string {
    const next = this.#processMatches.shift();
    return next ? this.#encodeProcess(next) : "E04";
  }

  async #launchGdbServer(data: string): Promise<string> {
    // data may be "qLaunchGDBServer;host:..;port:..;pid:N" when triggered by
    // `process attach --pid N`. Extract the pid and resolve it to a tab actor.
    const params = parseKeyVals(data.includes(";") ? data.slice(data.indexOf(";") + 1) : "");
    const pidParam = params.get("pid");
    const tabActor = pidParam !== undefined ? this.#tabPidMap.get(Number(pidParam)) : undefined;
    const url = tabActor ? undefined : this.#resolveLaunchUrl();

    if (tabActor) {
      const existing = this.#serverByActor.get(tabActor);
      if (existing) {
        const { pid, connectPort } = await existing;
        return `pid:${pid};port:${connectPort};`;
      }
      const responseP = this.#spawner
        .launch(0, url, tabActor)
        .then(async (s) => {
          this.#actorByServerPid.set(s.pid, tabActor);
          const connectPort = this.#wrapConnectPort ? await this.#wrapConnectPort(s.port) : s.port;
          return { pid: s.pid, connectPort };
        })
        .catch((err) => {
          this.#serverByActor.delete(tabActor);
          throw err as Error;
        });
      this.#serverByActor.set(tabActor, responseP);
      const { pid, connectPort } = await responseP;
      return `pid:${pid};port:${connectPort};`;
    }

    const { pid, port } = await this.#spawner.launch(0, url, undefined);
    const connectPort = this.#wrapConnectPort ? await this.#wrapConnectPort(port) : port;
    return `pid:${pid};port:${connectPort};`;
  }

  #queryGdbServer(): string {
    return JSON.stringify(this.#spawner.list().map((s) => ({ port: s.port })));
  }

  #resolveLaunchUrl(): string | undefined {
    const arg0 = this.#launchArgs[0];
    if (arg0 && /^(https?:|file:|about:)/.test(arg0)) return arg0;
    return this.#defaultUrl;
  }

  #setLaunchArgs(data: string): string {
    // A<len>,<idx>,<hex-arg>[,<len>,<idx>,<hex-arg>]...
    const parts = data.slice(1).split(",");
    this.#launchArgs = [];
    for (let i = 0; i + 2 < parts.length; i += 3) {
      const idx = parseInt(parts[i + 1], 10);
      this.#launchArgs[idx] = hexToAscii(parts[i + 2]);
    }
    return "OK";
  }
}

function hostTriple(
  arch: string,
  platform: string
): {
  ostype: string;
  vendor: string;
  triple: string;
} {
  switch (platform) {
    case "darwin":
      return { ostype: "macosx", vendor: "apple", triple: `${arch}-apple-macosx` };
    case "linux":
      return { ostype: "linux", vendor: "unknown", triple: `${arch}-unknown-linux-gnu` };
    case "win32":
      return { ostype: "windows", vendor: "pc", triple: `${arch}-pc-windows-msvc` };
    default:
      return { ostype: platform, vendor: "unknown", triple: `${arch}-unknown-${platform}` };
  }
}

function parseKeyVals(s: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of s.split(";")) {
    if (!part) continue;
    const colon = part.indexOf(":");
    if (colon === -1) map.set(part, "");
    else map.set(part.slice(0, colon), part.slice(colon + 1));
  }
  return map;
}

function nameMatches(name: string, want: string, matchType: string): boolean {
  switch (matchType) {
    case "starts_with":
      return name.startsWith(want);
    case "ends_with":
      return name.endsWith(want);
    case "contains":
      return name.includes(want);
    case "regex":
      try {
        return new RegExp(want).test(name);
      } catch {
        return false;
      }
    case "equals":
    default:
      return name === want;
  }
}
