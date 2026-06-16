emsdk := "/Users/ryanhunt/src/emsdk"
emcc  := emsdk / "upstream/emscripten/emcc"

# Install dependencies
install:
    npm install

# Launch a fresh Firefox and start the platform server on PORT.
# LLDB connects with:
#   (lldb) platform select remote-gdb-server
#   (lldb) platform connect connect://localhost:<PORT>
#   (lldb) platform process launch -- <url>
launch PORT="1234" RDP_PORT="6080" URL="":
    node --import tsx src/cli/firefox-lldb-server.ts --launch \
        --port {{PORT}} --rdp-port {{RDP_PORT}} \
        {{ if URL != "" { "--url " + URL } else { "" } }}

# Connect to an already-running Firefox and start the platform server on PORT.
connect PORT="1234" RDP_PORT="6080" URL="":
    node --import tsx src/cli/firefox-lldb-server.ts --connect \
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

# Build the e2e test fixtures (simple/oop/parser/ledger) with emscripten.
# Requires emsdk at /Users/ryanhunt/src/emsdk.
build-fixtures: _build-simple _build-oop _build-parser _build-ledger

_build-simple:
    cd test/e2e/fixtures/simple && {{emcc}} math.cpp -o math.js \
        -g -O0 \
        -s EXPORTED_RUNTIME_METHODS='["cwrap"]' \
        -s MODULARIZE=1 \
        -s EXPORT_NAME=MathModule

_build-oop:
    cd test/e2e/fixtures/oop && {{emcc}} oop.cpp -o oop.js \
        -g -O0 \
        -s EXPORTED_RUNTIME_METHODS='["cwrap"]' \
        -s MODULARIZE=1 \
        -s EXPORT_NAME=OopModule

_build-parser:
    cd test/e2e/fixtures/parser && {{emcc}} parser.cpp -o parser.js \
        -g -O0 \
        -s EXPORTED_RUNTIME_METHODS='["cwrap"]' \
        -s MODULARIZE=1 \
        -s EXPORT_NAME=ParserModule

_build-ledger:
    cd test/e2e/fixtures/ledger && {{emcc}} ledger.cpp -o ledger.js \
        -g -O0 \
        -s EXPORTED_RUNTIME_METHODS='["cwrap"]' \
        -s MODULARIZE=1 \
        -s EXPORT_NAME=LedgerModule

# Run the lldb API bridge suite against headless Firefox. Needs:
#   - wasm-plugin lldb at LLVM/build/bin/lldb (defaults to ../llvm-project)
#   - fixtures built: just build-fixtures
test-lldb LLVM="../llvm-project":
    LLDB={{LLVM}}/build/bin/lldb \
        python3 test/e2e/run.py

# Full-pipeline integration test: live Firefox (RDP) -> RdpDebuggee -> gdbstub
# component -> raw GDB client. Needs a Firefox on RDP_PORT and the simple wasm
# page served (see test/e2e/fixtures/simple/).
integration RDP_PORT="6080":
    node --import tsx test/e2e/integration.ts {{RDP_PORT}}
