use crate::{Options, Result, dwarf::DebugSection, wasm::ModuleInfo};

/// Append `.debug_*` custom sections to `wasm`, returning a new buffer.
///
/// We append rather than re-encode the module so all byte offsets in the
/// original binary remain valid (source map columns are file-relative).
///
/// Existing `.debug_*` sections and the `sourceMappingURL` section are dropped
/// when `opts.keep_source_mapping_url` is false.
pub fn append(
    wasm: &[u8],
    module: &ModuleInfo,
    sections: Vec<DebugSection>,
    opts: &Options,
) -> Result<Vec<u8>> {
    // Build a sorted list of byte ranges to skip from the original bytes.
    let mut skip_ranges: Vec<std::ops::Range<usize>> = module.existing_debug_ranges.clone();
    if !opts.keep_source_mapping_url {
        if let Some(ref r) = module.source_mapping_url_range {
            skip_ranges.push(r.clone());
        }
    }
    skip_ranges.sort_by_key(|r| r.start);

    // Copy original bytes minus skipped ranges.
    let mut out = Vec::with_capacity(wasm.len() + sections.iter().map(|s| s.data.len() + 64).sum::<usize>());
    let mut pos = 0usize;
    for skip in &skip_ranges {
        if pos < skip.start {
            out.extend_from_slice(&wasm[pos..skip.start]);
        }
        pos = skip.end;
    }
    if pos < wasm.len() {
        out.extend_from_slice(&wasm[pos..]);
    }

    // Append each debug section.
    for sec in sections {
        write_custom_section(&mut out, sec.name, &sec.data);
    }

    Ok(out)
}

fn write_custom_section(out: &mut Vec<u8>, name: &str, data: &[u8]) {
    out.push(0x00); // custom section id

    let name_bytes = name.as_bytes();
    let name_len_leb_size = uleb128_size(name_bytes.len() as u64);
    let payload_len = name_len_leb_size + name_bytes.len() + data.len();

    write_uleb128(out, payload_len as u64);
    write_uleb128(out, name_bytes.len() as u64);
    out.extend_from_slice(name_bytes);
    out.extend_from_slice(data);
}

fn uleb128_size(mut v: u64) -> usize {
    let mut n = 1;
    while v >= 0x80 {
        v >>= 7;
        n += 1;
    }
    n
}

fn write_uleb128(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let mut byte = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if v == 0 {
            break;
        }
    }
}
