//! Bindings for Wasmtime's debugger API.

wit_bindgen::generate!({
    world: "bytecodealliance:wasmtime/debug-main",
    path: "wit",
    with: {
        "wasi:io/poll@0.2.12": wasip2::io::poll,
    }
});
pub(crate) use bytecodealliance::wasmtime::debuggee::*;

/// Owns one execution future. `finish` blocks this worker on the host's SAB
/// response; no wstd poll reactor participates. See docs/COMPATIBILITY.md for
/// the resulting protocol-interrupt limitation.
pub struct Resumption {
    future: EventFuture,
}

impl Resumption {
    pub fn continue_(d: &Debuggee, r: ResumptionValue) -> Self {
        Resumption {
            future: d.continue_(r),
        }
    }

    pub fn single_step(d: &Debuggee, tid: u32, r: ResumptionValue) -> Self {
        Resumption {
            future: d.single_step(tid, r),
        }
    }

    pub fn result(self, d: &Debuggee) -> std::result::Result<Event, Error> {
        EventFuture::finish(self.future, d)
    }
}
