# firefox-lldb developer commands

# Install dependencies
install:
    npm install

# Type-check without emitting
typecheck:
    npm run typecheck

# Format source files with Prettier
format:
    npm run format

# Run typecheck + Prettier check
check:
    npm run check

# Build to dist/
build:
    npm run build

# Run the unit test suite
test:
    npm test

# Launch a fresh Firefox and start the platform server on PORT.
# LLDB connects with:
#   (lldb) platform select remote-gdb-server
#   (lldb) platform connect connect://localhost:<PORT>
#   (lldb) platform process launch -- <url>
launch PORT="1234" RDP_PORT="6080" URL="":
    node --import tsx src/cli/firefox-lldb.ts --launch \
        --port {{PORT}} --rdp-port {{RDP_PORT}} \
        {{ if URL != "" { "--url " + URL } else { "" } }}

# Connect to an already-running Firefox and start the platform server on PORT.
connect PORT="1234" RDP_PORT="6080" URL="":
    node --import tsx src/cli/firefox-lldb.ts --connect \
        --port {{PORT}} --rdp-port {{RDP_PORT}} \
        {{ if URL != "" { "--url " + URL } else { "" } }}

# Build the vendored gdbstub component to a wasm32-wasip2 component
component-build:
    cd vendor/gdbstub-component && cargo build --release --target wasm32-wasip2

# Transpile the built component to JS via jco, then apply the post-transpile
# patch (jco 1.24 codegen bug — see scripts/patch-generated.mjs). The component
# runs in a worker and blocks synchronously on the SAB RPC, so the debuggee
# imports are synchronous; the generated module runs on plain Node.
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

# Run the lldb API bridge suite against the deterministic Fake backend (fast,
# no browser). LLVM defaults to the sibling llvm-project checkout.
test-lldb LLVM="../llvm-project":
    FIREFOX_LLDB_LLDB={{LLVM}}/build/bin/lldb \
        python3 test/lldb/run_bridge_tests.py

# Same suite, additionally against real headless Firefox (needs the example
# fixtures built: cd ../examples && just build-fixtures).
test-lldb-live LLVM="../llvm-project":
    FIREFOX_LLDB_LIVE=1 FIREFOX_LLDB_LLDB={{LLVM}}/build/bin/lldb \
        python3 test/lldb/run_bridge_tests.py

# Full-pipeline integration test: live Firefox (RDP) -> RdpDebuggee -> gdbstub
# component -> raw GDB client. Needs a Firefox on RDP_PORT and the simple wasm
# page served (see examples/).
integration RDP_PORT="6080":
    node --import tsx src/gdb/rdp-integration.ts {{RDP_PORT}}
