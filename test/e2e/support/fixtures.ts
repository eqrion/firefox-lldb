/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const FIXTURE_ROOT = path.join(REPO, "test", "fixtures");

export interface TestFixture {
  pageDir: string;
  fire: string;
  breakFunc: string;
  file: string;
  requireAuth?: boolean;
}

export const FIXTURES: Record<string, TestFixture> = {
  factorial: {
    pageDir: "test/fixtures/simple",
    fire: "runFactorial()",
    breakFunc: "compute_factorial",
    file: "math.cpp",
  },
  auth_factorial: {
    pageDir: "test/fixtures/simple",
    fire: "runFactorial()",
    breakFunc: "compute_factorial",
    file: "math.cpp",
    requireAuth: true,
  },
  sum_range: {
    pageDir: "test/fixtures/simple",
    fire: "runSum()",
    breakFunc: "sum_range",
    file: "math.cpp",
  },
  self_redirect: {
    pageDir: "test/fixtures/self_redirect",
    fire: "runFactorial()",
    breakFunc: "compute_factorial",
    file: "math.cpp",
  },
  navigation: {
    pageDir: "test/fixtures/navigation",
    fire: "runFactorial()",
    breakFunc: "compute_factorial",
    file: "math.cpp",
  },
  oop: {
    pageDir: "test/fixtures/oop",
    fire: "run()",
    breakFunc: "area",
    file: "oop.cpp",
  },
  parser: {
    pageDir: "test/fixtures/parser",
    fire: "run()",
    breakFunc: "parse_factor",
    file: "parser.cpp",
  },
  ledger: {
    pageDir: "test/fixtures/ledger",
    fire: "run()",
    breakFunc: "apply_transaction",
    file: "ledger.cpp",
  },
  types: {
    pageDir: "test/fixtures/types",
    fire: "run()",
    breakFunc: "stop_here",
    file: "types.cpp",
  },
  heap: {
    pageDir: "test/fixtures/heap",
    fire: "run()",
    breakFunc: "check_heap",
    file: "heap.cpp",
  },
  trap: {
    pageDir: "test/fixtures/trap",
    fire: "runDivZero()",
    breakFunc: "divide",
    file: "trap.cpp",
  },
  threaded: {
    pageDir: "test/fixtures/threaded",
    fire: "runMatmul()",
    breakFunc: "matmul_threaded",
    file: "matmul.cpp",
  },
  threaded_dynamic: {
    pageDir: "test/fixtures/threaded_dynamic",
    fire: "runDynamic(7, 7007)",
    breakFunc: "dynamic_checkpoint",
    file: "dynamic.cpp",
  },
  mixed_js: {
    pageDir: "test/fixtures/mixed-js",
    fire: "runApp()",
    breakFunc: "compute_factorial",
    file: "math.cpp",
  },
  eh: {
    pageDir: "test/fixtures/eh",
    fire: "runThrowCatch()",
    breakFunc: "handle_error",
    file: "eh.cpp",
  },
  jspi: {
    pageDir: "test/fixtures/jspi",
    fire: "runAsync()",
    breakFunc: "before_suspend",
    file: "jspi.c",
  },
  large: {
    pageDir: "test/fixtures/large",
    fire: "runLarge()",
    breakFunc: "sqlite3_prepare_v2",
    file: "large.cpp",
  },
  sourcemap_factorial: {
    pageDir: "test/fixtures/sourcemap",
    fire: "runFactorial()",
    breakFunc: "compute_factorial",
    file: "math.cpp",
  },
  sourcemap_sum: {
    pageDir: "test/fixtures/sourcemap",
    fire: "runSum()",
    breakFunc: "sum_range",
    file: "math.cpp",
  },
  two_components: {
    pageDir: "test/fixtures/two-components",
    fire: "runDwarf()",
    breakFunc: "compute_factorial",
    file: "math.cpp",
  },
};

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
};

export interface StaticFixtureServer {
  server: http.Server;
  port: number;
  debuggerFetchCount(): number;
}

export function startStaticServer(
  pageDir: string,
  { requireAuth = false, crossOriginIsolation = true } = {}
): Promise<StaticFixtureServer> {
  const dir = path.join(REPO, pageDir);
  let debuggerFetchCount = 0;
  const server = http.createServer((req, res) => {
    const rel =
      decodeURIComponent((req.url ?? "/").split("?")[0]!).replace(/^\/+/, "") || "index.html";
    const requestedPath = rel.startsWith("__fixtures__/")
      ? path.resolve(FIXTURE_ROOT, rel.slice("__fixtures__/".length))
      : path.resolve(dir, rel);
    const allowedRoot = rel.startsWith("__fixtures__/") ? FIXTURE_ROOT : dir;
    if (req.headers["x-firefox-wasm-debugger"] === "module-fetch") debuggerFetchCount++;
    if (
      requireAuth &&
      path.extname(rel) === ".wasm" &&
      !req.headers.cookie?.includes("firefox_wasm_debugger_test=1")
    ) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("authentication required");
      return;
    }
    try {
      if (requestedPath !== allowedRoot && !requestedPath.startsWith(`${allowedRoot}${path.sep}`)) {
        throw new Error("fixture path escapes its root");
      }
      const body = readFileSync(requestedPath);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(rel)] ?? "application/octet-stream",
        ...(requireAuth && path.extname(rel) === ".html"
          ? { "Set-Cookie": "firefox_wasm_debugger_test=1; SameSite=Strict" }
          : {}),
        ...(crossOriginIsolation
          ? {
              "Cross-Origin-Opener-Policy": "same-origin",
              "Cross-Origin-Embedder-Policy": "require-corp",
            }
          : {}),
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("fixture server did not bind a TCP port");
      }
      resolve({
        server,
        port: address.port,
        debuggerFetchCount: () => debuggerFetchCount,
      });
    });
  });
}

export async function closeStaticServer(server: StaticFixtureServer | undefined): Promise<void> {
  if (!server) return;
  server.server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.server.close((error) => (error ? reject(error) : resolve()))
  );
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function retrySessionSetup<T>(factory: () => Promise<T>, maxAttempts = 3): Promise<T> {
  const errors: unknown[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await factory();
    } catch (error) {
      errors.push(error);
      if (attempt < maxAttempts) await sleep(250);
    }
  }
  throw new AggregateError(errors, `session setup failed after ${maxAttempts} attempts`);
}
