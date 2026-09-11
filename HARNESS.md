# Driving a real debug session

The MCP server drives the actual `firefox-lldb` CLI in a pseudo-terminal. It uses
the same embedded LLDB, readline prompt, and Ctrl-C path as an interactive user.
It does not implement a second debugger. Page automation belongs to
`firefox-devtools-mcp`, connected to the same browser over Marionette.

## Start and inspect

Install dependencies and serve a fixture or application over HTTP. The fixtures
must already be compiled; see [development instructions](README.md) and the
[E2E guide](test/e2e/README.md).

The checked-in [.mcp.json](.mcp.json) starts both MCP servers. Call `lldb_launch`
first, with the page URL and optionally `headless: true`. It launches a fresh
Firefox profile, attaches, and returns the initial prompt output. The returned
Marionette port tells the page driver where to connect. The default is 2828;
changing `FIREFOX_LLDB_MARIONETTE_PORT` requires updating the page driver's
`--marionette-port` as well.

Use `lldb_send` for ordinary LLDB commands:

```text
breakpoint set -n compute_factorial
continue
thread backtrace
frame variable
memory read --format x --size 1 --count 16 0x1000
```

To trigger a fixture without page automation, pass `fire: "runFactorial()"` to
`lldb_launch`. The expression runs on the first continue, after breakpoints have
been installed. The REPL also supports `js p <expression>`, `js bt`, and
`js frame <index>` for Firefox-side inspection.

## Running and shutting down

A `continue` can outlive `lldb_send`'s wait. A response without a prompt means
the wait expired, not that execution was cancelled. Use `lldb_interrupt` to send
Ctrl-C through the real terminal, then inspect the stop. Use `lldb_read` to
collect asynchronous output without submitting a command. Always finish with
`lldb_shutdown`; it quits the CLI and joins browser cleanup.

`lldb_send` serializes complete command lines. After a command times out without
a prompt, further commands are rejected as busy until it completes; reads and
interrupts remain available. Completion comes from a private CLI marker, so page
output containing `(lldb)` cannot complete a command. Concurrent interrupts join
one operation. `lldb_read` has an independent cursor and can repeat output already
returned by a command; it does not consume that command's result.

Timeouts are integer milliseconds from 0 through 120000. The command queue is
bounded at 32, commands at 65536 characters, and retained output at 4 Mi characters;
truncated output includes an omission notice. Replacement/shutdown cancels and
joins a pending launch before publishing another CLI. Cleanup failure disables
replacement until the MCP server is restarted, rather than abandoning ownership.
The embedded platform listener uses an ephemeral port; Marionette retains the
explicitly configured port needed by the page driver.

The terminal's direct RDP interrupt path works independently of upstream LLDB's
DAP pause path. Passing the DAP limitation tests does not establish working DAP
pause. See the [compatibility ledger](docs/COMPATIBILITY.md).

## Failure evidence

The CLI keeps an always-on transcript and retains it after failures. Explicit
`--log` retains successful runs too. `FIREFOX_LLDB_LOG_DIR` selects an artifact
directory and also enables a separate Firefox stdout/stderr capture. Error
messages identify the transcript and include a recent tail; preserve the whole
file when investigating a race or hang.

Transcripts can contain page content, console messages, source snippets, and
protocol data. Review them before sharing outside the project. If cleanup
reports surviving processes, identify the exact recorded launch PID, profile,
and port before taking action; a normal Firefox window may be unrelated.

MCP is for manual exploration and reproducing failures. Significant changes
still require a focused automated E2E regression in `test/e2e/`.
