# firefox-lldb

Source-level debugging for WebAssembly running in your browser.

`firefox-lldb` gives you a real LLDB prompt attached to a WebAssembly module
executing inside a live Firefox tab. Set breakpoints by function name or
`file:line`, step through your original C/C++/Rust source, inspect locals,
structs, and globals, and read linear memory, all against the code as it
actually runs in the page.

```
(lldb) breakpoint set -n compute_factorial
(lldb) continue
* thread #1, stop reason = breakpoint 1.1
    frame #0: wasm-0`compute_factorial(n=5) at math.cpp:23
   22     int compute_factorial(int n) {
-> 23       if (n <= 1) return 1;
   24       return n * compute_factorial(n - 1);
(lldb) p n
(int) 5
```

No separate LLDB install is needed: the tool ships LLDB compiled to
WebAssembly and runs it in-process. You just need Node and Firefox.

## Requirements

- Node.js 20 or newer
- Firefox 120 or newer
- A WebAssembly module built with debug info (see [below](#preparing-your-wasm))

## Install

```sh
npm install -g firefox-lldb
```

This puts the `firefox-lldb` command on your `PATH`. (You can also run it
without installing via `npx firefox-lldb`.)

## Getting started

Say your app is served at `http://localhost:8080/index.html` and loads a wasm
module built with debug info. Point `firefox-lldb` at it:

```sh
firefox-lldb --url http://localhost:8080/index.html
```

This launches a fresh Firefox, opens the page, attaches to its wasm module, and
drops you at an `(lldb)` prompt. From there:

```
(lldb) breakpoint set -n compute_factorial   # break on a function
(lldb) continue                              # run until it's hit
(lldb) bt                                     # see the call stack
(lldb) p n                                    # inspect a local
(lldb) step                                   # step to the next source line
(lldb) frame variable                         # list all locals + args
```

That's the whole loop: break, run, inspect, step.

### Attaching by hand

If you don't pass `--url`, Firefox starts on a blank page and the prompt lists
the open tabs instead. Navigate to your page (in the Firefox window that
opened), then attach:

```
(lldb) platform process list   # list open tabs and their PIDs
(lldb) attach --pid 1          # attach to the wasm tab
```

`attach` is a shortcut for `process attach --plugin wasm`; the `--plugin wasm`
part is what makes LLDB understand the wasm address space, and it's filled in
for you.

### Preparing your wasm

Your module needs debug info for source-level debugging to work:

- **Emscripten / C / C++:** compile with `-g` (e.g. `emcc app.cpp -g -O0 -o app.js`).
- **Rust / wasm-pack:** debug builds embed DWARF by default.
- **Source maps only:** if your toolchain emits a source map (a
  `sourceMappingURL`) but no embedded DWARF, `firefox-lldb` synthesizes the
  debug info from the source map automatically at attach time. Nothing extra to
  do; just make sure the `.map` and original sources are reachable.

Unoptimized builds (`-O0`) give the most faithful stepping and variable
inspection; optimized builds may inline or drop locals.

## Working at the prompt

This is a real LLDB prompt, so standard LLDB commands work: `breakpoint`,
`continue`/`c`, `step`/`s`, `next`/`n`, `finish`, `bt`, `frame`,
`frame variable`, `p <var>`, `memory read`/`x`, `thread list`, and so on.

A few conveniences on top of plain LLDB:

- **Command history:** up/down arrows recall previous commands.
- **Repeat:** pressing Enter on an empty line repeats the last command (handy
  for stepping).
- **Interrupt a running target:** press **Ctrl-C** while the program is running
  to stop it where it is. At an empty prompt, press Ctrl-C twice to quit.
- **Quit:** `quit`, `q`, `exit`, or Ctrl-D.

### Inspecting JavaScript (`js`)

The wasm debugger can't see into the surrounding JavaScript, so `firefox-lldb`
adds `js` subcommands that query the live page directly. They run against the
attached tab (and against the stopped frame, when the program is paused):

| Command | What it does |
| --- | --- |
| `js p <expr>` | Evaluate a JavaScript expression and print the result. The expression runs to the end of the line, e.g. `js p document.title` or `js p window.location.href`. |
| `js bt` | Print the JavaScript call stack of the stopped thread. |
| `js frame <n>` | Show JS frame `n` (default `0`) and its locals/arguments, and select it as the context for subsequent `js p`. |
| `help js` | Show the `js` help. |

`js eval` and `js expr` are aliases for `js p`; `js f` is an alias for
`js frame`. If nothing is attached, `js` reports "no attached tab".

### Console output

Messages your page logs to the console (and uncaught errors) stream into the
terminal as they happen, so you can correlate them with where you've stopped.

- `console off` mutes the stream.
- `console on` resumes it.

## What works, what doesn't

| You want to... | Works? | Notes |
| --- | --- | --- |
| Break by function name or `file:line` | ✅ | |
| Step in / over / out, and instruction-step | ✅ | |
| See the call stack with source locations (`bt`) | ✅ | |
| View source while stopped (`source list`) | ✅ | |
| Inspect locals, arguments, and globals (`frame variable`, `p x`) | ✅ | |
| Drill into structs, pointers, and arrays (`p obj`, `p *ptr`) | ✅ | |
| Read linear memory (`memory read`, `x`) | ✅ | Bounded to ~8 KB per read (see below) |
| Debug multithreaded wasm (pthreads / web workers) | ✅ | All threads stop together |
| Evaluate JavaScript in the page (`js p`) | ✅ | Over Firefox's remote protocol |
| Watch live console output | ✅ | |
| Evaluate expressions over variables (`p n + 1`, `expr a > b`) | ✅ | Arithmetic, comparisons, casts, temp vars |
| Call functions from an expression (`expr foo(3)`) | ❌ | Needs a JIT, which wasm targets don't have |

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--url <U>` | — | Page to open and attach to. Omit to start blank and attach by hand. |
| `--connect` | — | Attach to an already-running Firefox instead of launching one. |
| `--headless` | off | Run Firefox without a visible window. |
| `--firefox <path>` | auto-detected | Path to the Firefox binary. |
| `--port <N>` | `1234` | Internal debug server port. |
| `--rdp-port <N>` | `6080` | Firefox remote-debugging port. |
| `-v`, `--verbose` | off | Log protocol/debug output. |
| `-h`, `--help` | — | Show usage. |

## License

Mozilla Public License, v. 2.0 (see [LICENSE](LICENSE)). Portions are vendored
from third parties under their own licenses; see the files under `vendor/`.
