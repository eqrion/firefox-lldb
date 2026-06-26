#include <emscripten.h>
#include <cstdint>

static int32_t factorial(int32_t n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
}

static int32_t fib(int32_t n) {
    if (n <= 1) return n;
    int32_t a = 0, b = 1;
    for (int32_t i = 2; i <= n; i++) {
        int32_t c = a + b;
        a = b;
        b = c;
    }
    return b;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t compute_factorial(int32_t n) {
    return factorial(n);
}

EMSCRIPTEN_KEEPALIVE
int32_t compute_fib(int32_t n) {
    return fib(n);
}

EMSCRIPTEN_KEEPALIVE
int32_t sum_range(int32_t lo, int32_t hi) {
    int32_t total = 0;
    for (int32_t i = lo; i <= hi; i++) {
        total += i;
    }
    return total;
}

}
