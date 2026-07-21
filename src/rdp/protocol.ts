/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Single source of truth for the Firefox RDP (Remote Debugging Protocol)
// surface this tool uses: actors, request/event `type` strings, and the
// argument/response shapes that go with them. See docs/RDP-USAGE.md for the
// DevTools-facing reference generated from this file's contents.
//
// Actor graph (how we get each actor id; all but "root" are dynamic, assigned
// by Firefox at connect/watch time):
//   root                    -- the well-known actor of the initial connection
//     -> preferenceActor    -- getRoot reply; reads profile prefs
//     -> tab/target actor   -- listTabs reply; one per open tab
//         -> watcherActor          -- getWatcher reply
//             -> thread-config actor   -- getThreadConfigurationActor reply
//             -> per-thread targetActor/threadActor/consoleActor
//                    -- target-available-form (one frame target + one per
//                       emscripten pthread worker target)
//                 -> sourceActor        -- a threadActor's `sources` reply
//                    -> arrayBuffer actor -- binary content from `source`
//                 -> frame actor        -- a threadActor's `frames` reply
//                 -> longString actor   -- a grip with type "longString"
//
// There is no dedicated breakpoint-list actor: setBreakpoint/removeBreakpoint
// are sent per thread actor (the watcher does not broadcast).

export const ROOT_ACTOR = "root";

// --- request `type` strings, grouped by the actor they're sent to ---

export const REQUESTS = {
  // root actor
  getRoot: "getRoot",
  listTabs: "listTabs",
  // preferenceActor
  getCharPref: "getCharPref",
  // tab/target actor
  getWatcher: "getWatcher",
  navigateTo: "navigateTo",
  // watcherActor
  getThreadConfigurationActor: "getThreadConfigurationActor",
  watchTargets: "watchTargets",
  watchResources: "watchResources",
  // thread-config actor
  updateConfiguration: "updateConfiguration",
  // threadActor
  sources: "sources",
  frames: "frames",
  setBreakpoint: "setBreakpoint",
  removeBreakpoint: "removeBreakpoint",
  resume: "resume",
  interrupt: "interrupt",
  // sourceActor
  source: "source",
  getBreakpointPositionsCompressed: "getBreakpointPositionsCompressed",
  // longString actor
  substring: "substring",
  // arrayBuffer actor
  slice: "slice",
  release: "release",
  // frame actor
  getEnvironment: "getEnvironment",
  // consoleActor
  startListeners: "startListeners",
  evaluateJSAsync: "evaluateJSAsync",
} as const;

// --- request argument / response shapes ---

export interface GetRootResponse {
  preferenceActor?: string;
}

/** `value` is the pref name being read (the response reuses the same field for the value). */
export interface GetCharPrefArgs {
  value: string;
}

export interface GetCharPrefResponse {
  value?: string;
}

export interface RdpTabForm {
  actor: string;
  url?: string;
  title?: string;
  selected?: boolean;
}

export interface ListTabsResponse {
  tabs?: RdpTabForm[];
}

export interface GetWatcherArgs {
  isServerTargetSwitchingEnabled: boolean;
}

export interface GetWatcherResponse {
  actor?: string;
}

export interface NavigateToArgs {
  url: string;
  waitForLoad: boolean;
}

// Some Firefox versions reply with a bare actor-id string, others with
// `{ actor }` — #init()/primeTab() unwrap both forms.
export interface GetThreadConfigurationActorResponse {
  configuration?: string | { actor?: string };
}

export interface ThreadConfig {
  observeWasm: boolean;
  observeAsmJS: boolean;
  pauseOnExceptions: boolean;
  ignoreCaughtExceptions: boolean;
}

export interface UpdateConfigurationArgs {
  configuration: ThreadConfig;
}

export interface WatchTargetsArgs {
  targetType: "frame" | "worker";
}

export interface WatchResourcesArgs {
  resourceTypes: string[];
}

export interface SourceForm {
  actor: string;
  url: string;
  introductionType?: string;
}

export interface SourcesResponse {
  sources?: SourceForm[];
}

export interface FrameForm {
  actor: string;
  type: string; // "wasmcall" | "call" | "global" | ...
  where?: { actor: string; line: number; column: number };
  callee?: { name?: string; displayName?: string };
  arguments?: unknown[];
}

export interface FramesArgs {
  start: number;
  count: number;
}

export interface FramesResponse {
  frames?: FrameForm[];
}

export interface BreakpointLocation {
  sourceUrl: string;
  line: number;
  column?: number;
}

export interface SetBreakpointArgs {
  location: BreakpointLocation;
  options: Record<string, never>;
}

export interface RemoveBreakpointArgs {
  location: BreakpointLocation;
}

export interface ResumeArgs {
  resumeLimit?: { type: "step" | "next" };
}

export interface InterruptArgs {
  when: Record<string, never>;
}

/** A "longString" grip: a source too large to inline, fetched via `substring`. */
export interface LongStringGrip {
  type: "longString";
  actor: string;
  length: number;
  initial?: string;
}

/** An ArrayBuffer actor grip returned for binary wasm source content. */
export interface ArrayBufferGrip {
  typeName: "arraybuffer";
  actor: string;
  length: number;
}

export interface SourceResponse {
  source?: string | Uint8Array | ArrayBuffer | ArrayBufferView | LongStringGrip | ArrayBufferGrip;
}

export interface ArrayBufferSliceResponse {
  encoded?: string;
}

export interface SubstringArgs {
  start: number;
  end: number;
}

export interface SubstringResponse {
  substring?: string;
}

export interface GetBreakpointPositionsArgs {
  query: { start: { line: number }; end: { line: number } };
}

export interface GetBreakpointPositionsResponse {
  positions?: Record<string, number[]>;
}

export interface StartListenersArgs {
  listeners: string[]; // "ConsoleAPI" | "PageError"
}

export interface EvaluateJSAsyncArgs {
  text: string;
  frameActor?: string;
}

/** The immediate reply to evaluateJSAsync; the actual value arrives later as
 * an "evaluationResult" event carrying the same resultID. */
export interface EvaluateJSAsyncAck {
  resultID?: string;
}

// --- unsolicited notification (event) `type` strings ---

export const EVENTS = {
  targetAvailableForm: "target-available-form",
  targetDestroyedForm: "target-destroyed-form",
  resourceAvailableForm: "resource-available-form",
  resourceUpdatedForm: "resource-updated-form",
  resourceDestroyedForm: "resource-destroyed-form",
  tabListChanged: "tabListChanged",
  tabNavigated: "tabNavigated",
  tabDetached: "tabDetached",
  frameUpdate: "frameUpdate",
  paused: "paused",
  resumed: "resumed",
  newSource: "newSource",
  willNavigate: "willNavigate",
  networkEvent: "networkEvent",
  consoleAPICall: "consoleAPICall",
  pageError: "pageError",
  evaluationResult: "evaluationResult",
  // Firefox also sends {type:"interrupt"} as an ACK when a thread receives
  // interrupt while already paused or in a transition (see client.ts).
  interrupt: "interrupt",
} as const;

export interface PauseEvent {
  why?: { type?: string };
  frame?: FrameForm;
}

export interface ConsoleApiCallEvent {
  message?: { level?: string; arguments?: unknown[] };
}

export interface PageErrorEvent {
  pageError?: { errorMessage?: string; warning?: boolean };
}

// --- higher-level session-derived shapes (not wire forms, but built from them) ---

export interface TabInfo {
  actor: string;
  url: string;
  title: string;
}

// All-stop event: one thread paused and all others have been interrupted.
export interface StoppedEvent {
  tid: number;
  pausePacket: PauseEvent;
}

/** Render an RDP grip (console argument or binding value) as a display string. */
export function grip(a: unknown): string {
  if (a === null) return "null";
  if (typeof a !== "object") return String(a);
  const g = a as { type?: string; class?: string; initial?: string };
  switch (g.type) {
    case "undefined":
    case "null":
    case "Infinity":
    case "-Infinity":
    case "NaN":
      return g.type;
    case "longString":
      return g.initial ?? "[longString]";
    default:
      return g.class ?? g.type ?? "[object]";
  }
}
