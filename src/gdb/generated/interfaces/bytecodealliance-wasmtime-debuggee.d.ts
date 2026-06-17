/** @module Interface bytecodealliance:wasmtime/debuggee@44.0.0 **/
/**
 * # Variants
 * 
 * ## `"invalid-entity"`
 * 
 * ## `"invalid-pc"`
 * 
 * ## `"invalid-frame"`
 * 
 * ## `"unsupported-type"`
 * 
 * ## `"mismatched-type"`
 * 
 * ## `"non-wasm-frame"`
 * 
 * ## `"alloc-failure"`
 * 
 * ## `"breakpoint-update"`
 * 
 * ## `"read-only"`
 * 
 * ## `"out-of-bounds"`
 * 
 * ## `"memory-grow-failure"`
 * 
 * ## `"execution-trap"`
 */
export type Error = 'invalid-entity' | 'invalid-pc' | 'invalid-frame' | 'unsupported-type' | 'mismatched-type' | 'non-wasm-frame' | 'alloc-failure' | 'breakpoint-update' | 'read-only' | 'out-of-bounds' | 'memory-grow-failure' | 'execution-trap';
export type Event = EventComplete | EventTrap | EventBreakpoint | EventInterrupted | EventException | EventInjectedCallReturn;
export interface EventComplete {
  tag: 'complete',
}
export interface EventTrap {
  tag: 'trap',
}
export interface EventBreakpoint {
  tag: 'breakpoint',
}
export interface EventInterrupted {
  tag: 'interrupted',
}
export interface EventException {
  tag: 'exception',
  val: WasmException,
}
export interface EventInjectedCallReturn {
  tag: 'injected-call-return',
  val: Array<WasmValue>,
}
export interface InjectCall {
  callee: WasmFunc,
  arguments: Array<WasmValue>,
}
export type ResumptionValue = ResumptionValueNormal | ResumptionValueInjectCall | ResumptionValueThrowException | ResumptionValueEarlyReturn;
export interface ResumptionValueNormal {
  tag: 'normal',
}
export interface ResumptionValueInjectCall {
  tag: 'inject-call',
  val: InjectCall,
}
export interface ResumptionValueThrowException {
  tag: 'throw-exception',
  val: WasmException,
}
export interface ResumptionValueEarlyReturn {
  tag: 'early-return',
  val: Array<WasmValue>,
}
export type WasmType = WasmTypeWasmI32 | WasmTypeWasmI64 | WasmTypeWasmF32 | WasmTypeWasmF64 | WasmTypeWasmV128 | WasmTypeWasmFuncref | WasmTypeWasmExnref;
export interface WasmTypeWasmI32 {
  tag: 'wasm-i32',
}
export interface WasmTypeWasmI64 {
  tag: 'wasm-i64',
}
export interface WasmTypeWasmF32 {
  tag: 'wasm-f32',
}
export interface WasmTypeWasmF64 {
  tag: 'wasm-f64',
}
export interface WasmTypeWasmV128 {
  tag: 'wasm-v128',
}
export interface WasmTypeWasmFuncref {
  tag: 'wasm-funcref',
}
export interface WasmTypeWasmExnref {
  tag: 'wasm-exnref',
}

export class Debuggee {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  allModules(): Array<Module>;
  allInstances(): Array<Instance>;
  listThreads(): Uint32Array;
  stoppedThread(): number;
  singleStep(tid: number, resumption: ResumptionValue): EventFuture;
  'continue'(resumption: ResumptionValue): EventFuture;
  exitFrames(tid: number): Array<Frame>;
}

export class EventFuture {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  static finish(self: EventFuture, debuggee: Debuggee): Event;
}

export class Frame {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  getInstance(d: Debuggee): Instance;
  getPc(d: Debuggee): number;
  getLocals(d: Debuggee): Array<WasmValue>;
  getStack(d: Debuggee): Array<WasmValue>;
  parentFrame(d: Debuggee): Frame | undefined;
}

export class Global {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  get(d: Debuggee): WasmValue;
}

export class Instance {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  getModule(d: Debuggee): Module;
  getMemory(d: Debuggee, memoryIndex: number): Memory;
  getGlobal(d: Debuggee, globalIndex: number): Global;
}

export class Memory {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  sizeBytes(d: Debuggee): bigint;
  getBytes(d: Debuggee, addr: bigint, len: bigint): Uint8Array;
  clone(): Memory;
  uniqueId(): bigint;
}

export class Module {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  bytecode(): Uint8Array | undefined;
  addBreakpoint(d: Debuggee, pc: number): void;
  removeBreakpoint(d: Debuggee, pc: number): void;
  clone(): Module;
  uniqueId(): bigint;
  name(): string;
}

export class WasmException {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
}

export class WasmFunc {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
}

export class WasmValue {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  getType(): WasmType;
  unwrapI32(): number;
  unwrapI64(): bigint;
  unwrapF32(): number;
  unwrapF64(): number;
  unwrapV128(): Uint8Array;
  clone(): WasmValue;
}
