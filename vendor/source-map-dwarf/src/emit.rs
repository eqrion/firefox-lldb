use crate::{Options, Result, dwarf::DebugSection, wasm::ModuleInfo};

/// Append `.debug_*` custom sections to `wasm`, returning a new buffer.
///
/// We append rather than re-encode the module so all byte offsets in the
/// original binary remain valid (source map columns are file-relative).
///
/// Existing `.debug_*` sections are hidden by changing their first name byte.
/// Hide `sourceMappingURL` too unless requested. Keeping their sizes preserves
/// code offsets even when these custom sections precede the code section.
pub fn append(
    wasm: &[u8],
    module: &ModuleInfo,
    sections: Vec<DebugSection>,
    opts: &Options,
) -> Result<Vec<u8>> {
    let mut hidden_ranges = module.existing_debug_ranges.clone();
    if !opts.keep_source_mapping_url {
        if let Some(ref r) = module.source_mapping_url_range {
            hidden_ranges.push(r.clone());
        }
    }
    let mut out = Vec::with_capacity(wasm.len() + sections.iter().map(|s| s.data.len() + 64).sum::<usize>());
    out.extend_from_slice(wasm);
    for range in hidden_ranges {
        // parse() validated the section and both LEB lengths. Skip the section
        // size and name length, including non-minimal encodings from LLVM.
        let mut pos = range.start + 1;
        for _ in 0..2 {
            while out[pos] & 0x80 != 0 { pos += 1; }
            pos += 1;
        }
        out[pos] = b'_';
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
