//! Wraps `source-map-dwarf` as a wasm component exporting the
//! `source-map-converter` interface. Pure compute: the host fetches the wasm
//! and (for non-`data:` source maps) the source map, and materializes the
//! returned source files itself, so this component never touches the filesystem.

wit_bindgen::generate!({
    world: "converter",
    path: "wit",
});

use exports::firefox_lldb::source_map::source_map_converter::{
    ConvertResult, Guest, InspectResult, SourceFile,
};
use source_map_dwarf::{Options, SourceMapInput, convert_with_sources, inspect};

struct Component;
export!(Component);

impl Guest for Component {
    fn inspect(wasm: Vec<u8>) -> Result<InspectResult, String> {
        let i = inspect(&wasm).map_err(|e| e.to_string())?;
        Ok(InspectResult {
            has_dwarf: i.has_dwarf,
            source_map_url: i.source_map_url,
        })
    }

    fn convert(
        wasm: Vec<u8>,
        source_map: Option<Vec<u8>>,
        comp_dir: Option<String>,
    ) -> Result<ConvertResult, String> {
        let opts = Options {
            source_map: match source_map {
                Some(bytes) => SourceMapInput::Bytes(bytes),
                None => SourceMapInput::Auto,
            },
            comp_dir,
            ..Default::default()
        };
        let (wasm, sources) = convert_with_sources(&wasm, &opts).map_err(|e| e.to_string())?;
        Ok(ConvertResult {
            wasm,
            sources: sources
                .into_iter()
                .map(|s| SourceFile {
                    path: s.path,
                    content: s.content,
                })
                .collect(),
        })
    }
}
