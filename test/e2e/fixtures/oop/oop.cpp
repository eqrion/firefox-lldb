// Object-oriented example: a small Shape hierarchy with virtual dispatch.
// Exercises virtual-method symbolication (a base-pointer call resolving to the
// concrete override) and a multi-frame call stack.

#include <emscripten.h>
#include <cstdint>

struct Shape {
    virtual ~Shape() {}
    virtual int32_t area() const = 0;
};

struct Square : Shape {
    int32_t side;
    Square(int32_t s) : side(s) {}
    int32_t area() const override { return side * side; }
};

struct Rectangle : Shape {
    int32_t width, height;
    Rectangle(int32_t w, int32_t h) : width(w), height(h) {}
    int32_t area() const override { return width * height; }
};

// Virtual dispatch through a base pointer: the call site cannot statically know
// which override runs, so the debugger must resolve the concrete method.
static int32_t shape_area(const Shape* shape) {
    return shape->area();
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t total_area() {
    Square square(3);
    Rectangle rect(4, 5);
    const Shape* shapes[2] = {&square, &rect};
    int32_t total = 0;
    for (int i = 0; i < 2; i++) {
        total += shape_area(shapes[i]);
    }
    return total; // 3*3 + 4*5 = 29
}

}
