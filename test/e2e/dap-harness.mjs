/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FIXTURES, retrySessionSetup, sleep, startStaticServer } from "./harness.mjs";
import { freePort } from "../../src/platform/gdb-server-spawner.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

class DAPClient {
  #child;
  #buffer = Buffer.alloc(0);
  #seq = 1;
  #pending = new Map();
  #events = [];
  #eventWaiters = [];
  #stderr = "";
  #exit;

  constructor(child) {
    this.#child = child;
    child.stdout.on("data", (data) => this.#receive(data));
    child.stderr.on("data", (data) => {
      this.#stderr += data.toString();
      if (this.#stderr.length > 16_000) this.#stderr = this.#stderr.slice(-16_000);
      if (process.env.E2E_VERBOSE) process.stderr.write(data);
    });
    this.#exit = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal }))
    );
    child.once("exit", (code, signal) => {
      const error = new Error(
        `firefox-lldb-dap exited before completing a request (${String(code ?? signal)})${
          this.#stderr ? `\nstderr:\n${this.#stderr}` : ""
        }`
      );
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      for (const waiter of this.#eventWaiters) waiter.reject(error);
      this.#eventWaiters = [];
    });
  }

  stderr() {
    return this.#stderr;
  }

  async request(command, args = {}, timeoutMs = 45_000) {
    const seq = this.#seq++;
    const body = Buffer.from(JSON.stringify({ seq, type: "request", command, arguments: args }));
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(seq);
        reject(
          new Error(
            `timed out waiting for DAP ${command} response${
              this.#stderr ? `\nstderr:\n${this.#stderr}` : ""
            }`
          )
        );
      }, timeoutMs);
      this.#pending.set(seq, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    await new Promise((resolve, reject) => {
      this.#child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
    });
    return response;
  }

  waitForEvent(event, predicate = () => true, timeoutMs = 45_000) {
    const queued = this.#events.findIndex(
      (message) => message.event === event && predicate(message)
    );
    if (queued >= 0) return Promise.resolve(this.#events.splice(queued, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { event, predicate, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        this.#eventWaiters = this.#eventWaiters.filter((candidate) => candidate !== waiter);
        reject(
          new Error(
            `timed out waiting for DAP ${event} event${
              this.#stderr ? `\nstderr:\n${this.#stderr}` : ""
            }`
          )
        );
      }, timeoutMs);
      this.#eventWaiters.push(waiter);
    });
  }

  end() {
    this.#child.stdin.end();
  }

  exit() {
    return this.#exit;
  }

  terminate() {
    this.#child.kill("SIGTERM");
  }

  #receive(data) {
    this.#buffer = Buffer.concat([this.#buffer, data]);
    try {
      for (;;) {
        const headerEnd = this.#buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
        const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
        if (!match) throw new Error(`DAP output has no Content-Length: ${JSON.stringify(header)}`);
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (this.#buffer.length < bodyStart + length) return;
        const message = JSON.parse(
          this.#buffer.subarray(bodyStart, bodyStart + length).toString("utf8")
        );
        this.#buffer = this.#buffer.subarray(bodyStart + length);
        this.#dispatch(message);
      }
    } catch (error) {
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      throw error;
    }
  }

  #dispatch(message) {
    if (process.env.E2E_VERBOSE) process.stderr.write(`[dap] ${JSON.stringify(message)}\n`);
    if (message.type === "response") {
      const pending = this.#pending.get(message.request_seq);
      if (pending) {
        this.#pending.delete(message.request_seq);
        pending.resolve(message);
      }
      return;
    }
    if (message.type !== "event") return;
    const waiter = this.#eventWaiters.find(
      (candidate) => candidate.event === message.event && candidate.predicate(message)
    );
    if (waiter) {
      clearTimeout(waiter.timer);
      this.#eventWaiters = this.#eventWaiters.filter((candidate) => candidate !== waiter);
      waiter.resolve(message);
    } else {
      this.#events.push(message);
    }
  }
}

export class DAPFixtureSession {
  #client;
  #staticServer;
  #disconnected = false;
  fixture;
  url;
  initializeResponse;
  configurationDoneResponse;
  attachResponse;
  stoppedEvent;

  constructor(client, staticServer, fixture, url) {
    this.#client = client;
    this.#staticServer = staticServer;
    this.fixture = fixture;
    this.url = url;
  }

  static async attach(fixtureName, options = {}) {
    return retrySessionSetup(
      () => DAPFixtureSession.#attachOnce(fixtureName, options),
      options.setupAttempts ?? 3
    );
  }

  static async #attachOnce(fixtureName, options) {
    const fixture = FIXTURES[fixtureName];
    if (!fixture) throw new Error(`unknown fixture: ${fixtureName}`);
    const staticServer = await startStaticServer(fixture.pageDir);
    const url = `http://127.0.0.1:${staticServer.port}/index.html`;
    const rdpPort = await freePort();
    const fire = options.fire === undefined ? fixture.fire : options.fire;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli/firefox-lldb-dap.ts",
        "--launch",
        "--headless",
        ...(process.env.E2E_VERBOSE ? ["--verbose"] : []),
        "--port",
        "0",
        "--rdp-port",
        String(rdpPort),
        "--url",
        url,
        ...(fire ? ["--fire", fire] : []),
      ],
      {
        cwd: REPO,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, FIREFOX_LLDB_EXIT_WHEN_ORPHANED: "1" },
      }
    );
    const client = new DAPClient(child);
    const session = new DAPFixtureSession(client, staticServer, fixture, url);
    let attachResponse;
    try {
      const initialize = await client.request("initialize", {
        adapterID: "firefox-lldb-e2e",
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
      });
      if (!initialize.success) throw new Error(`initialize failed: ${JSON.stringify(initialize)}`);
      session.initializeResponse = initialize;

      attachResponse = client.request("attach", {
        attachCommands: options.attachCommands ?? ["process attach --plugin wasm --pid 1"],
        timeout: 30,
      });
      await client.waitForEvent("initialized");

      if (options.configure === undefined) {
        const breakpoints = await session.setFunctionBreakpoints([fixture.breakFunc]);
        if (!breakpoints.body?.breakpoints?.[0]?.verified)
          throw new Error(`function breakpoint was not verified: ${JSON.stringify(breakpoints)}`);
      } else if (options.configure) {
        await options.configure(session, fixture);
      }

      const configured = await client.request("configurationDone");
      session.configurationDoneResponse = configured;
      if (!configured.success && !options.expectAttachFailure)
        throw new Error(`configurationDone failed: ${JSON.stringify(configured)}`);
      const attach = await attachResponse;
      session.attachResponse = attach;
      if (!attach.success) {
        if (options.expectAttachFailure) return session;
        throw new Error(`attach failed: ${JSON.stringify(attach)}`);
      }
      if (options.waitForStop !== false) {
        session.stoppedEvent = await client.waitForEvent("stopped");
      }
      return session;
    } catch (error) {
      // Configuration can fail while the attach request is still pending. Its
      // rejection during shutdown must be observed or node:test fails the file
      // as an unhandled rejection while retrySessionSetup is starting another
      // attempt.
      const pendingAttach = attachResponse?.catch(() => undefined);
      await session.shutdown();
      await pendingAttach;
      throw error;
    }
  }

  request(command, args, timeoutMs) {
    return this.#client.request(command, args, timeoutMs);
  }

  async requestOk(command, args, timeoutMs) {
    const response = await this.request(command, args, timeoutMs);
    if (!response.success) throw new Error(`${command} failed: ${JSON.stringify(response)}`);
    return response;
  }

  setFunctionBreakpoints(names) {
    return this.requestOk("setFunctionBreakpoints", {
      breakpoints: names.map((name) => ({ name })),
    });
  }

  setSourceBreakpoints(file, lines) {
    return this.requestOk("setBreakpoints", {
      source: { name: file, path: file },
      breakpoints: lines.map((line) => ({ line })),
    });
  }

  waitForEvent(event, predicate, timeoutMs) {
    return this.#client.waitForEvent(event, predicate, timeoutMs);
  }

  async continueAndWait(threadId) {
    const stopped = this.waitForEvent("stopped");
    await this.requestOk("continue", { threadId });
    return stopped;
  }

  async stepAndWait(command, threadId, args = {}) {
    const stopped = this.waitForEvent("stopped", (event) => event.body?.reason === "step");
    await this.requestOk(command, { ...args, threadId });
    return stopped;
  }

  async shutdown() {
    if (!this.#disconnected) {
      this.#disconnected = true;
      await this.#client
        .request("disconnect", { terminateDebuggee: false }, 10_000)
        .catch(() => {});
    }
    this.#client.end();
    const exited = await Promise.race([this.#client.exit(), sleep(10_000).then(() => null)]);
    if (!exited) {
      this.#client.terminate();
      await Promise.race([this.#client.exit(), sleep(5_000)]);
    }
    this.#staticServer.server.closeAllConnections();
    await new Promise((resolve) => this.#staticServer.server.close(resolve));
  }

  async disconnect({ allowFailure = false } = {}) {
    if (this.#disconnected) return;
    this.#disconnected = true;
    const response = await this.request("disconnect", { terminateDebuggee: false });
    if (!response.success && !allowFailure) {
      throw new Error(`disconnect failed: ${JSON.stringify(response)}`);
    }
    return response;
  }
}
