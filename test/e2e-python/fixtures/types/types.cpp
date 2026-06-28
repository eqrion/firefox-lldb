// Type-inspection breadth fixture: integers, floats, pointers, bitfields,
// structs. All values are deterministic so tests can assert exact numbers.

#include <emscripten.h>
#include <cstdint>

struct Point {
    float x;
    float y;
};

struct Packed {
    uint32_t a : 4;
    uint32_t b : 4;
    uint32_t c : 8;
    uint32_t pad : 16;
};

// Tests break here. Declared noinline so LLDB sees it as a separate frame;
// all check_types() locals are guaranteed initialized before this is called.
static __attribute__((noinline)) void stop_here() {}

// Locals are declared before stop_here() is called so they are all live in
// the check_types frame when the breakpoint fires.
static int32_t check_types() {
    int32_t  i  = -42;
    uint32_t u  = 0xDEADBEEFu;
    float    f  = 3.14f;
    double   d  = 2.718281828;
    Point    pt = {1.5f, 2.5f};
    Packed   pk = {3, 5, 255, 0};
    int32_t* p  = &i;
    stop_here();
    return i + (int32_t)u + (int32_t)f + (int32_t)d
         + (int32_t)pt.x + (int32_t)pk.a + *p;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t run_types() {
    return check_types();
}

}
