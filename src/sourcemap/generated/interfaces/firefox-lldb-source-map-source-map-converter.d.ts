/** @module Interface firefox-lldb:source-map/source-map-converter@0.1.0 **/
export function inspect(wasm: Uint8Array): InspectResult;
export function convert(wasm: Uint8Array, sourceMap: Uint8Array | undefined, compDir: string | undefined): ConvertResult;
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
