// Trap fixture: causes a wasm integer divide-by-zero trap.
// Tests check how the debugger surfaces an unexpected wasm stop.

#include <emscripten.h>
#include <cstdint>

static int32_t cause_trap(int32_t a, int32_t b) {
    return a / b;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t run_trap() {
    volatile int32_t zero = 0;
    return cause_trap(1, zero);
}

}
