//! Wraps `source-map-dwarf` as a wasm component exporting the
//! `source-map-converter` interface. Pure compute: the host fetches the wasm
//! and (for non-`data:` source maps) the source map, and materializes the
//! returned source files itself, so this component never touches the filesystem.

wit_bindgen::generate!({
    world: "converter",
    path: "wit",
});

use exports::firefox_lldb::source_map::source_map_converter::{
    ConvertResult, FunctionValues, Guest, InspectResult, ModuleValues, SourceFile, ValueType,
};
use source_map_dwarf::{Options, SourceMapInput, convert_with_sources, inspect};

struct Component;
export!(Component);

impl Guest for Component {
    fn values(wasm: Vec<u8>) -> Result<ModuleValues, String> {
        let info = source_map_dwarf::module_metadata(&wasm).map_err(|e| e.to_string())?;
        let count = info.funcs.iter().map(|f| f.locals.len()).sum::<usize>() + info.globals.len();
        if count > 2_000_000 {
            return Err("value metadata exceeds 2000000 entries".into());
        }
        fn value_type(ty: source_map_dwarf::WasmValType) -> ValueType {
            use source_map_dwarf::WasmValType as T;
            match ty {
                T::I32 => ValueType::I32,
                T::I64 => ValueType::I64,
                T::F32 => ValueType::F32,
                T::F64 => ValueType::F64,
                _ => ValueType::Unsupported,
            }
        }
        Ok(ModuleValues {
            functions: info
                .funcs
                .into_iter()
                .map(|f| FunctionValues {
                    start: f.range_start as u32,
                    end: f.range_end as u32,
                    locals: f
                        .locals
                        .into_iter()
                        .map(|l| value_type(l.val_type))
                        .collect(),
                })
                .collect(),
            globals: info.globals.into_iter().map(value_type).collect(),
            memories: info.memory_count,
        })
    }

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
