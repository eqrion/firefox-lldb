/** @module Interface firefox-lldb:source-map/source-map-converter@0.1.0 **/
export function values(wasm: Uint8Array): ModuleValues;
export function inspect(wasm: Uint8Array): InspectResult;
export function convert(wasm: Uint8Array, sourceMap: Uint8Array | undefined, compDir: string | undefined): ConvertResult;
/**
 * # Variants
 * 
 * ## `"i32"`
 * 
 * ## `"i64"`
 * 
 * ## `"f32"`
 * 
 * ## `"f64"`
 * 
 * ## `"unsupported"`
 */
export type ValueType = 'i32' | 'i64' | 'f32' | 'f64' | 'unsupported';
export interface FunctionValues {
  start: number,
  end: number,
  locals: Array<ValueType>,
}
export interface ModuleValues {
  functions: Array<FunctionValues>,
  globals: Array<ValueType>,
  memories: number,
}
export interface InspectResult {
  hasDwarf: boolean,
  sourceMapUrl?: string,
}
export interface SourceFile {
  path: string,
  content: Uint8Array,
}
export interface ConvertResult {
  wasm: Uint8Array,
  sources: Array<SourceFile>,
}
