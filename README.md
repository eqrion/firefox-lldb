# firefox-lldb

Work in progress.

This project implements an LLDB platform server and GDB remote stub that let a
stock LLDB client debug WebAssembly running inside Firefox. It bridges two
protocols: LLDB's [GDB remote serial protocol](https://lldb.llvm.org/resources/lldbgdbremote.html)
(RSP, including the LLDB wasm extensions) and the Firefox
[Remote Debug Protocol](https://firefox-source-docs.mozilla.org/devtools/backend/protocol.html)
(RDP).

Implementation: TypeScript on Node, with the
[wasmtime gdbstub-component](https://github.com/bytecodealliance/wasmtime/tree/main/crates/gdbstub-component)
transpiled to JS via [jco](https://github.com/bytecodealliance/jco) providing
the RSP/wasm state machine. We implement its "debuggee" interface on top of RDP.

## Architecture

The bridge has two layers:

### 1. Platform server (the browser)

Models the entire browser as an LLDB platform:
- Tabs = processes
- A localhost HTTP server = the remote filesystem
- `qLaunchGDBServer` spawns a per-tab GDB server (below)

This layer is built first because it is the test harness: LLDB's own platform
testsuite can be run against it directly, giving us conformance coverage without
writing our own tests.

### 2. GDB server (per-tab)

Speaks RSP to LLDB over a TCP port, translating to RDP. LLDB connects using the
`wasm` process plugin. For bring-up and isolated testing the GDB server can also
be reached directly via `connect://localhost:<port>` without going through the
platform layer.

### Launching Firefox

```
firefox --headless --start-debugger-server <port>
```

Required prefs: `devtools.debugger.remote-enabled=true`,
`devtools.chrome.enabled=true`.

RDP transport: length-prefixed JSON (`<byte-length>:<json>`,
`devtools/shared/transport/packets.js`). WebSocket is also supported
(`ws:<port>`).

**Critical**: the thread must be attached with `observeWasm: true`
(`allowUnobservedWasm=false`) **before any wasm module loads**. SpiderMonkey
only baseline-compiles a module with debug support if the debugger is already
active at instantiation time; wasm loaded before attachment is not debuggable.

### Firefox-side RDP surface

Most of what the GDB server needs is already exposed by existing RDP actors. We
add as little as possible:

| Need | RDP source |
|------|-----------|
| wasm binary | Source actor `source` request returns `text/wasm` content |
| Breakpoints | Thread/source/breakpoint actors; wasm offset as location `column` (`columnBase=0`) |
| Stack frames | `threadFront.getFrames` returns interleaved `wasmcall`/`call` frames |
| Locals | Existing environment actor (`frame.js:109` `getEnvironment`), function env bindings |
| Globals | Same environment actor, enclosing module environment bindings |
| Linear memory reads | Likely needs a small new RDP method; spike during M4 |

The environment actor enumerates bindings via `this.obj.names()`/`getVariable()`
(`environment.js:137`); the Node server converts the value grip to little-endian
bytes for LLDB.

## Protocol mapping

LLDB's wasm client (in `lldb/source/Plugins/Process/wasm/`) talks to our GDB
server. The minimal packet set is documented by the reference mock in
`llvm-project/lldb/test/API/functionalities/gdb_remote_client/TestWasm.py` and
the spec in `lldb/docs/resources/lldbgdbremote.md` (§ Wasm Packets).

### Address encoding (`wasm_addr_t`)

All wasm addresses are 64-bit little-endian:

```
type[63:62] | module_id[61:32] | offset[31:0]
```

| type | Meaning |
|------|---------|
| 0x00 | Linear memory |
| 0x01 | Object (code/data section) |

Each loaded module is assigned an ID; its code section is mapped at
`(module_id << 32)`.

### Required GDB server packets

| Packet | Response | RDP source |
|--------|----------|-----------|
| `qSupported` | Advertise `qXfer:libraries:read+`, `qWasmCallStack+`, `qWasmLocal+`, `qWasmGlobal+`, `swbreak+`, etc. | — |
| `qProcessInfo` | `triple:wasm32-unknown-unknown-wasm;ptrsize:4` | — |
| `qRegisterInfo0` | Single 64-bit `pc` register | — |
| `qfThreadInfo` | Thread list | RDP thread actors |
| Stop reply `T05` | `thread:<tid>;threads:<list>;` + expedited `pc` | RDP paused event |
| `qXfer:libraries:read` | `<library-list>` with `wasm_addr_t` load addresses | `threadFront.getSources` |
| `m`/`x` (Object addr) | Module bytes | Source actor `source` request |
| `m`/`x` (Memory addr) | Linear memory range | New RDP method (M4) |
| `Z0`/`z0` | Breakpoint set/remove | RDP breakpoint actor; wasm offset as `column` |
| `vCont;c` / `vCont;s` | Continue / step | `threadFront.resume` / `.resume({type:"step"})` |
| `interrupt` | Halt | `threadFront.interrupt` |
| `qWasmCallStack` | Hex LE array of 64-bit PCs | `threadFront.getFrames` (`wasmcall` frames) |
| `qWasmLocal:<frame>;<idx>` | LE bytes | Environment actor, function env |
| `qWasmGlobal:<frame>;<idx>` | LE bytes | Environment actor, module env |
| `qWasmStackValue` | LE bytes | **Not available** (M5, see below) |

**Breakpoint PC round-trip**: the RDP stop offset can differ by a few bytes from
the `Z0` address because `setBreakpoint` snaps to the nearest valid position.
Map the stop offset back to the nearest `Z0` address so LLDB classifies the stop
as a breakpoint hit.

**Interleaved JS/wasm stacks**: `threadFront.getFrames` returns `wasmcall` and
`call` frames interleaved on a single chain. For `qWasmCallStack` we emit only
wasm PCs, inserting a synthetic `[host]` sentinel module for JS gaps between
wasm regions so LLDB sees a contiguous-looking wasm stack (tier 2 of 3;
tier 3 would synthesize DWARF per JS script).

## Milestones

**M1 — platform server**: implement the platform packet set
(`lldb/docs/resources/lldbplatformpackets.md`). Launch headless Firefox, model
tabs as processes, HTTP server as filesystem, `qLaunchGDBServer`/
`qQueryGDBServer` to spawn per-tab GDB servers. Validation: run LLDB's platform
testsuite (`lldbsuite/test/tools/lldb-server/`) against our server.

**M2 — GDB server, stack only**: module loading (`qXfer:libraries:read`), wasm
call stack (`qWasmCallStack`), PC-to-source resolved by LLDB via DWARF embedded
in the wasm binary. No locals yet. Reachable via M1 or directly via
`connect://`.

**M3 — breakpoints and stepping**: `Z0`/`z0`, `vCont;c`/`vCont;s`/interrupt
over the RDP breakpoint and thread actors.

**M4 — locals, globals, memory**: `qWasmLocal`/`qWasmGlobal` via the existing
environment actor (grip-to-LE-bytes in the Node server). Spike whether existing
actors cover linear-memory reads before adding a new RDP method.

**M5 (deferred) — operand stack**: `qWasmStackValue` requires SpiderMonkey to
expose the wasm value stack through the Debugger API, which it does not yet do.
A SpiderMonkey + RDP extension is in scope if needed. Get as far as possible
without it.

## Testing

Primary strategy: run LLDB's own test suites against our server rather than
writing our own.

- **Platform conformance** (drives M1): `lldbsuite/test/tools/lldb-server/`
  (`lldbgdbserverutils.py`, `gdbremote_testcase.py`).
- **GDB/wasm client semantics**: `lldbsuite/test/gdbclientutils.py` +
  `lldbgdbclient.py` mock-responder framework; reference is `TestWasm.py`.

## Key sources

### LLDB (in `./llvm-project`)

- `lldb/docs/resources/lldbgdbremote.md` — full RSP extension reference including
  § Wasm Packets
- `lldb/docs/resources/lldbplatformpackets.md` — platform packet list
- `lldb/source/Plugins/Process/wasm/` — `ProcessWasm`, `ThreadWasm`,
  `UnwindWasm`, `RegisterContextWasm`
- `lldb/source/Plugins/ObjectFile/wasm/ObjectFileWasm.cpp` — `wasm_addr_t`
  layout, section loading
- `lldb/source/Plugins/Platform/WebAssembly/PlatformWasm.cpp`
- `lldb/tools/lldb-server/lldb-platform.cpp` — platform server entry point
- `lldb/source/Plugins/Process/gdb-remote/GDBRemoteCommunicationServerPlatform.cpp`
- `lldb/test/API/functionalities/gdb_remote_client/TestWasm.py` — reference mock

### Firefox RDP (in `./firefox`)

- `devtools/docs/contributor/backend/protocol.md` — RDP spec
- `devtools/shared/transport/packets.js` — length-prefixed framing
- `devtools/startup/DevToolsStartup.sys.mjs` — `--start-debugger-server` flag
- `devtools/server/actors/thread.js` — `observeWasm`, frame walking
- `devtools/server/actors/source.js` — wasm binary, `columnBase=0` convention
- `devtools/server/actors/frame.js:109` — `getEnvironment`, not gated on `wasmcall`
- `devtools/server/actors/environment.js:137` — binding enumeration

### Prior attempt

`~/src/firefox/gdb-wasm/devtools/server/gdb-wasm-stub/` — an earlier
embedded-in-devtools approach that never fully worked but solved several
non-obvious problems:

- `gdb-wasm-stub.js` — hand-written RSP state machine (reference and fallback if
  the gdbstub-component proves awkward); all-stop multi-thread, `[host]`
  sentinel, breakpoint PC fixup
- `rdp-backend.js` — RDP glue with a custom `wasmInspect` actor; reference for
  what locals/globals/memory reads look like over RDP
- `wasm-addr.js` — `wasm_addr_t` codec
- `protocol-reference.md` — validated LLDB-side packet spec

## Open questions

1. **Operand stack (M5)**: when and whether to add SpiderMonkey Debugger API +
   RDP support for `qWasmStackValue`.

2. **Linear memory reads (M4)**: do existing RDP actors expose
   `WebAssembly.Memory` range reads, or does a small new method need to be
   added?

3. **`observeWasm` timing**: how to reliably attach the thread before any wasm
   loads when using the platform layer (tab-creation / navigation-start hook).

4. **JS/wasm stacks, tier 3**: eventually synthesize DWARF per JS script so
   `call` frames show source; start with the `[host]` sentinel (tier 2).

## Known limitations

- No multithreading initially (gdbstub-component does not support it).
- Wasm operand stack not inspectable until SpiderMonkey/RDP extension lands (M5).
