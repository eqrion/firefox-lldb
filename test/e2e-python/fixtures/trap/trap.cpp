// Trap fixture: causes a variety of wasm traps. Tests check how the debugger
// surfaces an unexpected wasm stop and whether the trapping frame is
// inspectable (to figure out *why* it trapped).

#include <emscripten.h>
#include <cstdint>

static int32_t divide(int32_t a, int32_t b) {
    return a / b;  // i32.div_s -> integer divide-by-zero trap
}

static int32_t deref(int32_t* p) {
    return *p;  // load far past linear memory -> out-of-bounds trap
}

typedef int32_t (*BinFn)(int32_t, int32_t);

static int32_t one_arg(int32_t a) {
    return a + 1;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t run_divzero() {
    volatile int32_t zero = 0;
    return divide(1, zero);
}

EMSCRIPTEN_KEEPALIVE
int32_t run_unreachable() {
    __builtin_trap();  // emits the `unreachable` instruction
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int32_t run_oob() {
    return deref((int32_t*)0x7ffffff0);
}

EMSCRIPTEN_KEEPALIVE
int32_t run_indirect() {
    // Call a 1-arg function through a 2-arg pointer: the call_indirect type
    // check fails at runtime -> signature-mismatch trap. volatile defeats
    // devirtualization so emcc keeps the indirect call.
    volatile BinFn fn = reinterpret_cast<BinFn>(&one_arg);
    return fn(1, 2);
}

}
