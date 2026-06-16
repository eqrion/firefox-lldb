// Self-contained live bridge for lldb tests: launches headless Firefox, serves
// a wasm example page, connects over RDP with wasm observation enabled, and
// serves the gdbstub component for lldb on a TCP port. Once lldb installs its
// first breakpoint, it drives the page's wasm export so execution reaches the
// breakpoint and pauses.
//
// Mirrors fake-wasm-server.ts: prints "listening on <port>" when ready.
//
//   node --import tsx live-wasm-server.ts \
//       --page-dir ../examples/oop --page index.html --fire "run()" \
//       --port 8123 --rdp-port 6080

import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { RdpWasmSession } from "../rdp/session.js";
import { RdpDebuggee } from "../gdb/rdp-debuggee.js";
import { launchFirefox } from "../rdp/firefox.js";
// @ts-expect-error - .mjs host has no type declarations
import { startGdbServer } from "../gdb/worker/host.mjs";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".map": "application/json",
};

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startStaticServer(dir: string): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
    try {
      const body = await readFile(join(dir, rel));
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      res.setHeader("Content-Type", MIME[extname(rel)] ?? "application/octet-stream");
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as { port: number }).port })
    )
  );
}

async function connectWithRetry(rdpPort: number): Promise<RdpWasmSession> {
  let lastErr: unknown;
  for (let i = 0; i < 80; i++) {
    try {
      return await RdpWasmSession.start(rdpPort);
    } catch (err) {
      lastErr = err;
      await sleep(250);
    }
  }
  throw new Error(`could not connect to Firefox RDP on ${rdpPort}: ${lastErr}`);
}

async function main(): Promise<void> {
  const pageDir = arg("--page-dir");
  const page = arg("--page", "index.html")!;
  const fire = arg("--fire", "run()")!;
  const port = Number(arg("--port", "8123"));
  const rdpPort = Number(arg("--rdp-port", "6080"));
  const firefoxBin = arg("--firefox");
  if (!pageDir) throw new Error("--page-dir <dir> required");

  const { server, port: httpPort } = await startStaticServer(pageDir);
  const pageUrl = `http://127.0.0.1:${httpPort}/${page}`;

  const firefox = await launchFirefox({ rdpPort, binary: firefoxBin });

  const session = await connectWithRetry(rdpPort);
  await session.navigate(pageUrl);
  console.error(`[rdp] on ${session.targetUrl}`);

  // Wait for the page's wasm module to compile and appear over RDP.
  let wasm = (await session.wasmSources())[0];
  for (let i = 0; i < 80 && !wasm; i++) {
    await sleep(100);
    wasm = (await session.wasmSources())[0];
  }
  if (!wasm) throw new Error("no wasm source appeared");
  console.error(`[rdp] wasm loaded: ${wasm.url}`);

  // Drive the page's export only once lldb has armed a breakpoint, so the
  // engine pauses inside wasm instead of running the call to completion.
  const fireOnce = () => {
    const wrapped = `(function poll(){try{${fire}}catch(e){setTimeout(poll,20);}})()`;
    session.evaluate(wrapped).catch(() => {});
  };

  const debuggee = new RdpDebuggee(session, { onFirstContinue: fireOnce });
  const debug = !!process.env.LIVE_DEBUG;
  if (debug) {
    session.on("paused", (p: { why?: { type?: string } }) =>
      console.error(`[bridge] RDP paused (${p?.why?.type})`));
    session.on("resumed", () => console.error("[bridge] RDP resumed"));
  }
  const show = (v: unknown) => { try { return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x))?.slice(0, 80); } catch { return String(v); } };
  const dispatch = async (req: { type: string; method: string; args: unknown[] }) => {
    if (debug) console.error(`[bridge] -> ${req.type}.${req.method}(${show(req.args)})`);
    const r = await debuggee.dispatch(req as never);
    if (debug) console.error(`[bridge] <- ${req.type}.${req.method} = ${show(r)}`);
    return r;
  };
  const { ready, stop } = startGdbServer({
    dispatch: (req: unknown) => dispatch(req as never),
    port,
    onInfo: (m: string) => console.error(`[component] ${m}`),
  });
  await ready;
  console.error(`live-wasm-server listening on ${port}`);

  const shutdown = async () => {
    try { stop(); } catch { /* ignore */ }
    session.close();
    server.close();
    await firefox.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
