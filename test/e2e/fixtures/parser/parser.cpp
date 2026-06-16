// Recursive-descent expression evaluator. Exercises a deep, deterministic call
// stack (expr -> term -> factor) over a fixed input, plus recursion.
//
// Grammar:
//   expr   := term (('+' | '-') term)*
//   term   := factor (('*' | '/') factor)*
//   factor := number

#include <emscripten.h>
#include <cstdint>

static const char* g_input;
static int32_t g_pos;

static void skip_spaces() {
    while (g_input[g_pos] == ' ') g_pos++;
}

static int32_t parse_factor() {
    skip_spaces();
    int32_t value = 0;
    while (g_input[g_pos] >= '0' && g_input[g_pos] <= '9') {
        value = value * 10 + (g_input[g_pos] - '0');
        g_pos++;
    }
    return value;
}

static int32_t parse_term() {
    int32_t value = parse_factor();
    for (;;) {
        skip_spaces();
        char c = g_input[g_pos];
        if (c == '*') { g_pos++; value *= parse_factor(); }
        else if (c == '/') { g_pos++; value /= parse_factor(); }
        else break;
    }
    return value;
}

static int32_t parse_expr() {
    int32_t value = parse_term();
    for (;;) {
        skip_spaces();
        char c = g_input[g_pos];
        if (c == '+') { g_pos++; value += parse_term(); }
        else if (c == '-') { g_pos++; value -= parse_term(); }
        else break;
    }
    return value;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t eval_expr() {
    g_input = "2 + 3 * 4";
    g_pos = 0;
    return parse_expr(); // 2 + (3*4) = 14
}

}
