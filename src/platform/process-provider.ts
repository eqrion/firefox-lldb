// Supplies the "process" list the platform reports (qfProcessInfo /
// qProcessInfoPID). In the browser model each debuggable tab is a process;
// until the RDP wiring lands the default provider just reports this bridge
// process so the conformance packets have something to return.

export interface ProcessInfo {
  pid: number;
  name: string;
  triple: string;
  parentPid: number;
  uid: number;
  gid: number;
}

export interface ProcessProvider {
  list(): Promise<ProcessInfo[]>;
}

export class DefaultProcessProvider implements ProcessProvider {
  async list(): Promise<ProcessInfo[]> {
    return [
      {
        pid: process.pid,
        name: "firefox-lldb",
        triple: "wasm32-unknown-unknown-wasm",
        parentPid: process.ppid ?? 0,
        uid: typeof process.getuid === "function" ? process.getuid() : 0,
        gid: typeof process.getgid === "function" ? process.getgid() : 0,
      },
    ];
  }
}
