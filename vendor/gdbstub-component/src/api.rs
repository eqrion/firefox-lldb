//! Bindings for Wasmtime's debugger API.

wit_bindgen::generate!({
    world: "bytecodealliance:wasmtime/debug-main",
    path: "wit",
    with: {
        "wasi:io/poll@0.2.12": wasip2::io::poll,
    }
});
pub(crate) use bytecodealliance::wasmtime::debuggee::*;

/// One "resumption", or period of execution, in the debuggee.
///
/// Upstream awaits the resumption through a `wasi:io/poll` pollable via wstd's
/// reactor. We run this component inside a worker and bridge the `debuggee`
/// interface to an async host (RDP) over a synchronous SharedArrayBuffer RPC,
/// so `EventFuture::finish` already blocks until the next event arrives. We
/// therefore drop the pollable/reactor machinery: `wait()` is a no-op and
/// `result()` simply calls `finish()`. (The upstream reactor path also panics
/// under jco, where `Reactor::current` is unavailable in gdbstub's synchronous
/// resume() call.)
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

    pub async fn wait(&mut self) {}

    pub fn result(self, d: &Debuggee) -> std::result::Result<Event, Error> {
        EventFuture::finish(self.future, d)
    }
}
