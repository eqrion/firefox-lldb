// Heap-allocation fixture: exercises pointer dereferencing and array element
// access through wasm linear memory.

#include <emscripten.h>
#include <cstdint>
#include <cstdlib>

struct Point {
    float x;
    float y;
};

static int32_t check_heap(Point* pt, int32_t* arr) {
    return (int32_t)pt->x + arr[0];
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t run_heap() {
    Point*   pt  = new Point{1.5f, 2.5f};
    int32_t* arr = new int32_t[5]{10, 20, 30, 40, 50};
    int32_t  result = check_heap(pt, arr);
    delete pt;
    delete[] arr;
    return result;
}

}
