// Large-module fixture: wraps the SQLite3 amalgamation so the debugger must
// handle a realistic, symbol-rich wasm binary (~thousands of functions, multi-MB
// DWARF). Tests check attach time, symbol search latency, and that a deep sqlite
// internal (sqlite3_prepare_v2) is reachable and inspectable.

#include <emscripten.h>
#include <cstring>

extern "C" {
#include "sqlite3.h"
}

static __attribute__((noinline)) int32_t run_query(sqlite3* db) {
  sqlite3_stmt* stmt = nullptr;
  const char* sql = "SELECT 6 * 7";
  int rc = sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr);
  if (rc != SQLITE_OK) return -1;
  int32_t result = 0;
  if (sqlite3_step(stmt) == SQLITE_ROW) {
    result = sqlite3_column_int(stmt, 0);
  }
  sqlite3_finalize(stmt);
  return result;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t run_large() {
  sqlite3* db = nullptr;
  if (sqlite3_open(":memory:", &db) != SQLITE_OK) return -1;
  int32_t result = run_query(db);
  sqlite3_close(db);
  return result;
}

}
