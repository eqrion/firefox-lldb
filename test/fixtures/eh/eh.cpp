// Exception-handling fixture: exercises C++ try/catch/throw compiled with
// -fwasm-exceptions. Tests check whether the debugger can stop at a throw
// site, break in a catch handler, inspect the caught object, and follow a
// rethrow.

#include <emscripten.h>
#include <cstdint>

struct MyError {
  int32_t code;
  const char* msg;
};

static __attribute__((noinline)) void do_throw() {
  throw MyError{42, "deep error"};
}

static __attribute__((noinline)) void middle() {
  do_throw();
}

// Called from the catch block so we have a named breakpoint target there.
static __attribute__((noinline)) int32_t handle_error(const MyError& e) {
  return e.code;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t run_throw_catch() {
  try {
    middle();
  } catch (const MyError& e) {
    return handle_error(e);
  }
  return 0;
}

EMSCRIPTEN_KEEPALIVE
int32_t run_rethrow() {
  try {
    try {
      middle();
    } catch (const MyError& e) {
      throw;
    }
  } catch (const MyError& e) {
    return handle_error(e);
  }
  return 0;
}

// Throws without catching — the exception escapes to JS as an uncaught error.
EMSCRIPTEN_KEEPALIVE
void run_uncaught() {
  middle();
}

}
