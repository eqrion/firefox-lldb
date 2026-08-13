/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  validateComponentDescriptor,
  validateModuleClaim,
  validateSourceValue,
} from "../../../src/source-debugger/protocol/validation.js";
import type { ModuleDescriptor } from "../../../src/source-debugger/protocol/types.js";
import type { LoadedSourceDebuggerComponent } from "../../../src/source-debugger/session/loader.js";
import type { SourceDebuggerSession } from "../../../src/source-debugger/session/session.js";

export interface SourceDebuggerComponentConformanceFixture {
  session: SourceDebuggerSession;
  component(id: string): LoadedSourceDebuggerComponent;
}

export interface SourceDebuggerComponentConformanceContract {
  componentId: string;
  moduleUrlIncludes: string;
  breakpointFunction: string;
  trigger(): Promise<void>;
  expectedFrame: RegExp;
  evaluation?: {
    expression: string;
    display: RegExp;
  };
  source?: {
    language?: string;
    url: RegExp;
    content: RegExp;
  };
}

/** Reusable behavioral contract for an installed SourceDebuggerComponent.
 * It deliberately enters through the production runtime and session, while
 * also checking definition- and component-level invariants at their public
 * interfaces. Engine-specific commands and transports are never used. */
export async function runSourceDebuggerComponentConformance(
  test: TestContext,
  fixture: SourceDebuggerComponentConformanceFixture,
  contract: SourceDebuggerComponentConformanceContract
): Promise<void> {
  const loaded = fixture.component(contract.componentId);
  const component = loaded.component;
  let ownedModule: ModuleDescriptor | undefined;

  await test.test("definition, descriptor, and ownership probe", async () => {
    const definitionDescriptor = validateComponentDescriptor(
      await loaded.definition.describe(),
      contract.componentId
    );
    const componentDescriptor = validateComponentDescriptor(
      await component.describe(),
      contract.componentId
    );
    assert.deepEqual(componentDescriptor, definitionDescriptor);

    ownedModule = (await fixture.session.modules()).find(({ url }) =>
      url.includes(contract.moduleUrlIncludes)
    );
    assert.ok(ownedModule, `no module URL contains ${contract.moduleUrlIncludes}`);
    assert.equal(ownedModule.owner, contract.componentId);
    const { owner: _owner, ...unowned } = ownedModule;
    const definitionClaim = validateModuleClaim(
      contract.componentId,
      await loaded.definition.probeModule(unowned)
    );
    const claim = validateModuleClaim(contract.componentId, await loaded.probeModule(unowned));
    assert.deepEqual(claim, definitionClaim);
    assert.equal(claim.supported, true, claim.reason);
    assert.ok(claim.confidence > 0);

    await assert.rejects(
      component.addModules(
        [
          {
            id: "source-debugger-conformance-foreign-module",
            url: "https://example.invalid/foreign.wasm",
            owner: "another-component",
          },
        ],
        fixture.session.currentStopId()
      ),
      /cannot own/
    );
  });

  await test.test("source descriptors and lazy content", async () => {
    assert.ok(ownedModule);
    const sources = await component.sources(ownedModule.id);
    for (const source of sources) {
      assert.ok(source.id);
      assert.ok(source.url);
      if (source.moduleId !== undefined) assert.equal(source.moduleId, ownedModule.id);
    }

    if (!contract.source) return;
    const source = sources.find(
      (candidate) => !contract.source?.language || candidate.language === contract.source.language
    );
    assert.ok(source, "component did not expose the required source descriptor");
    assert.match(source.url, contract.source.url);
    const content = await component.sourceContent(source.id);
    assert.ok(content, "component advertised a source but returned no content");
    assert.match(content, contract.source.content);
  });

  await test.test("breakpoint, run, stop, and inspection lifecycle", async () => {
    const breakpoint = await fixture.session.setBreakpoint({
      componentId: contract.componentId,
      target: { kind: "function", name: contract.breakpointFunction },
    });
    assert.equal(breakpoint.componentId, contract.componentId);
    assert.equal(breakpoint.verified, true, breakpoint.message);
    assert.ok((await fixture.session.breakpoints()).some(({ id }) => id === breakpoint.id));

    await contract.trigger();
    const stop = await fixture.session.continue(contract.componentId);
    assert.equal(stop.reason.kind, "breakpoint");
    const stopId = fixture.session.currentStopId();
    const state = await component.state(stopId);
    assert.equal(state.stopId, stopId);
    assert.notEqual(state.reason.kind, "running");

    const threads = await component.threads(stopId);
    assert.ok(threads.length > 0, "component returned no threads at a stop");
    assert.ok(threads.every(({ id }) => id.length > 0));

    const frames = await fixture.session.frames();
    const frame = frames.find(
      (candidate) =>
        candidate.componentId === contract.componentId &&
        contract.expectedFrame.test(candidate.functionName)
    );
    assert.ok(frame, `component did not project ${String(contract.expectedFrame)}`);
    const scopes = await fixture.session.scopes(frame.id);
    assert.ok(scopes.length > 0, "component returned no scopes for its frame");
    for (const property of scopes.flatMap(({ values }) => values)) {
      validateSourceValue(contract.componentId, property.value);
    }

    const descriptor = await component.describe();
    if (contract.evaluation) {
      assert.equal(descriptor.capabilities.evaluate, true);
      const value = await fixture.session.evaluate(frame.id, contract.evaluation.expression);
      assert.ok(value, `evaluation returned no value for ${contract.evaluation.expression}`);
      assert.match(value.display, contract.evaluation.display);
      validateSourceValue(contract.componentId, value);
    }

    if (!descriptor.capabilities.conditionalBreakpoints) {
      await assert.rejects(
        fixture.session.setBreakpoint({
          componentId: contract.componentId,
          target: { kind: "function", name: contract.breakpointFunction },
          condition: "false",
        }),
        /does not support (?:set )?conditional breakpoint/
      );
    }

    if (descriptor.capabilities.stepInto) {
      const stepped = await fixture.session.stepInto(frame.id);
      assert.equal(stepped.reason.kind, "step");
      await assert.rejects(fixture.session.scopes(frame.id), /stale or unknown frame/);
    }

    await fixture.session.removeBreakpoint(breakpoint.id);
    assert.equal(
      (await fixture.session.breakpoints()).some(({ id }) => id === breakpoint.id),
      false
    );
  });
}
