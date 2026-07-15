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
