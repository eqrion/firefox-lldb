#include <emscripten.h>
#include <emscripten/threading.h>
#include <pthread.h>
#include <cstdint>

static const int MAX_DYNAMIC_TASKS = 16;

struct DynamicTask {
    int id;
    int value;
    int result;
};

static int dynamic_results[MAX_DYNAMIC_TASKS];
static volatile uint32_t dynamic_gate = 0;

// These two frames bracket the useful work on a pthread created after attach.
// Keeping them separate lets the debugger prove that a buffered breakpoint is
// installed on the new worker and that the same worker can resume to a second
// breakpoint without losing its locals.
extern "C" EMSCRIPTEN_KEEPALIVE __attribute__((noinline))
void* dynamic_checkpoint(void* arg) {
    DynamicTask* task = static_cast<DynamicTask*>(arg);
    volatile int observed = task->value;
    task->result = observed + task->id;
    return arg;
}

extern "C" EMSCRIPTEN_KEEPALIVE __attribute__((noinline))
void* dynamic_complete(void* arg) {
    DynamicTask* task = static_cast<DynamicTask*>(arg);
    dynamic_results[task->id] = task->result;
    return arg;
}

static void* dynamic_worker(void* arg) {
    DynamicTask* task = static_cast<DynamicTask*>(arg);
    while (__atomic_load_n(&dynamic_gate, __ATOMIC_SEQ_CST) == 0) {
        emscripten_futex_wait(&dynamic_gate, 0, 1000);
    }
    dynamic_checkpoint(task);
    dynamic_complete(task);
    delete task;
    return nullptr;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
void start_dynamic_worker(int id, int value) {
    if (id < 0 || id >= MAX_DYNAMIC_TASKS) return;
    dynamic_results[id] = -1;
    __atomic_store_n(&dynamic_gate, 0, __ATOMIC_SEQ_CST);

    DynamicTask* task = new DynamicTask{id, value, -1};
    pthread_t thread;
    if (pthread_create(&thread, nullptr, dynamic_worker, task) != 0) {
        delete task;
    }
}

EMSCRIPTEN_KEEPALIVE
void release_dynamic_worker() {
    __atomic_store_n(&dynamic_gate, 1, __ATOMIC_SEQ_CST);
    emscripten_futex_wake(&dynamic_gate, 1);
}

EMSCRIPTEN_KEEPALIVE
int get_dynamic_result(int id) {
    if (id < 0 || id >= MAX_DYNAMIC_TASKS) return -1;
    return dynamic_results[id];
}

}
