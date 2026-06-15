// M1: the LLDB platform server.
//
// Models the browser as an LLDB platform: tabs are processes, a filesystem
// backend stands in for the remote host's files, and qLaunchGDBServer spawns a
// per-tab GDB server. Implements the platform packet set documented in
// lldb/docs/resources/lldbplatformpackets.md. Wire formats were validated
// against GDBRemoteCommunicationClient.cpp.

import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { RspHandler, RspSession } from "../protocol/rsp-server.js";
import { escapeBinary, unescapeBinary } from "../protocol/packet.js";
import { asciiToHex, hexToAscii } from "../protocol/hex.js";
import type { PlatformFileSystem } from "./filesystem.js";
import type { GdbServerSpawner } from "./gdb-server-spawner.js";
import type { ProcessInfo, ProcessProvider } from "./process-provider.js";

const execFileAsync = promisify(execFile);

// Map Node error codes to the POSIX errno numbers LLDB expects.
const ERRNO: Record<string, number> = {
  EPERM: 1,
  ENOENT: 2,
  EBADF: 9,
  EACCES: 13,
  EFAULT: 14,
  EBUSY: 16,
  EEXIST: 17,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  EMFILE: 24,
  EROFS: 30,
};

function errnoOf(err: unknown): number {
  const code = (err as NodeJS.ErrnoException)?.code;
  return (code && ERRNO[code]) || 1;
}

export interface PlatformServerDeps {
  fs: PlatformFileSystem;
  spawner: GdbServerSpawner;
  processes: ProcessProvider;
}

export class PlatformServer implements RspHandler {
  #fs: PlatformFileSystem;
  #spawner: GdbServerSpawner;
  #processes: ProcessProvider;

  // Per-connection state.
  #workingDir = process.cwd();
  #env = new Map<string, string>();
  #launchArgs: string[] = [];
  #processMatches: ProcessInfo[] = [];

  constructor(deps: PlatformServerDeps) {
    this.#fs = deps.fs;
    this.#spawner = deps.spawner;
    this.#processes = deps.processes;
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

    if (data.startsWith("qModuleInfo:")) return this.#moduleInfo(data);
    if (data.startsWith("qPathComplete:")) return this.#pathComplete(data);
    if (data.startsWith("qPlatform_mkdir:")) return this.#mkdir(data);
    if (data.startsWith("qPlatform_chmod:")) return this.#chmod(data);
    if (data.startsWith("qPlatform_shell:")) return this.#shell(data);

    if (data.startsWith("vFile:")) return this.#vFile(data, payload);

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
    const { pid, port } = await this.#spawner.launch(0);
    return `pid:${pid};port:${port};`;
  }

  #queryGdbServer(): string {
    return JSON.stringify(this.#spawner.list().map((s) => ({ port: s.port })));
  }

  async #moduleInfo(data: string): Promise<string> {
    const args = data.slice("qModuleInfo:".length);
    const semi = args.indexOf(";");
    const path = hexToAscii(args.slice(0, semi));
    const triple = args.slice(semi + 1);
    const info = await this.#fs.moduleInfo(path, triple);
    if (!info) return "E01";
    const parts: string[] = [];
    if (info.uuid) parts.push(`uuid:${info.uuid}`);
    parts.push(`triple:${asciiToHex(info.triple ?? triple)}`);
    parts.push(`file_offset:${info.fileOffset.toString(16)}`);
    parts.push(`file_size:${info.fileSize.toString(16)}`);
    return parts.join(";") + ";";
  }

  async #pathComplete(data: string): Promise<string> {
    const [flagStr, partialHex] = data.slice("qPathComplete:".length).split(",");
    const dirsOnly = parseInt(flagStr, 16) === 1;
    const matches = await this.#fs.pathComplete(hexToAscii(partialHex ?? ""), dirsOnly);
    return "M" + matches.map(asciiToHex).join(",");
  }

  async #mkdir(data: string): Promise<string> {
    const [modeHex, pathHex] = data.slice("qPlatform_mkdir:".length).split(",");
    try {
      await this.#fs.mkdir(hexToAscii(pathHex), parseInt(modeHex, 16));
      return "F0";
    } catch (err) {
      return `F${errnoOf(err).toString(16)}`;
    }
  }

  async #chmod(data: string): Promise<string> {
    const [modeHex, pathHex] = data.slice("qPlatform_chmod:".length).split(",");
    try {
      await this.#fs.chmod(hexToAscii(pathHex), parseInt(modeHex, 16));
      return "F0";
    } catch (err) {
      return `F${errnoOf(err).toString(16)}`;
    }
  }

  async #shell(data: string): Promise<string | Uint8Array> {
    const [cmdHex, , cwdHex] = data.slice("qPlatform_shell:".length).split(",");
    const command = hexToAscii(cmdHex);
    const cwd = cwdHex ? hexToAscii(cwdHex) : this.#workingDir;
    try {
      const { stdout } = await execFileAsync("/bin/sh", ["-c", command], {
        cwd,
        encoding: "buffer",
        timeout: 30_000,
      });
      return this.#shellReply(0, 0, stdout);
    } catch (err) {
      const e = err as { code?: number; stdout?: Buffer };
      const exit = typeof e.code === "number" ? e.code : 255;
      return this.#shellReply(exit, 0, e.stdout ?? Buffer.alloc(0));
    }
  }

  #shellReply(exit: number, signal: number, output: Uint8Array): Uint8Array {
    const header = `F,${(exit >>> 0).toString(16)},${signal.toString(16)},`;
    return concatBytes(new TextEncoder().encode(header), escapeBinary(output));
  }

  async #vFile(data: string, payload: Buffer): Promise<string | Uint8Array> {
    if (data.startsWith("vFile:open:")) {
      const [pathHex, flagsHex, modeHex] = data.slice("vFile:open:".length).split(",");
      try {
        const fd = await this.#fs.open(
          hexToAscii(pathHex),
          parseInt(flagsHex, 16),
          parseInt(modeHex, 16)
        );
        return `F${fd.toString(16)}`;
      } catch (err) {
        return `F-1,${errnoOf(err).toString(16)}`;
      }
    }
    if (data.startsWith("vFile:close:")) {
      try {
        await this.#fs.close(parseInt(data.slice("vFile:close:".length), 16));
        return "F0";
      } catch (err) {
        return `F-1,${errnoOf(err).toString(16)}`;
      }
    }
    if (data.startsWith("vFile:pread:")) {
      const [fdHex, countHex, offsetHex] = data.slice("vFile:pread:".length).split(",");
      try {
        const bytes = await this.#fs.pread(
          parseInt(fdHex, 16),
          parseInt(countHex, 16),
          parseInt(offsetHex, 16)
        );
        const header = new TextEncoder().encode(`F${bytes.length.toString(16)};`);
        return concatBytes(header, escapeBinary(bytes));
      } catch (err) {
        return `F-1,${errnoOf(err).toString(16)}`;
      }
    }
    if (data.startsWith("vFile:pwrite:")) {
      // The third field is raw (escaped) binary, so slice it from the buffer.
      const rest = payload.subarray("vFile:pwrite:".length);
      const c1 = rest.indexOf(0x2c);
      const c2 = rest.indexOf(0x2c, c1 + 1);
      const fd = parseInt(rest.subarray(0, c1).toString("latin1"), 16);
      const offset = parseInt(rest.subarray(c1 + 1, c2).toString("latin1"), 16);
      const bytes = unescapeBinary(rest.subarray(c2 + 1));
      try {
        const written = await this.#fs.pwrite(fd, offset, bytes);
        return `F${written.toString(16)}`;
      } catch (err) {
        return `F-1,${errnoOf(err).toString(16)}`;
      }
    }
    if (data.startsWith("vFile:size:")) {
      try {
        const size = await this.#fs.size(hexToAscii(data.slice("vFile:size:".length)));
        return `F${size.toString(16)}`;
      } catch (err) {
        return `F-1,${errnoOf(err).toString(16)}`;
      }
    }
    if (data.startsWith("vFile:mode:")) {
      try {
        const mode = await this.#fs.mode(hexToAscii(data.slice("vFile:mode:".length)));
        return `F${mode.toString(16)}`;
      } catch (err) {
        return `F-1,${errnoOf(err).toString(16)}`;
      }
    }
    if (data.startsWith("vFile:exists:")) {
      const exists = await this.#fs.exists(hexToAscii(data.slice("vFile:exists:".length)));
      return `F,${exists ? 1 : 0}`;
    }
    if (data.startsWith("vFile:unlink:")) {
      try {
        await this.#fs.unlink(hexToAscii(data.slice("vFile:unlink:".length)));
        return "F0";
      } catch (err) {
        return `F-1,${errnoOf(err).toString(16)}`;
      }
    }
    if (data.startsWith("vFile:symlink:")) {
      // Wire order is dst,src (LLDB mirrors the reversed unix symlink args).
      const [dstHex, srcHex] = data.slice("vFile:symlink:".length).split(",");
      try {
        await this.#fs.symlink(hexToAscii(srcHex), hexToAscii(dstHex));
        return "F0";
      } catch (err) {
        return `F-1,${errnoOf(err).toString(16)}`;
      }
    }
    return "";
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

function hostTriple(arch: string, platform: string): {
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

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
