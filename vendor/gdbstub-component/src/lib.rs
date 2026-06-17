//! gdbstub protocol implementation in Wasmtime's debug-main world.

mod addr;
mod api;
mod target;

use crate::{
    addr::AddrSpace,
    api::{WasmType, WasmValue},
};
use anyhow::Result;
use clap::Parser;
use gdbstub::{
    common::{Signal, Tid},
    conn::Connection,
    stub::{
        MultiThreadStopReason,
        state_machine::{GdbStubStateMachine, GdbStubStateMachineInner, state::Running},
    },
};
use gdbstub_arch::wasm::addr::WasmAddr;
use log::trace;
use std::collections::BTreeMap;
use wstd::{
    io::{AsyncRead, AsyncWrite},
    iter::AsyncIterator,
    net::{TcpListener, TcpStream},
};

/// Command-line options.
#[derive(Parser)]
struct Options {
    /// The TCP address to listen on, in `<addr>:<port>` format.
    tcp_address: String,
    /// Verbose logging.
    #[clap(short = 'v')]
    verbose: bool,
}

struct Component;
api::export!(Component with_types_in api);

impl api::exports::bytecodealliance::wasmtime::debugger::Guest for Component {
    fn debug(d: &api::Debuggee, args: Vec<String>) {
        let options = Options::parse_from(args);
        if options.verbose {
            env_logger::Builder::new()
                .filter_level(log::LevelFilter::Trace)
                .init();
        }
        let mut debugger = Debugger {
            debuggee: d,
            threads: BTreeMap::new(),
            stopped_tid: Tid::new(1).unwrap(),
            options,
            running: None,
            interrupt: false,
            stepping_tid: None,
            addr_space: AddrSpace::new(),
        };
        wstd::runtime::block_on(async {
            if let Err(e) = debugger.run().await {
                trace!("debugger exited with error: {e}");
            }
        });
    }
}

pub(crate) struct ThreadState {
    pub current_pc: WasmAddr,
    pub frame_cache: Vec<api::Frame>,
}

struct Debugger<'a> {
    debuggee: &'a api::Debuggee,
    threads: BTreeMap<Tid, ThreadState>,
    stopped_tid: Tid,
    options: Options,
    running: Option<api::Resumption>,
    addr_space: AddrSpace,
    interrupt: bool,
    stepping_tid: Option<Tid>,
}

impl<'a> Debugger<'a> {
    async fn run(&mut self) -> Result<()> {
        // Load module info and initial thread state from the debuggee. Modules
        // are pre-registered on the debuggee store before the Debuggee is
        // created, so they are visible here without needing to execute any Wasm.
        self.update_on_stop();

        let listener = TcpListener::bind(&self.options.tcp_address)
            .await
            .expect("Could not bind to TCP port");

        api::print_debugger_info(&format!(
            "Debugger listening on {}",
            self.options.tcp_address,
        ));
        api::print_debugger_info(&format!(
            "In LLDB, attach with: process connect --plugin wasm connect://{}",
            self.options.tcp_address,
        ));

        // Only accept one connection for the run; once the debugger
        // disconnects, we'll just continue.
        let Some(connection) = listener.incoming().next().await else {
            return Ok(());
        };

        let gdbconn = Conn::new(connection?);
        let mut stub = gdbstub::stub::GdbStub::new(gdbconn).run_state_machine(&mut *self)?;

        // Main loop.
        'mainloop: loop {
            match stub {
                GdbStubStateMachine::Idle(mut inner) => {
                    if inner.borrow_conn().flush().await.is_err() {
                        // Connection closed or other outbound error.
                        break 'mainloop;
                    }

                    // Wait for an inbound network byte.
                    let Some(byte) = inner.borrow_conn().read_byte().await? else {
                        inner.borrow_conn().flush().await?;
                        log::info!("Connection closed; debugger detached.");
                        break 'mainloop;
                    };

                    stub = inner.incoming_data(self, byte)?;
                }

                GdbStubStateMachine::Running(mut inner) => {
                    if inner.borrow_conn().flush().await.is_err() {
                        // Connection closed or other outbound error.
                        break 'mainloop;
                    }

                    // Block until the debuggee reports the next event. The host
                    // bridges `EventFuture::finish` synchronously (it returns
                    // only once the next event occurs), so we do not need to
                    // poll the connection concurrently here. (Upstream used a
                    // wstd select! over a wasi pollable and the connection; that
                    // reactor path is unavailable under jco.)
                    let resumption = self.running.take().unwrap();
                    let event = resumption.result(self.debuggee)?;
                    stub = self.handle_event(event, inner).await?;
                }
                GdbStubStateMachine::CtrlCInterrupt(mut inner) => {
                    if inner.borrow_conn().flush().await.is_err() {
                        // Connection error: break.
                        break 'mainloop;
                    }
                    stub = inner.interrupt_handled(self, None::<MultiThreadStopReason<u64>>)?;
                }
                GdbStubStateMachine::Disconnected(mut inner) => {
                    // Eat any connection-closed errors -- we are
                    // already in Disconnected state.
                    let _ = inner.borrow_conn().flush().await;
                    break 'mainloop;
                }
            }
        }

        Ok(())
    }

    fn start_continue(&mut self, resumption: api::ResumptionValue) {
        assert!(self.running.is_none());
        trace!("continuing");
        self.stepping_tid = None;
        self.running = Some(api::Resumption::continue_(self.debuggee, resumption));
    }

    fn start_single_step(&mut self, tid: Tid, resumption: api::ResumptionValue) {
        assert!(self.running.is_none());
        trace!("single-stepping tid={}", tid.get());
        self.stepping_tid = Some(tid);
        self.running = Some(api::Resumption::single_step(
            self.debuggee,
            tid.get() as u32,
            resumption,
        ));
    }

    fn update_on_stop(&mut self) {
        self.addr_space.update(self.debuggee).unwrap();

        // Identify the thread that triggered the stop and the full live set.
        let stopped_n = self.debuggee.stopped_thread();
        if let Some(tid) = Tid::new(stopped_n as usize) {
            self.stopped_tid = tid;
        }
        let live: Vec<u32> = self.debuggee.list_threads();

        // Drop threads that no longer exist.
        let live_set: BTreeMap<Tid, ()> = live
            .iter()
            .filter_map(|&n| Tid::new(n as usize).map(|t| (t, ())))
            .collect();
        self.threads.retain(|tid, _| live_set.contains_key(tid));

        // Refresh the frame cache for every live thread.
        for n in live {
            let Some(tid) = Tid::new(n as usize) else {
                continue;
            };
            let mut frames: Vec<api::Frame> = vec![];
            let mut next = self.debuggee.exit_frames(n).into_iter().next();
            while let Some(f) = next {
                next = f.parent_frame(self.debuggee).unwrap();
                frames.push(f);
            }
            let current_pc = frames
                .first()
                .map(|f| self.addr_space.frame_to_pc(f, self.debuggee))
                .unwrap_or_else(|| WasmAddr::from_raw(0).unwrap());
            let ts = self.threads.entry(tid).or_insert(ThreadState {
                current_pc: WasmAddr::from_raw(0).unwrap(),
                frame_cache: vec![],
            });
            ts.current_pc = current_pc;
            ts.frame_cache = frames;
        }
    }

    async fn handle_event<'b>(
        &mut self,
        event: api::Event,
        inner: GdbStubStateMachineInner<'b, Running, Self, Conn>,
    ) -> Result<GdbStubStateMachine<'b, Self, Conn>> {
        let stopped_pc = self
            .threads
            .get(&self.stopped_tid)
            .map(|ts| ts.current_pc)
            .unwrap_or_else(|| WasmAddr::from_raw(0).unwrap());

        match event {
            api::Event::Complete => {
                trace!("Event::Complete");
                let pc_bytes = stopped_pc.as_raw().to_le_bytes();
                let mut regs = core::iter::once((
                    gdbstub_arch::wasm::reg::id::WasmRegId::Pc,
                    pc_bytes.as_slice(),
                ));
                Ok(inner.report_stop_with_regs(
                    self,
                    MultiThreadStopReason::Exited(0),
                    &mut regs,
                )?)
            }
            api::Event::Breakpoint => {
                trace!(
                    "Event::Breakpoint; stepping_tid = {:?}",
                    self.stepping_tid
                );
                self.update_on_stop();
                let stopped_pc = self
                    .threads
                    .get(&self.stopped_tid)
                    .map(|ts| ts.current_pc)
                    .unwrap_or_else(|| WasmAddr::from_raw(0).unwrap());
                let stop_reason = if self.stepping_tid.is_some() {
                    MultiThreadStopReason::SignalWithThread {
                        tid: self.stopped_tid,
                        signal: Signal::SIGTRAP,
                    }
                } else {
                    MultiThreadStopReason::SwBreak(self.stopped_tid)
                };
                let pc_bytes = stopped_pc.as_raw().to_le_bytes();
                let mut regs = core::iter::once((
                    gdbstub_arch::wasm::reg::id::WasmRegId::Pc,
                    pc_bytes.as_slice(),
                ));
                Ok(inner.report_stop_with_regs(self, stop_reason, &mut regs)?)
            }
            api::Event::Trap => {
                trace!("Event::Trap");
                self.update_on_stop();
                let stopped_pc = self
                    .threads
                    .get(&self.stopped_tid)
                    .map(|ts| ts.current_pc)
                    .unwrap_or_else(|| WasmAddr::from_raw(0).unwrap());
                let pc_bytes = stopped_pc.as_raw().to_le_bytes();
                let mut regs = core::iter::once((
                    gdbstub_arch::wasm::reg::id::WasmRegId::Pc,
                    pc_bytes.as_slice(),
                ));
                Ok(inner.report_stop_with_regs(
                    self,
                    MultiThreadStopReason::SignalWithThread {
                        tid: self.stopped_tid,
                        signal: Signal::SIGSEGV,
                    },
                    &mut regs,
                )?)
            }
            _ => {
                trace!("other event: {event:?}");
                if self.interrupt {
                    self.interrupt = false;
                    self.update_on_stop();
                    let stopped_pc = self
                        .threads
                        .get(&self.stopped_tid)
                        .map(|ts| ts.current_pc)
                        .unwrap_or_else(|| WasmAddr::from_raw(0).unwrap());
                    let pc_bytes = stopped_pc.as_raw().to_le_bytes();
                    let mut regs = core::iter::once((
                        gdbstub_arch::wasm::reg::id::WasmRegId::Pc,
                        pc_bytes.as_slice(),
                    ));
                    Ok(inner.report_stop_with_regs(
                        self,
                        MultiThreadStopReason::Signal(Signal::SIGINT),
                        &mut regs,
                    )?)
                } else {
                    if let Some(step_tid) = self.stepping_tid {
                        self.start_single_step(step_tid, api::ResumptionValue::Normal);
                    } else {
                        self.start_continue(api::ResumptionValue::Normal);
                    }
                    Ok(GdbStubStateMachine::Running(inner))
                }
            }
        }
    }

    fn value_to_bytes(&self, value: WasmValue) -> Vec<u8> {
        match value.get_type() {
            WasmType::WasmI32 => value.unwrap_i32().to_le_bytes().to_vec(),
            WasmType::WasmI64 => value.unwrap_i64().to_le_bytes().to_vec(),
            WasmType::WasmF32 => value.unwrap_f32().to_le_bytes().to_vec(),
            WasmType::WasmF64 => value.unwrap_f64().to_le_bytes().to_vec(),
            WasmType::WasmV128 => value.unwrap_v128(),
            WasmType::WasmFuncref => 0u32.to_le_bytes().to_vec(),
            WasmType::WasmExnref => 0u32.to_le_bytes().to_vec(),
        }
    }
}

struct Conn {
    buf: Vec<u8>,
    conn: TcpStream,
}

impl Conn {
    fn new(conn: TcpStream) -> Self {
        Conn { buf: vec![], conn }
    }

    async fn flush(&mut self) -> anyhow::Result<()> {
        self.conn.write_all(&self.buf).await?;
        self.buf.clear();
        Ok(())
    }

    async fn read_byte(&mut self) -> Result<Option<u8>> {
        let mut buf = [0u8];
        let len = self.conn.read(&mut buf).await?;
        if len == 1 { Ok(Some(buf[0])) } else { Ok(None) }
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        assert!(
            self.buf.is_empty(),
            "failed to async-flush before dropping connection write buffer"
        );
    }
}

impl Connection for Conn {
    type Error = anyhow::Error;

    fn write(&mut self, byte: u8) -> std::result::Result<(), Self::Error> {
        self.buf.push(byte);
        Ok(())
    }

    fn flush(&mut self) -> std::result::Result<(), Self::Error> {
        // We cannot flush synchronously; we leave this to the `async
        // fn flush` method called within the main loop. Fortunately
        // the gdbstub cannot wait for a response before returning to
        // the main loop, so we cannot introduce any deadlocks by
        // failing to flush synchronously here.
        Ok(())
    }
}
