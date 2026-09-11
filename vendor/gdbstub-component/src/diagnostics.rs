//! Bounded producer-side diagnostics; these never change the bytes sent to gdbstub.

use std::fmt::{self, Write};

const RECORD_BYTES: usize = 3072;
const PACKET_PREFIX_BYTES: usize = 1024;

pub struct HostLogger;

struct Record(String);

impl Write for Record {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        let remaining = RECORD_BYTES.saturating_sub(self.0.len());
        if value.len() <= remaining {
            self.0.push_str(value);
            return Ok(());
        }
        let mut end = remaining;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        self.0.push_str(&value[..end]);
        Err(fmt::Error)
    }
}

impl log::Log for HostLogger {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        let mut output = Record(String::with_capacity(RECORD_BYTES));
        if write!(
            output,
            "{} {}: {}",
            record.level(),
            record.target(),
            record.args()
        )
        .is_err()
        {
            output.0.push_str(" [truncated]");
        }
        // A direct host call preserves ordering without worker stdio buffering.
        crate::api::log_line(&output.0);
    }

    fn flush(&self) {}
}

pub fn outbound(bytes: &[u8]) {
    if log::log_enabled!(log::Level::Trace) {
        let prefix = &bytes[..bytes.len().min(PACKET_PREFIX_BYTES)];
        log::trace!(
            ">> bytes={} omitted={} {}",
            bytes.len(),
            bytes.len() - prefix.len(),
            String::from_utf8_lossy(prefix)
        );
    }
}

#[derive(Default)]
pub struct Inbound {
    prefix: Vec<u8>,
    bytes: usize,
    checksum: Option<u8>,
}

impl Inbound {
    pub fn push(&mut self, byte: u8) {
        if self.bytes == 0 {
            match byte {
                b'+' | b'-' => {
                    log::trace!("<< {}", char::from(byte));
                    return;
                }
                0x03 => {
                    log::trace!("<< interrupt");
                    return;
                }
                _ => {}
            }
        }
        self.bytes = self.bytes.saturating_add(1);
        if self.prefix.len() < PACKET_PREFIX_BYTES {
            self.prefix.push(byte);
        }
        // '#' is escaped in packet bodies. Count only the two checksum bytes;
        // never rescan or retain the full packet just to produce a trace.
        if let Some(left) = self.checksum {
            if left == 1 {
                self.finish(false);
            } else {
                self.checksum = Some(left - 1);
            }
        } else if byte == b'#' {
            self.checksum = Some(2);
        }
    }

    pub fn finish(&mut self, incomplete: bool) {
        if self.bytes == 0 {
            return;
        }
        log::trace!(
            "<< bytes={} omitted={} incomplete={} {}",
            self.bytes,
            self.bytes - self.prefix.len(),
            incomplete,
            String::from_utf8_lossy(&self.prefix)
        );
        self.prefix.clear();
        self.bytes = 0;
        self.checksum = None;
    }
}
