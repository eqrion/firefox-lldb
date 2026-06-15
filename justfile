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

# Rebuild and re-transpile the vendored component in one step
component: component-build component-transpile
