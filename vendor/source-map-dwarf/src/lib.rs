mod addr;
mod dwarf;
mod emit;
mod resolve;
mod sources;
mod wasm;

use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("wasm parse error: {0}")]
    WasmParse(#[from] wasmparser::BinaryReaderError),
    #[error("DWARF write error: {0}")]
    DwarfWrite(#[from] gimli::write::Error),
    #[error("source map error: {0}")]
    SourceMap(#[from] sourcemap::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("no source map found")]
    NoSourceMap,
    #[error("no code section in module")]
    NoCodeSection,
    #[error("source map is not a flat source map (index maps not supported)")]
    SourceMapFormat,
    #[error("invalid base64 in data: URL")]
    Base64,
}

pub type Result<T> = std::result::Result<T, Error>;

pub enum SourceMapInput {
    /// Resolve automatically: data: URL in sourceMappingURL > path relative to wasm file.
    Auto,
    Path(PathBuf),
    Bytes(Vec<u8>),
}

pub struct Options {
    pub source_map: SourceMapInput,
    /// Path to the input wasm file; used to resolve a relative sourceMappingURL.
    pub wasm_path: Option<PathBuf>,
    pub comp_dir: Option<String>,
    /// When set, any sourcesContent in the source map is written out here.
    pub materialize_sources: Option<PathBuf>,
    pub keep_source_mapping_url: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            source_map: SourceMapInput::Auto,
            wasm_path: None,
            comp_dir: None,
            materialize_sources: None,
            keep_source_mapping_url: false,
        }
    }
}

/// A source file carried inline in a source map's `sourcesContent`.
pub struct SourceFile {
    pub path: String,
    pub content: Vec<u8>,
}

/// What a wasm module offers in the way of debug info, without converting it.
pub struct Inspect {
    /// The module already carries `.debug_*` sections.
    pub has_dwarf: bool,
    /// The contents of a `sourceMappingURL` custom section, if present.
    pub source_map_url: Option<String>,
}

/// Inspect a wasm module to decide whether (and how) to convert it.
pub fn inspect(wasm: &[u8]) -> Result<Inspect> {
    let module = wasm::parse(wasm)?;
    Ok(Inspect {
        has_dwarf: !module.existing_debug_ranges.is_empty(),
        source_map_url: module.source_mapping_url,
    })
}

/// Convert `wasm` (a WebAssembly module binary with a source map) into a new
/// binary with embedded DWARF debug info.
pub fn convert(wasm: &[u8], opts: &Options) -> Result<Vec<u8>> {
    let module = wasm::parse(wasm)?;
    let source_map = resolve::resolve(wasm, &module, opts)?;

    if let (Some(dir), Some(sm)) = (&opts.materialize_sources, &source_map) {
        sources::materialize(sm, dir)?;
    }

    let source_map = source_map.ok_or(Error::NoSourceMap)?;
    let debug_sections = dwarf::build(&module, &source_map, opts)?;
    emit::append(wasm, &module, debug_sections, opts)
}

/// Like [`convert`], but also returns the source files carried inline in the
/// source map's `sourcesContent` (instead of writing them to disk). Lets a
/// caller without filesystem access (e.g. a wasm component) materialize the
/// sources itself for source listing.
pub fn convert_with_sources(wasm: &[u8], opts: &Options) -> Result<(Vec<u8>, Vec<SourceFile>)> {
    let module = wasm::parse(wasm)?;
    let source_map = resolve::resolve(wasm, &module, opts)?.ok_or(Error::NoSourceMap)?;
    let sources = sources::collect(&source_map);
    let debug_sections = dwarf::build(&module, &source_map, opts)?;
    let out = emit::append(wasm, &module, debug_sections, opts)?;
    Ok((out, sources))
}
