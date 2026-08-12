#include <emscripten.h>
#include <cstdint>

static int32_t factorial(int32_t n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t compute_factorial(int32_t n) {
    return factorial(n);
}

}

// JavaScript calls the second MathModule instance while the first remains on
// the stack, yielding a real Wasm-A -> JavaScript -> Wasm-B activation chain.
EM_JS(int32_t, call_other_factorial_js, (int32_t n), {
    return globalThis.factorialBForDebugger(n);
});

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t call_other_factorial(int32_t n) {
    return call_other_factorial_js(n - 1);
}

EMSCRIPTEN_KEEPALIVE
int32_t call_other_then_adjust(int32_t n) {
    int32_t result = call_other_factorial_js(n - 1);
    return result + n;
}

}
