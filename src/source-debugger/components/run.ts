/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceDebuggerRun } from "../protocol/component.js";
import type {
  ComponentRunRequest,
  ComponentRunTermination,
  ComponentStop,
  PhysicalResumeRequest,
} from "../protocol/types.js";

export interface SequencedSourceDebuggerRunCallbacks {
  waitForStop(): Promise<ComponentStop>;
  waitForResume(afterSequence: number): Promise<number | undefined>;
  grantResume(sequence: number): void | Promise<void>;
  rearmObserver(): void | Promise<void>;
  terminate(reason: ComponentRunTermination): void | Promise<void>;
  dispose(): void | Promise<void>;
}

/** Shared implementation for engines whose low-level target adapter numbers
 * proposed physical resumes. Sequence numbers remain private to the component;
 * the portable protocol exposes only run-scoped opaque tokens. */
export class SequencedSourceDebuggerRun implements SourceDebuggerRun {
  readonly id: string;
  readonly role: ComponentRunRequest["role"];
  readonly #callbacks: SequencedSourceDebuggerRunCallbacks;
  #afterSequence = 0;
  #pendingResume: { token: string; sequence: number } | undefined;
  #disposed = false;

  constructor(request: ComponentRunRequest, callbacks: SequencedSourceDebuggerRunCallbacks) {
    this.id = request.runId;
    this.role = request.role;
    this.#callbacks = callbacks;
  }

  waitForStop(): Promise<ComponentStop> {
    this.#requireOpen();
    return this.#callbacks.waitForStop();
  }

  async waitForResume(): Promise<PhysicalResumeRequest | undefined> {
    this.#requireOpen();
    const sequence = await this.#callbacks.waitForResume(this.#afterSequence);
    if (sequence === undefined) return undefined;
    if (!Number.isInteger(sequence) || sequence <= this.#afterSequence) {
      throw new Error(`run ${this.id} returned invalid physical resume sequence ${sequence}`);
    }
    this.#afterSequence = sequence;
    const pending = { token: `${this.id}:resume-${sequence}`, sequence };
    this.#pendingResume = pending;
    return { token: pending.token };
  }

  async grantResume(request: PhysicalResumeRequest): Promise<void> {
    this.#requireOpen();
    if (this.role !== "driver") throw new Error(`observer run ${this.id} cannot resume the target`);
    const pending = this.#pendingResume;
    if (!pending || pending.token !== request.token) {
      throw new Error(`run ${this.id} received an unknown or stale physical resume token`);
    }
    this.#pendingResume = undefined;
    await this.#callbacks.grantResume(pending.sequence);
  }

  async rearmObserver(): Promise<void> {
    this.#requireOpen();
    if (this.role !== "observer") throw new Error(`driver run ${this.id} cannot be rearmed`);
    this.#afterSequence = 0;
    this.#pendingResume = undefined;
    await this.#callbacks.rearmObserver();
  }

  async terminate(reason: ComponentRunTermination): Promise<void> {
    this.#requireOpen();
    await this.#callbacks.terminate(reason);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pendingResume = undefined;
    await this.#callbacks.dispose();
  }

  #requireOpen(): void {
    if (this.#disposed) throw new Error(`source debugger run ${this.id} is disposed`);
  }
}
