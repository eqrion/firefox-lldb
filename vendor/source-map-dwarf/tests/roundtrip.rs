/// Round-trip tests: generate random wasm modules, synthesize source maps,
/// convert to DWARF, and verify correctness via wasmparser::validate,
/// gimli structure checks, and wasm-tools addr2line.

use arbitrary::Unstructured;
use gimli::{LittleEndian, read::{Dwarf, EndianSlice}};
use source_map_dwarf::{Options, SourceMapInput, convert};
use sourcemap::SourceMapBuilder;
use wasm_smith::{Config, Module};

// ── helpers ──────────────────────────────────────────────────────────────────

fn make_seed(seed: u64) -> Vec<u8> {
    let mut v = Vec::with_capacity(1024);
    for i in 0..128u64 {
        v.extend_from_slice(&(seed ^ (i.wrapping_mul(6364136223846793005))).to_le_bytes());
    }
    v
}

fn generate_module(seed: u64) -> Vec<u8> {
    let seed_data = make_seed(seed);
    let mut u = Unstructured::new(&seed_data);
    let mut config = Config::default();
    config.bulk_memory_enabled = false;
    config.exceptions_enabled = false;
    config.gc_enabled = false;
    config.min_funcs = 1;
    Module::new(config, &mut u).expect("generate module").to_bytes()
}

fn code_section_body_start(wasm: &[u8]) -> Option<u64> {
    use wasmparser::{Parser, Payload};
    for p in Parser::new(0).parse_all(wasm) {
        if let Ok(Payload::CodeSectionStart { range, .. }) = p {
            return Some(range.start as u64);
        }
    }
    None
}

/// Returns the file byte ranges of all function bodies in the module.
fn function_body_ranges(wasm: &[u8]) -> Vec<std::ops::Range<u32>> {
    use wasmparser::{Parser, Payload};
    let mut ranges = Vec::new();
    for p in Parser::new(0).parse_all(wasm) {
        if let Ok(Payload::CodeSectionEntry(body)) = p {
            let r = body.range();
            ranges.push(r.start as u32..r.end as u32);
        }
    }
    ranges
}

/// Build a source map with deterministic tokens pointing at byte offsets that
/// lie within a function body (so the DWARF will have line table rows for them).
/// Returns (map_json, tokens) where each token is
/// (file_offset, src_line_0based, src_col_0based).
fn make_source_map(wasm: &[u8]) -> (Vec<u8>, Vec<(u32, u32, u32)>) {
    let func_ranges = function_body_ranges(wasm);
    let mut builder = SourceMapBuilder::new(None);
    let src = builder.add_source("src/main.ts");
    builder.set_source_contents(src, Some("// generated test source"));

    let mut tokens: Vec<(u32, u32, u32)> = Vec::new();
    let mut src_line = 0u32;
    let mut src_col = 0u32;

    'outer: for r in &func_ranges {
        for offset in r.start..r.end {
            let byte = wasm[offset as usize];
            if matches!(byte, 0x00 | 0x01 | 0x0B) && tokens.len() < 50 {
                builder.add_raw(0, offset, src_line, src_col, Some(src), None, false);
                tokens.push((offset, src_line, src_col));
                src_col += 4;
                if src_col > 80 {
                    src_col = 0;
                    src_line += 1;
                }
            }
            if tokens.len() >= 50 {
                break 'outer;
            }
        }
    }

    let mut out = Vec::new();
    builder.into_sourcemap().to_writer(&mut out).expect("write source map");
    (out, tokens)
}

fn find_wasm_tools() -> Option<std::path::PathBuf> {
    // Prefer the wasm-tools already on PATH (likely ~/.cargo/bin/wasm-tools).
    let search = ["wasm-tools"];
    for name in search {
        if let Some(p) = find_in_path(name) {
            return Some(p);
        }
    }
    None
}

fn find_in_path(name: &str) -> Option<std::path::PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

// ── tests ────────────────────────────────────────────────────────────────────

/// For each of 16 seeds: generate module, convert with a synthetic source map,
/// validate wasm, verify DWARF structure, and verify addr2line lookups.
#[test]
fn round_trip_valid_wasm() {
    let wasm_tools = find_wasm_tools();
    let mut modules_tested = 0;

    for seed in 0..2048 {
        let wasm = generate_module(seed);
        let Some(body_start) = code_section_body_start(&wasm) else { continue };

        let (sm_bytes, expected_tokens) = make_source_map(&wasm);
        if expected_tokens.is_empty() {
            continue;
        }

        let opts = Options {
            source_map: SourceMapInput::Bytes(sm_bytes.clone()),
            ..Default::default()
        };

        let result = convert(&wasm, &opts).unwrap_or_else(|e| {
            panic!("seed={seed}: convert failed: {e}");
        });

        wasmparser::validate(&result).unwrap_or_else(|e| {
            panic!("seed={seed}: output is invalid wasm: {e}");
        });

        verify_dwarf_structure(&result, &sm_bytes, body_start, seed);

        if let Some(ref tool) = wasm_tools {
            verify_addr2line(tool, &result, &expected_tokens, seed);
        }

        modules_tested += 1;
    }

    assert!(modules_tested >= 256, "too few modules had code sections: {modules_tested}");
}

/// Verify basic DWARF structure using gimli::read.
fn verify_dwarf_structure(wasm_out: &[u8], sm_bytes: &[u8], body_start: u64, seed: u64) {
    use wasmparser::{Parser, Payload};

    let mut debug_sections: std::collections::HashMap<String, Vec<u8>> =
        std::collections::HashMap::new();
    for p in Parser::new(0).parse_all(wasm_out) {
        if let Ok(Payload::CustomSection(custom)) = p {
            if custom.name().starts_with(".debug_") {
                debug_sections.insert(custom.name().to_string(), custom.data().to_vec());
            }
        }
    }

    assert!(debug_sections.contains_key(".debug_info"), "seed={seed}: missing .debug_info");
    assert!(debug_sections.contains_key(".debug_line"), "seed={seed}: missing .debug_line");

    let load = |id: gimli::SectionId| -> Result<EndianSlice<LittleEndian>, gimli::Error> {
        let data: &[u8] = debug_sections.get(id.name()).map(|v| v.as_slice()).unwrap_or(&[]);
        Ok(EndianSlice::new(data, LittleEndian))
    };

    let dwarf = Dwarf::load(load).expect("load DWARF");
    let mut units = dwarf.units();
    let unit_header = units.next().unwrap().expect("at least one CU");
    let unit = dwarf.unit(unit_header).expect("parse CU");
    let mut entries = unit.entries();
    let root = entries.next_dfs().unwrap().unwrap();
    assert_eq!(root.tag(), gimli::DW_TAG_compile_unit, "seed={seed}");

    // Every line-table row must have a file-relative address within the binary.
    let sm = match sourcemap::decode_slice(sm_bytes).unwrap() {
        sourcemap::DecodedMap::Regular(sm) => sm,
        _ => panic!("expected regular source map"),
    };

    let ilnp = unit.line_program.clone().unwrap();
    let mut rows = ilnp.rows();
    let mut found_any = false;
    while let Ok(Some((_, row))) = rows.next_row() {
        if row.end_sequence() {
            continue;
        }
        let file_offset = row.address() + body_start;
        assert!(
            file_offset < wasm_out.len() as u64,
            "seed={seed}: line row at file offset {file_offset} is out of bounds"
        );
        if sm.lookup_token(0, file_offset as u32).is_some() {
            found_any = true;
        }
    }
    assert!(found_any, "seed={seed}: no source-map-matching rows in DWARF line table");
}

/// Verify semantic correctness: for each source map token, run
/// `wasm-tools addr2line <file_offset>` and confirm the output contains
/// the expected source line and column.
///
/// addr2line takes file-relative addresses by default, which matches our
/// source map column values.
fn verify_addr2line(
    wasm_tools: &std::path::Path,
    wasm_out: &[u8],
    tokens: &[(u32, u32, u32)],
    seed: u64,
) {
    // Write output to a temp file.
    let tmp = std::env::temp_dir().join(format!("smd_addr2line_{seed}.wasm"));
    std::fs::write(&tmp, wasm_out).expect("write temp wasm");

    // Spot-check up to 5 tokens to keep test fast.
    let sample: Vec<_> = tokens
        .iter()
        .step_by((tokens.len() / 5).max(1))
        .take(5)
        .collect();

    for &(file_offset, src_line_0, src_col_0) in &sample {
        let addr_str = format!("0x{file_offset:x}");
        let output = std::process::Command::new(wasm_tools)
            .arg("addr2line")
            .arg(&tmp)
            .arg(&addr_str)
            .output()
            .expect("run wasm-tools addr2line");

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        // addr2line exits 0 even for unknown addresses; an error here means
        // something structural is wrong.
        assert!(
            output.status.success(),
            "seed={seed} addr={addr_str}: addr2line failed\nstdout: {stdout}\nstderr: {stderr}"
        );

        // Source map lines/cols are 0-based; DWARF and addr2line output is 1-based.
        let expected_line = src_line_0 + 1;
        let expected_col = src_col_0 + 1;

        // Output format: "0x...: func_name file:line:col"
        // We look for "line:col" anywhere in the output.
        let location_str = format!("{expected_line}:{expected_col}");
        assert!(
            stdout.contains(&location_str),
            "seed={seed} addr={addr_str}: expected {location_str} in addr2line output\n\
             got: {stdout}\nstderr: {stderr}"
        );
    }

    std::fs::remove_file(&tmp).ok();
}

#[test]
fn no_source_map_in_input_errors() {
    #[rustfmt::skip]
    let wasm: &[u8] = &[
        0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00,  // magic + version
        0x01, 0x04, 0x01, 0x60, 0x00, 0x00,               // type: ()→()
        0x03, 0x02, 0x01, 0x00,                            // function section
        0x0A, 0x04, 0x01, 0x02, 0x00, 0x0B,               // code: nop + end
    ];
    match convert(wasm, &Options::default()) {
        Err(source_map_dwarf::Error::NoSourceMap) => {}
        Err(e) => panic!("unexpected error: {e}"),
        Ok(_) => panic!("expected NoSourceMap error"),
    }
}

#[test]
fn existing_debug_sections_replaced() {
    let wasm = generate_module(3);
    let Some(_body_start) = code_section_body_start(&wasm) else { return };
    let (sm_bytes, _) = make_source_map(&wasm);
    let opts = Options {
        source_map: SourceMapInput::Bytes(sm_bytes.clone()),
        ..Default::default()
    };

    let out1 = convert(&wasm, &opts).expect("first convert");
    let out2 = convert(&out1, &opts).expect("second convert");

    wasmparser::validate(&out2).expect("double-converted output is valid wasm");

    use wasmparser::{Parser, Payload};
    let count_debug = |data: &[u8]| {
        Parser::new(0)
            .parse_all(data)
            .filter(|p| matches!(p, Ok(Payload::CustomSection(c)) if c.name().starts_with(".debug_")))
            .count()
    };
    assert_eq!(count_debug(&out2), count_debug(&out1), "double convert produced extra sections");
}
