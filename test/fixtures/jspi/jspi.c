// JSPI fixture: exercises JavaScript Promise Integration. A C function calls an
// async JS import (resolves via setTimeout) so the wasm stack suspends and
// resumes mid-function. Tests check whether breakpoints and locals survive the
// suspend/resume cycle.

#include <emscripten.h>
#include <stdint.h>

// Async JS import: suspends the wasm stack until the promise resolves.
EM_ASYNC_JS(void, js_delay, (int32_t ms), {
  await new Promise(function(resolve) { setTimeout(resolve, ms); });
});

// Named breakpoint targets so the harness can stop here reliably.
static __attribute__((noinline)) void before_suspend(int32_t value) {
  (void)value;
}

static __attribute__((noinline)) void after_suspend(int32_t value) {
  (void)value;
}

EMSCRIPTEN_KEEPALIVE
int32_t run_async(int32_t value) {
  before_suspend(value);
  js_delay(10);
  after_suspend(value);
  return value + 1;
}
