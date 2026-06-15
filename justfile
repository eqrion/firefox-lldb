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

# Transpile the built component to JS via jco (regenerates src/gdb/generated/)
component-transpile:
    npx jco transpile \
        vendor/gdbstub-component/target/wasm32-wasip2/release/firefox_lldb_gdbstub_component.wasm \
        -o src/gdb/generated --name gdbstub --instantiation async

# Rebuild and re-transpile the vendored component in one step.
# Uses the JSPI transpile: jco's non-JSPI resource glue has a codegen bug
# (undefined `currentSubtask`) that breaks resource round-trips.
component: component-build component-transpile-jspi

# Run the worker-architecture prototype (component on a Worker, debuggee bridged
# to the main thread over a synchronous SharedArrayBuffer RPC). Proves async
# resumption + reads with the main event loop free. Requires Node >=24.
proto-worker:
    node --experimental-wasm-jspi --import tsx src/gdb/worker/proto-host.mjs

# Transpile with JSPI so the RDP-backed debuggee methods can be async.
# The generated module must run under Node >=24 with --experimental-wasm-jspi.
# Validated: an async frame.get-locals correctly serves qWasmLocal.
iface := "bytecodealliance:wasmtime/debuggee@44.0.0"
export := "bytecodealliance:wasmtime/debugger@44.0.0"
component-transpile-jspi:
    npx jco transpile \
        vendor/gdbstub-component/target/wasm32-wasip2/release/firefox_lldb_gdbstub_component.wasm \
        -o src/gdb/generated --name gdbstub --instantiation async --async-mode jspi \
        --async-exports "{{export}}#debug" \
        --async-imports \
            "{{iface}}#[method]debuggee.all-modules" \
            "{{iface}}#[method]debuggee.all-instances" \
            "{{iface}}#[method]debuggee.exit-frames" \
            "{{iface}}#[method]debuggee.continue" \
            "{{iface}}#[method]debuggee.single-step" \
            "{{iface}}#[static]event-future.finish" \
            "{{iface}}#[method]frame.get-instance" \
            "{{iface}}#[method]frame.get-func-index" \
            "{{iface}}#[method]frame.get-pc" \
            "{{iface}}#[method]frame.get-locals" \
            "{{iface}}#[method]frame.get-stack" \
            "{{iface}}#[method]frame.parent-frame" \
            "{{iface}}#[method]instance.get-module" \
            "{{iface}}#[method]instance.get-memory" \
            "{{iface}}#[method]instance.get-global" \
            "{{iface}}#[method]module.bytecode" \
            "{{iface}}#[method]module.add-breakpoint" \
            "{{iface}}#[method]module.remove-breakpoint" \
            "{{iface}}#[method]memory.get-bytes" \
            "{{iface}}#[method]memory.set-bytes" \
            "{{iface}}#[method]memory.size-bytes" \
            "{{iface}}#[method]global.get" \
            "{{iface}}#[method]global.set"
