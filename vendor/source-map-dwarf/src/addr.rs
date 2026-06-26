/// Convert a wasm file byte offset (as stored in a source map column) to a
/// DWARF code-section-relative address.
///
/// `body_start` is the file offset of the first byte of the code section payload
/// (the function-count LEB128), which comes from `CodeSectionStart.range.start`.
pub fn file_to_dwarf(file_offset: u64, body_start: u64) -> u64 {
    file_offset.saturating_sub(body_start)
}

/// Inverse of `file_to_dwarf`. Used in tests.
#[cfg(test)]
pub fn dwarf_to_file(dwarf_addr: u64, body_start: u64) -> u64 {
    dwarf_addr + body_start
}

/// Encode `value` as ULEB128 into `out`.
pub fn write_uleb128(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let body_start = 42u64;
        let file_off = 100u64;
        let dwarf = file_to_dwarf(file_off, body_start);
        assert_eq!(dwarf, 58);
        assert_eq!(dwarf_to_file(dwarf, body_start), file_off);
    }

    #[test]
    fn uleb128_single_byte() {
        let mut buf = vec![];
        write_uleb128(&mut buf, 5);
        assert_eq!(buf, [5]);
    }

    #[test]
    fn uleb128_multibyte() {
        let mut buf = vec![];
        write_uleb128(&mut buf, 128);
        assert_eq!(buf, [0x80, 0x01]);
    }
}
