use std::path::Path;

use sourcemap::SourceMap;

use crate::{Error, Options, Result, SourceMapInput, wasm::ModuleInfo};

pub fn resolve(wasm: &[u8], module: &ModuleInfo, opts: &Options) -> Result<Option<SourceMap>> {
    let _ = wasm;
    match &opts.source_map {
        SourceMapInput::Bytes(bytes) => Ok(Some(decode(bytes)?)),
        SourceMapInput::Path(path) => {
            let bytes = std::fs::read(path)?;
            Ok(Some(decode(&bytes)?))
        }
        SourceMapInput::Auto => resolve_auto(module, opts),
    }
}

fn resolve_auto(module: &ModuleInfo, opts: &Options) -> Result<Option<SourceMap>> {
    let url = match &module.source_mapping_url {
        Some(u) => u,
        None => return Ok(None),
    };

    if let Some(b64) = url.strip_prefix("data:application/json;base64,") {
        let bytes = decode_base64(b64.trim())?;
        return Ok(Some(decode(&bytes)?));
    }

    if let Some(b64) = url.strip_prefix("data:application/json;charset=utf-8;base64,") {
        let bytes = decode_base64(b64.trim())?;
        return Ok(Some(decode(&bytes)?));
    }

    // URL looks like a path; resolve relative to the wasm file.
    if let Some(wasm_path) = &opts.wasm_path {
        let base = wasm_path.parent().unwrap_or_else(|| Path::new("."));
        let map_path = base.join(url);
        let bytes = std::fs::read(&map_path)?;
        return Ok(Some(decode(&bytes)?));
    }

    // Plain relative URL but no wasm path given — try it as-is.
    let bytes = std::fs::read(url)?;
    Ok(Some(decode(&bytes)?))
}

fn decode(bytes: &[u8]) -> Result<SourceMap> {
    match sourcemap::decode_slice(bytes)? {
        sourcemap::DecodedMap::Regular(sm) => Ok(sm),
        _ => Err(Error::SourceMapFormat),
    }
}

/// Minimal base64 decoder (no padding variants, standard alphabet).
fn decode_base64(s: &str) -> Result<Vec<u8>> {
    const ALPHA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut table = [0xffu8; 256];
    for (i, &c) in ALPHA.iter().enumerate() {
        table[c as usize] = i as u8;
    }

    let s = s.trim_end_matches('=');
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4 + 1);

    let mut i = 0;
    while i + 3 < bytes.len() {
        let a = table[bytes[i] as usize];
        let b = table[bytes[i + 1] as usize];
        let c = table[bytes[i + 2] as usize];
        let d = table[bytes[i + 3] as usize];
        if a == 0xff || b == 0xff {
            return Err(Error::Base64);
        }
        out.push((a << 2) | (b >> 4));
        if c != 0xff {
            out.push((b << 4) | (c >> 2));
        }
        if d != 0xff {
            out.push((c << 6) | d);
        }
        i += 4;
    }

    let rem = bytes.len() - i;
    if rem >= 2 {
        let a = table[bytes[i] as usize];
        let b = table[bytes[i + 1] as usize];
        if a == 0xff || b == 0xff {
            return Err(Error::Base64);
        }
        out.push((a << 2) | (b >> 4));
        if rem >= 3 {
            let c = table[bytes[i + 2] as usize];
            if c != 0xff {
                out.push((b << 4) | (c >> 2));
            }
        }
    }

    Ok(out)
}
