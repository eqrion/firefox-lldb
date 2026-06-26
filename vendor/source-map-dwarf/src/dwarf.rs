use std::collections::HashMap;

use gimli::{
    DW_AT_byte_size, DW_AT_comp_dir, DW_AT_encoding, DW_AT_external, DW_AT_high_pc,
    DW_AT_language, DW_AT_location, DW_AT_low_pc, DW_AT_name, DW_AT_producer, DW_AT_stmt_list,
    DW_AT_type, DW_ATE_float, DW_ATE_signed, DW_ATE_unsigned, DW_LANG_C99, DW_TAG_base_type,
    DW_TAG_formal_parameter, DW_TAG_subprogram, DW_TAG_variable, LineEncoding,
};
use gimli::write::{
    Address, AttributeValue, DwarfUnit, EndianVec, Expression, FileInfo, LineProgram,
    LineString, Sections, UnitEntryId,
};

use sourcemap::SourceMap;

use crate::{
    Options, Result,
    addr::{file_to_dwarf, write_uleb128},
    wasm::{ModuleInfo, WasmValType},
};

pub struct DebugSection {
    pub name: &'static str,
    pub data: Vec<u8>,
}

pub fn build(module: &ModuleInfo, sm: &SourceMap, opts: &Options) -> Result<Vec<DebugSection>> {
    let encoding = gimli::Encoding {
        format: gimli::Format::Dwarf32,
        version: 4,
        address_size: 4,
    };

    let comp_dir = opts.comp_dir.as_deref().unwrap_or("/");
    let comp_name = "module.wasm";

    let line_program = build_line_program(encoding, module, sm, comp_dir, comp_name);
    let mut dwarf = DwarfUnit::new(encoding);
    dwarf.unit.line_program = line_program;

    let root_id = dwarf.unit.root();
    {
        let root = dwarf.unit.get_mut(root_id);
        root.set(DW_AT_producer, AttributeValue::String(b"source-map-dwarf".to_vec()));
        root.set(DW_AT_language, AttributeValue::Language(DW_LANG_C99));
        root.set(DW_AT_name, AttributeValue::String(comp_name.as_bytes().to_vec()));
        root.set(DW_AT_comp_dir, AttributeValue::String(comp_dir.as_bytes().to_vec()));
        root.set(DW_AT_low_pc, AttributeValue::Address(Address::Constant(0)));
        root.set(DW_AT_stmt_list, AttributeValue::LineProgramRef);
    }

    let base_type_dies = add_base_types(&mut dwarf, root_id);
    add_subprograms(&mut dwarf, root_id, module, sm, &base_type_dies, opts);

    let mut sections = Sections::new(EndianVec::new(gimli::LittleEndian));
    dwarf.write(&mut sections)?;

    let mut result = Vec::new();
    sections.for_each(|id, data| -> std::result::Result<(), gimli::write::Error> {
        let bytes = data.slice();
        if !bytes.is_empty() {
            result.push(DebugSection { name: id.name(), data: bytes.to_vec() });
        }
        Ok(())
    })?;

    Ok(result)
}

fn build_line_program(
    encoding: gimli::Encoding,
    module: &ModuleInfo,
    sm: &SourceMap,
    comp_dir: &str,
    comp_name: &str,
) -> LineProgram {
    let comp_dir_ls = LineString::String(comp_dir.as_bytes().to_vec());
    let comp_name_ls = LineString::String(comp_name.as_bytes().to_vec());
    let line_encoding = LineEncoding::default();
    let mut program = LineProgram::new(encoding, line_encoding, comp_dir_ls, None, comp_name_ls, None);

    // Map source path → FileId so we can look up by token.get_source().
    let mut file_ids: HashMap<String, gimli::write::FileId> = HashMap::new();
    for i in 0..sm.get_source_count() {
        if let Some(src) = sm.get_source(i) {
            let (dir_ls, file_ls) = split_path(src);
            let dir_id = program.add_directory(dir_ls);
            let file_id = program.add_file(file_ls, dir_id, None::<FileInfo>);
            file_ids.insert(src.to_string(), file_id);
        }
    }

    let body_start = module.code_section_body_start;

    // Collect tokens with a known source, sorted by generated column (= file byte offset).
    let mut tokens: Vec<_> = sm
        .tokens()
        .filter(|t| t.get_source().is_some())
        .collect();
    tokens.sort_by_key(|t| t.get_dst_col());

    for func in &module.funcs {
        let fn_start = func.range_start as u64;
        let fn_end = func.range_end as u64;

        let rows: Vec<_> = tokens
            .iter()
            .filter(|t| {
                let col = t.get_dst_col() as u64;
                col >= fn_start && col < fn_end
            })
            .collect();

        if rows.is_empty() {
            continue;
        }

        let first_addr = file_to_dwarf(rows[0].get_dst_col() as u64, body_start);
        program.begin_sequence(Some(Address::Constant(first_addr)));

        for token in &rows {
            let src = match token.get_source() {
                Some(s) => s,
                None => continue,
            };
            let file_id = match file_ids.get(src) {
                Some(&f) => f,
                None => continue,
            };
            let addr = file_to_dwarf(token.get_dst_col() as u64, body_start);
            let row = program.row();
            row.address_offset = addr - first_addr;
            row.file = file_id;
            row.line = (token.get_src_line() + 1) as u64;
            row.column = (token.get_src_col() + 1) as u64;
            row.is_statement = true;
            program.generate_row();
        }

        let end_addr = file_to_dwarf(fn_end, body_start);
        program.end_sequence(end_addr - first_addr);
    }

    program
}

fn split_path(path: &str) -> (LineString, LineString) {
    let (dir, file) = match path.rfind('/') {
        Some(i) => (&path[..i], &path[i + 1..]),
        None => (".", path),
    };
    (
        LineString::String(dir.as_bytes().to_vec()),
        LineString::String(file.as_bytes().to_vec()),
    )
}

fn add_base_types(
    dwarf: &mut DwarfUnit,
    root_id: UnitEntryId,
) -> HashMap<WasmValType, UnitEntryId> {
    let mut map = HashMap::new();

    let types: &[(WasmValType, &str, u8, gimli::DwAte)] = &[
        (WasmValType::I32, "int32_t", 4, DW_ATE_signed),
        (WasmValType::I64, "int64_t", 8, DW_ATE_signed),
        (WasmValType::F32, "float", 4, DW_ATE_float),
        (WasmValType::F64, "double", 8, DW_ATE_float),
        (WasmValType::V128, "v128", 16, DW_ATE_unsigned),
    ];

    for &(vt, name, size, enc) in types {
        let id = dwarf.unit.add(root_id, DW_TAG_base_type);
        let entry = dwarf.unit.get_mut(id);
        entry.set(DW_AT_name, AttributeValue::String(name.as_bytes().to_vec()));
        entry.set(DW_AT_encoding, AttributeValue::Encoding(enc));
        entry.set(DW_AT_byte_size, AttributeValue::Udata(size as u64));
        map.insert(vt, id);
    }
    map
}

fn add_subprograms(
    dwarf: &mut DwarfUnit,
    root_id: UnitEntryId,
    module: &ModuleInfo,
    sm: &SourceMap,
    base_types: &HashMap<WasmValType, UnitEntryId>,
    _opts: &Options,
) {
    let body_start = module.code_section_body_start;
    let _ = sm;

    for func in &module.funcs {
        let name = module
            .func_names
            .get(&func.func_index)
            .cloned()
            .unwrap_or_else(|| format!("func{}", func.func_index));

        let low_pc = file_to_dwarf(func.range_start as u64, body_start);
        let high_pc = file_to_dwarf(func.range_end as u64, body_start);

        let sub_id = dwarf.unit.add(root_id, DW_TAG_subprogram);
        {
            let sub = dwarf.unit.get_mut(sub_id);
            sub.set(DW_AT_name, AttributeValue::String(name.into_bytes()));
            sub.set(DW_AT_low_pc, AttributeValue::Address(Address::Constant(low_pc)));
            sub.set(DW_AT_high_pc, AttributeValue::Udata(high_pc - low_pc));
            sub.set(DW_AT_external, AttributeValue::Flag(true));
        }

        for (local_idx, local) in func.locals.iter().enumerate() {
            let tag = if local.is_param { DW_TAG_formal_parameter } else { DW_TAG_variable };
            let var_id = dwarf.unit.add(sub_id, tag);
            let entry = dwarf.unit.get_mut(var_id);

            entry.set(DW_AT_name, AttributeValue::String(local.name.as_bytes().to_vec()));

            if let Some(&type_id) = base_types.get(&local.val_type) {
                entry.set(DW_AT_type, AttributeValue::UnitRef(type_id));
            }

            // DW_OP_WASM_location 0x00 (local) followed by local index as ULEB128.
            let mut expr_bytes = vec![0xED, 0x00];
            write_uleb128(&mut expr_bytes, local_idx as u64);
            entry.set(DW_AT_location, AttributeValue::Exprloc(Expression::raw(expr_bytes)));
        }
    }
}
