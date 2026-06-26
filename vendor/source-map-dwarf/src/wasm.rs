use std::collections::HashMap;

use wasmparser::{
    BinaryReader, CompositeInnerType, FunctionBody, Name, NameSectionReader, Parser, Payload,
    TypeRef, ValType,
};

use crate::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WasmValType {
    I32,
    I64,
    F32,
    F64,
    V128,
    Other,
}

impl From<ValType> for WasmValType {
    fn from(v: ValType) -> Self {
        match v {
            ValType::I32 => WasmValType::I32,
            ValType::I64 => WasmValType::I64,
            ValType::F32 => WasmValType::F32,
            ValType::F64 => WasmValType::F64,
            ValType::V128 => WasmValType::V128,
            _ => WasmValType::Other,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Local {
    pub name: String,
    pub val_type: WasmValType,
    pub is_param: bool,
}

#[derive(Debug, Clone)]
pub struct Func {
    /// File byte offset range of the function body (including size LEB128 prefix).
    pub range_start: usize,
    pub range_end: usize,
    /// Global function index (imports + code-section index).
    pub func_index: u32,
    pub locals: Vec<Local>,
}

#[derive(Debug)]
pub struct ModuleInfo {
    /// File byte offset of the first byte of the code section body payload
    /// (the function-count LEB128). All DWARF addresses are relative to this.
    pub code_section_body_start: u64,
    pub funcs: Vec<Func>,
    pub func_names: HashMap<u32, String>,
    pub source_mapping_url: Option<String>,
    /// Byte ranges of existing `.debug_*` custom sections so emit can drop them.
    pub existing_debug_ranges: Vec<std::ops::Range<usize>>,
    /// Byte range of the `sourceMappingURL` custom section.
    pub source_mapping_url_range: Option<std::ops::Range<usize>>,
}

pub fn parse(wasm: &[u8]) -> Result<ModuleInfo> {
    let mut func_names: HashMap<u32, String> = HashMap::new();
    let mut local_names: HashMap<u32, HashMap<u32, String>> = HashMap::new();
    let mut source_mapping_url: Option<String> = None;
    let mut source_mapping_url_range: Option<std::ops::Range<usize>> = None;
    let mut existing_debug_ranges: Vec<std::ops::Range<usize>> = Vec::new();

    // type_params[type_index] = list of param ValTypes
    let mut type_params: Vec<Vec<WasmValType>> = Vec::new();
    let mut func_type_indices: Vec<u32> = Vec::new();
    let mut import_func_count: u32 = 0;

    let mut code_section_body_start: Option<u64> = None;
    let mut raw_bodies: Vec<(u32, std::ops::Range<usize>, Vec<(u32, ValType)>)> = Vec::new();

    for payload in Parser::new(0).parse_all(wasm) {
        let payload = payload?;
        match payload {
            Payload::TypeSection(reader) => {
                for rec_group in reader {
                    let rec_group = rec_group?;
                    for sub_type in rec_group.types() {
                        match &sub_type.composite_type.inner {
                            CompositeInnerType::Func(ft) => {
                                type_params.push(
                                    ft.params().iter().map(|&v| WasmValType::from(v)).collect(),
                                );
                            }
                            _ => {
                                type_params.push(vec![]);
                            }
                        }
                    }
                }
            }

            Payload::ImportSection(reader) => {
                for import in reader.into_imports() {
                    let import = import?;
                    if matches!(import.ty, TypeRef::Func(_) | TypeRef::FuncExact(_)) {
                        import_func_count += 1;
                    }
                }
            }

            Payload::FunctionSection(reader) => {
                for type_idx in reader {
                    func_type_indices.push(type_idx?);
                }
            }

            Payload::CodeSectionStart { range, .. } => {
                // range.start is the file offset of the function-count LEB128
                // (the first byte of the code section payload).
                code_section_body_start = Some(range.start as u64);
            }

            Payload::CodeSectionEntry(body) => {
                let func_index = import_func_count + raw_bodies.len() as u32;
                let range = body.range();
                let locals = collect_body_locals(body)?;
                raw_bodies.push((func_index, range, locals));
            }

            Payload::CustomSection(custom) => {
                let section_range = custom.range();
                let name = custom.name();

                // custom.range() covers only the payload (name + data), not the
                // section id byte (0x00) or size LEB128. Expand to get the full
                // section range so emit can correctly excise the whole section.
                let full_range = full_custom_section_range(wasm, &section_range);

                if name == "name" {
                    let reader = BinaryReader::new(custom.data(), custom.data_offset());
                    let name_reader = NameSectionReader::new(reader);
                    parse_name_section(name_reader, &mut func_names, &mut local_names)?;
                } else if name == "sourceMappingURL" {
                    let url = std::str::from_utf8(custom.data()).unwrap_or("").to_string();
                    source_mapping_url = Some(url);
                    source_mapping_url_range = Some(full_range);
                } else if name.starts_with(".debug_") {
                    existing_debug_ranges.push(full_range);
                }
            }

            _ => {}
        }
    }

    let body_start = code_section_body_start.ok_or(Error::NoCodeSection)?;

    let mut funcs = Vec::with_capacity(raw_bodies.len());
    for (func_index, range, body_locals) in raw_bodies {
        let type_idx_in_code = (func_index - import_func_count) as usize;
        let type_idx = func_type_indices
            .get(type_idx_in_code)
            .copied()
            .unwrap_or(0) as usize;
        let params = type_params.get(type_idx).cloned().unwrap_or_default();

        let mut locals: Vec<Local> = Vec::new();
        let fn_local_names = local_names.get(&func_index);

        for (i, &vt) in params.iter().enumerate() {
            let name = fn_local_names
                .and_then(|m| m.get(&(i as u32)))
                .cloned()
                .unwrap_or_else(|| format!("arg{i}"));
            locals.push(Local { name, val_type: vt, is_param: true });
        }

        let mut local_idx = params.len() as u32;
        for (count, vt) in body_locals {
            let wvt = WasmValType::from(vt);
            for _ in 0..count {
                let name = fn_local_names
                    .and_then(|m| m.get(&local_idx))
                    .cloned()
                    .unwrap_or_else(|| format!("local{local_idx}"));
                locals.push(Local { name, val_type: wvt, is_param: false });
                local_idx += 1;
            }
        }

        funcs.push(Func {
            range_start: range.start,
            range_end: range.end,
            func_index,
            locals,
        });
    }

    Ok(ModuleInfo {
        code_section_body_start: body_start,
        funcs,
        func_names,
        source_mapping_url,
        existing_debug_ranges,
        source_mapping_url_range,
    })
}

/// Expand a `custom.range()` (payload-only) to include the leading section-id
/// byte (0x00) and the section-size LEB128, so the returned range covers the
/// entire custom section and can be safely excised from the wasm bytes.
///
/// The size LEB is found by walking backwards from the payload: its final byte
/// (immediately before the payload) has the high bit clear, and any preceding
/// continuation bytes have it set. This handles tools (LLVM/emscripten) that
/// emit a padded, non-minimal size LEB rather than assuming a minimal encoding.
fn full_custom_section_range(
    wasm: &[u8],
    payload_range: &std::ops::Range<usize>,
) -> std::ops::Range<usize> {
    // Step back over the final size byte, then over continuation bytes.
    let mut p = payload_range.start.saturating_sub(1);
    while p > 0 && wasm[p - 1] & 0x80 != 0 {
        p -= 1;
    }
    // `p` now points at the first size byte; the section-id byte precedes it.
    let full_start = p.saturating_sub(1);
    full_start..payload_range.end
}

#[cfg(test)]
mod tests {
    use super::full_custom_section_range;

    #[test]
    fn full_range_minimal_leb() {
        // [id=0x00][size=0x03][3-byte payload]
        let wasm = [0x00, 0x03, 0xAA, 0xBB, 0xCC];
        assert_eq!(full_custom_section_range(&wasm, &(2..5)), 0..5);
    }

    #[test]
    fn full_range_padded_leb() {
        // [id=0x00][size=3 as a padded 5-byte LEB][3-byte payload]. LLVM and
        // emscripten emit non-minimal section sizes like this.
        let wasm = [0x00, 0x83, 0x80, 0x80, 0x80, 0x00, 0xAA, 0xBB, 0xCC];
        assert_eq!(full_custom_section_range(&wasm, &(6..9)), 0..9);
    }
}

fn collect_body_locals(body: FunctionBody) -> Result<Vec<(u32, ValType)>> {
    let mut locals_reader = body.get_locals_reader()?;
    let count = locals_reader.get_count();
    let mut locals = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let (n, ty) = locals_reader.read()?;
        locals.push((n, ty));
    }
    Ok(locals)
}

fn parse_name_section(
    reader: NameSectionReader,
    func_names: &mut HashMap<u32, String>,
    local_names: &mut HashMap<u32, HashMap<u32, String>>,
) -> Result<()> {
    for name in reader {
        match name? {
            Name::Function(map) => {
                for naming in map {
                    let naming = naming?;
                    func_names.insert(naming.index, naming.name.to_string());
                }
            }
            Name::Local(map) => {
                for indirect in map {
                    let indirect = indirect?;
                    let fn_idx = indirect.index;
                    for naming in indirect.names {
                        let naming = naming?;
                        local_names
                            .entry(fn_idx)
                            .or_default()
                            .insert(naming.index, naming.name.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}
