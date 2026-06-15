import type { RspLogger } from "../protocol/rsp-server.js";

/** Console logger. Debug output is gated behind the `verbose` flag. */
export function consoleLogger(verbose: boolean): RspLogger {
  const stamp = (level: string, msg: string) => `[${level}] ${msg}`;
  return {
    debug: verbose ? (m) => console.error(stamp("debug", m)) : () => {},
    info: (m) => console.error(stamp("info", m)),
    warn: (m) => console.error(stamp("warn", m)),
    error: (m) => console.error(stamp("error", m)),
  };
}
