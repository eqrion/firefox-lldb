// M1: the LLDB platform server.
//
// Models the browser as an LLDB platform: tabs are processes and qLaunchGDBServer
// spawns a per-tab GDB server. Implements the platform packet set documented in
// lldb/docs/resources/lldbplatformpackets.md. Wire formats were validated
// against GDBRemoteCommunicationClient.cpp.

import os from "node:os";
import type { RspHandler, RspSession } from "../protocol/rsp-server.js";
import { asciiToHex, hexToAscii } from "../protocol/hex.js";
import type { GdbServerSpawner } from "./gdb-server-spawner.js";
import type { ProcessInfo, ProcessProvider } from "./process-provider.js";

export interface PlatformServerDeps {
  spawner: GdbServerSpawner;
  processes: ProcessProvider;
  defaultUrl?: string;
}

export class PlatformServer implements RspHandler {
  #spawner: GdbServerSpawner;
  #processes: ProcessProvider;
  #defaultUrl?: string;

  // Per-connection state.
  #workingDir = process.cwd();
  #env = new Map<string, string>();
  #launchArgs: string[] = [];
  #processMatches: ProcessInfo[] = [];

  constructor(deps: PlatformServerDeps) {
    this.#spawner = deps.spawner;
    this.#processes = deps.processes;
    this.#defaultUrl = deps.defaultUrl;
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

    if (data.startsWith("qLaunchGDBServer")) return this.#launchGdbServer();
    if (data === "qQueryGDBServer") return this.#queryGdbServer();
    if (data.startsWith("qKillSpawnedProcess:")) {
      const pid = parseInt(data.slice("qKillSpawnedProcess:".length), 10);
      return (await this.#spawner.kill(pid)) ? "OK" : "E01";
    }
    if (data === "qLaunchSuccess") return "OK";

    // Process-launch configuration packets. We do not launch native processes
    // (the GDB server attaches to a tab), so we accept and remember settings.
    if (data.startsWith("A")) return this.#setLaunchArgs(data);
    if (data.startsWith("QEnvironmentHexEncoded:")) {
      this.#setEnv(hexToAscii(data.slice("QEnvironmentHexEncoded:".length)));
      return "OK";
    }
    if (data.startsWith("QEnvironment:")) {
      this.#setEnv(data.slice("QEnvironment:".length));
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
    const match = (await this.#processes.list()).find((p) => p.pid === pid);
    return match ? this.#encodeProcess(match) : "E01";
  }

  async #firstProcessInfo(data: string): Promise<string> {
    const criteria = parseKeyVals(data.includes(":") ? data.slice(data.indexOf(":") + 1) : "");
    let list = await this.#processes.list();
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

  async #launchGdbServer(): Promise<string> {
    const url = this.#resolveLaunchUrl();
    const { pid, port } = await this.#spawner.launch(0, url);
    return `pid:${pid};port:${port};`;
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

  #setEnv(pair: string): void {
    const eq = pair.indexOf("=");
    if (eq !== -1) this.#env.set(pair.slice(0, eq), pair.slice(eq + 1));
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
