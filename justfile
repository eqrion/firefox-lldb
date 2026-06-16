# firefox-lldb developer commands

# Install dependencies
install:
    npm install

# Type-check without emitting
typecheck:
    npm run typecheck

# Build to dist/
build:
    npm run build

# Run the unit test suite
test:
    npm test

# Start the platform server (PORT defaults to 1234)
platform PORT="1234":
    npx tsx src/cli/platform.ts --port {{PORT}}

# Build the vendored gdbstub component to a wasm32-wasip2 component
component-build:
    cd vendor/gdbstub-component && cargo build --release --target wasm32-wasip2

# Transpile the built component to JS via jco, then apply the post-transpile
# patch (jco 1.24 codegen bug — see scripts/patch-generated.mjs). The component
# runs in a worker and blocks synchronously on the SAB RPC, so the debuggee
# imports are synchronous (no JSPI / Node >=24 needed); the generated module
# runs on plain Node.
component-transpile:
    npx jco transpile \
        vendor/gdbstub-component/target/wasm32-wasip2/release/firefox_lldb_gdbstub_component.wasm \
        -o src/gdb/generated --name gdbstub --instantiation async
    node scripts/patch-generated.mjs

# Rebuild and re-transpile (+patch) the vendored component in one step.
component: component-build component-transpile

# Run the worker-architecture prototype (component on a Worker, debuggee bridged
# to the main thread over a synchronous SharedArrayBuffer RPC).
proto-worker:
    node --import tsx src/gdb/worker/proto-host.mjs

# Run the wasm debugging bridge: connect to Firefox (RDP) and serve the gdbstub
# component for LLDB on PORT. Needs a Firefox started with
# --start-debugger-server RDP_PORT.
bridge PORT="8123" RDP_PORT="6080":
    node --import tsx src/cli/wasm-debug.ts --port {{PORT}} --rdp-port {{RDP_PORT}}

# Run a self-contained live bridge for one example dir (launches headless
# Firefox, serves the page, serves the gdbstub component for lldb on PORT).
#   just live ../examples/oop "run()"
live PAGE_DIR FIRE="run()" PORT="8123" RDP_PORT="6080":
    node --import tsx src/cli/live-wasm-server.ts \
        --page-dir {{PAGE_DIR}} --fire "{{FIRE}}" --port {{PORT}} --rdp-port {{RDP_PORT}}

# Run the lldb API bridge suite against the deterministic Fake backend (fast,
# no browser). LLVM defaults to the sibling llvm-project checkout.
test-lldb LLVM="../llvm-project":
    {{LLVM}}/build/bin/lldb-dotest -p TestRdpBridge.py \
        {{LLVM}}/lldb/test/API/functionalities/gdb_remote_client/

# Same suite, additionally against real headless Firefox (needs the example
# fixtures built: cd ../examples && just build-fixtures).
test-lldb-live LLVM="../llvm-project":
    FIREFOX_LLDB_LIVE=1 {{LLVM}}/build/bin/lldb-dotest -p TestRdpBridge.py \
        {{LLVM}}/lldb/test/API/functionalities/gdb_remote_client/

# Full-pipeline integration test: live Firefox (RDP) -> RdpDebuggee -> gdbstub
# component -> raw GDB client. Needs a Firefox on RDP_PORT and the simple wasm
# page served (see examples/).
integration RDP_PORT="6080":
    node --import tsx src/gdb/rdp-integration.ts {{RDP_PORT}}
