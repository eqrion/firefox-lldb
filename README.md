# firefox-wasm-debugger

_Experimental prototype: not an official product, nor fully working yet!_

Language-generic source-level debugging for WebAssembly running in Firefox.

`firefox-wasm-debugger` coordinates isolated `SourceDebuggerComponents` behind
one `(sdb)` session. Modules with DWARF or source maps use a real embedded LLDB;
plain Wasm falls back to an independent WebAssembly-text debugger.

```
(sdb) break compute_factorial
Breakpoint lldb:1: verified
(sdb) continue
stop reason = breakpoint
#0 compute_factorial at math.cpp:23 [lldb]
(sdb) p n
5
```

No separate debugger installation is needed. LLDB is compiled to WebAssembly
and runs inside its component worker; Firefox access is provided through the
portable `WasmDebuggee` host interface.

## Requirements

- Node.js 20 or newer
- Firefox 120 or newer
- A WebAssembly module built with debug info (see [below](#preparing-your-wasm))

## Install

```sh
npm install -g firefox-wasm-debugger
```

## Getting started

Say your app is served at `http://localhost:8080/index.html` and loads a wasm
module built with debug info. Point `firefox-wasm-debugger` at it:

```sh
firefox-wasm-debugger --url http://localhost:8080/index.html
```

This launches a fresh Firefox, opens the page, attaches to its wasm module, and
drops you at an `(sdb)` prompt. From there:

```
(sdb) break compute_factorial # break on a function
(sdb) continue                # run until it is hit
(sdb) bt                      # composed cross-component call stack
(sdb) locals                  # inspect locals and arguments
(sdb) p n                     # evaluate in the selected source frame
(sdb) step                    # step, including component handoffs
```

### Attaching by hand

If you don't pass `--url`, Firefox starts on a blank page. Navigate to your page,
then attach:

Use `attach --pid N` to select a tab. `lldb <command>` remains available as an
explicit LLDB-native escape hatch.

### Experimental source debugger components

The embedded CLI can construct multiple isolated `SourceDebuggerComponents`
over one Firefox tab. Each repeated `--component` assigns matching Wasm module
URLs to a separate wasm LLDB runtime:

```sh
firefox-wasm-debugger --url http://localhost:8080/index.html \
  --component lldb-a=component=a \
  --component lldb-b=component=b
```

`ID=TEXT` means that component owns module URLs containing `TEXT`; use one
`ID=*` route as an optional fallback. Every Wasm module must match exactly one
route. Explicit routes currently instantiate LLDB eagerly so every configured
observer participates in the multi-component barrier, and require `--url` for
automatic multi-component attach. The URL match only constrains
which of these otherwise identical LLDB definitions may claim the module; its
real asynchronous `probeModule()` still has to accept it. Future Dart/.NET/etc.
components can instead be selected directly by unique artifact-driven probe
confidence, without URL routes.

That route-free path is now exercised by the built-in `wasm-text` fallback.
LLDB claims DWARF and source-map modules; a module with neither is assigned to
an independent direct-Wasm debugger which generates a virtual `module.wat`.
It does not use LLDB, gdbstub, RSP, or the LLDB abort sentinel.
It runs in a separate worker and imports its direct Wasm debuggee through the
same generic component-host resource transport used for LLDB's RSP import.

Each installed ecosystem enters through a generic
`SourceDebuggerComponentLoader`. Its lightweight definition is probed before
the debugger engine exists. A shared `SourceDebuggerSessionHost` gives the
resulting isolate a component-scoped `WasmDebuggee`; debugger-engine transports
never cross that host interface. LLDB privately owns its RSP, platform server,
attach shim, and gdbstub stack. The CLI activates and closes all loaders through
`SourceDebuggerSessionRuntime`. Firefox starts and exposes normalized Wasm
metadata before any debugger engine is created. The catalog probes lightweight
installed definitions and instantiates only initial module owners; an e2e proof
verifies that an unsupported installed ecosystem is never instantiated. If a
later stopped module refresh selects another definition, the runtime creates
and attaches that component at the current physical stop before allowing the
next run. The new debugger then joins the normal observer barrier.
The CLI and primary e2e fixture share the same product composition root, so
their installed components and routing policy cannot drift.

At the `(sdb)` prompt, qualify ambiguous commands with the component ID:

```text
(sdb) break lldb-b::compute_factorial
(sdb) continue lldb-b
(sdb) lldb lldb-b::thread list
```

Frame-relative commands such as `locals`, `p`, `step`, `next`, and `finish`
route through the selected frame's component automatically.
`sources` lists virtual and conventional component sources, and `list` shows
source around the selected frame. Generated WAT annotates each Firefox-
breakable instruction with its module byte offset.
`step` can hand off through opaque JavaScript into a Wasm frame owned by a
different component; `finish` can return through the same mixed stack. `next`
suppresses foreign activations, but a real breakpoint owned by the foreign
component preempts the step and exposes the composed cross-component stack.
Each routed component adapter runs in its own outer worker and communicates
with the session through structured-cloned `MessagePort` calls.
An exited or unresponsive component is quarantined without discarding healthy
siblings; the `components` command shows its failure state.

### Preparing your wasm

Rich source-level debugging still needs debug information:

- **Emscripten / C / C++:** compile with `-g` (e.g. `emcc app.cpp -g -O0 -o app.js`).
- **Rust / wasm-pack:** debug builds embed DWARF by default.
- **Source maps only:** if your toolchain emits a source map (a
  `sourceMappingURL`) but no embedded DWARF, `firefox-wasm-debugger` synthesizes the
  debug info from the source map automatically at attach time. Breakpoints and
  source listing should work, but you won't get variable printing or
  evaluation.
- **No source metadata:** the `wasm-text` fallback exposes generated canonical
  WAT, breakpoints on Firefox-breakable instructions, function breakpoints when
  names or exports are present, raw `$localN` values, and instruction step-in.
  The original source formatting and identifiers cannot be recovered.

Unoptimized builds (`-O0`) give the most faithful stepping and variable
inspection. Optimized builds may inline or drop variables.

## TypeScript API

The portable component contract is a supported package export:

```ts
import type {
  SourceDebuggerComponent,
  SourceDebuggerComponentDefinition,
  SourceDebuggerComponentHost,
} from "firefox-wasm-debugger/protocol";
```

The root export adds the session, runtime, ownership, and loader APIs for Node
hosts. Internal Firefox, RDP, LLDB, gdbstub, and worker modules are deliberately
not package exports.

The repository includes a reusable behavioral conformance suite for this
contract. `npm run test:conformance` runs it against both installed real
implementations—isolated LLDB and Wasm-text—through the same target, loaders,
catalog, and `SourceDebuggerSessionRuntime` lifecycle as the CLI.

## Working at the prompt

Generic commands include `components`, `modules`, `sources`, `list`, `threads`,
`bt`, `frame`, `locals`, `p`, `break`, `breakpoints`, `continue`, `step`, `next`,
and `finish`. Use `lldb <command>` when you specifically need LLDB's native
command interpreter.

### Inspecting JavaScript (`js`)

`lldb` is able to list JS sources in backtraces, but has no support for
printing or evaluating JS expressions. A `js` subcommand is added that
queries the live page directly. The command runs against the attached
tab:

| Command        | What it does                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `js p <expr>`  | Evaluate a JavaScript expression and print the result. The expression runs to the end of the line, e.g. `js p document.title` or `js p window.location.href`. |
| `js bt`        | Print the JavaScript call stack of the stopped thread.                                                                                                        |
| `js frame <n>` | Show JS frame `n` (default `0`) and its locals/arguments, and select it as the context for subsequent `js p`.                                                 |
| `help js`      | Show the `js` help.                                                                                                                                           |

`js eval` and `js expr` are aliases for `js p`; `js f` is an alias for
`js frame`. If nothing is attached, `js` reports "no attached tab".

### Console output

Messages your page logs to the console (and uncaught errors) stream into the
terminal as they happen, so you can correlate them with where you've stopped.

- `console off` mutes the stream.
- `console on` resumes it.

## What works, what doesn't

| You want to...                                                   | Works? | Notes                                      |
| ---------------------------------------------------------------- | ------ | ------------------------------------------ |
| Break by function name or `file:line`                            | ✅     |                                            |
| Step in / over / out, and instruction-step                       | ✅     |                                            |
| See the call stack with source locations (`bt`)                  | ✅     |                                            |
| View source while stopped (`source list`)                        | ✅     |                                            |
| Inspect locals, arguments, and globals (`frame variable`, `p x`) | ✅     |                                            |
| Drill into structs, pointers, and arrays (`p obj`, `p *ptr`)     | ✅     |                                            |
| Read linear memory (`memory read`, `x`)                          | ✅     | Bounded to ~8 KB per read (see below)      |
| Debug multithreaded wasm (pthreads / web workers)                | ✅     | All threads stop together                  |
| Evaluate JavaScript in the page (`js p`)                         | ✅     | Over Firefox's remote protocol             |
| Watch live console output                                        | ✅     |                                            |
| Evaluate expressions over variables (`p n + 1`, `expr a > b`)    | ✅     | Arithmetic, comparisons, casts, temp vars  |
| Call functions from an expression (`expr foo(3)`)                | ❌     | Needs a JIT, which wasm targets don't have |

## License

Mozilla Public License, v. 2.0 (see [LICENSE](LICENSE)). Portions are vendored
from third parties under their own licenses; see the files under `vendor/`.
