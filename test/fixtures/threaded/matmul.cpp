#include <emscripten.h>
#include <emscripten/threading.h>
#include <pthread.h>
#include <cstdint>
#include <cstdlib>
#include <cstring>

static const int N = 64;

static float A[N][N];
static float B[N][N];
static float C[N][N];

static pthread_mutex_t result_mutex = PTHREAD_MUTEX_INITIALIZER;
static float dot_product_sum = 0.0f;

struct RowRange {
    int start;
    int end;
};

static const int MAX_PROBE_WORKERS = 8;

struct ProbeTask {
    int id;
    int count;
    int value;
};

static volatile uint32_t probe_gates[MAX_PROBE_WORKERS];
static int probe_results[MAX_PROBE_WORKERS];
static int probe_completed = 0;

// An intentionally simple, inspectable worker frame. Probe workers are released
// one at a time, so each breakpoint stop has a deterministic id/value while the
// remaining workers are blocked in futex waits and must participate in all-stop.
extern "C" EMSCRIPTEN_KEEPALIVE __attribute__((noinline))
void* worker_probe_checkpoint(void* arg) {
    ProbeTask* task = static_cast<ProbeTask*>(arg);
    volatile int observed = task->value;
    probe_results[task->id] = observed + task->id;
    return arg;
}

extern "C" EMSCRIPTEN_KEEPALIVE __attribute__((noinline))
void* worker_probe_finished(void* arg) {
    ProbeTask* task = static_cast<ProbeTask*>(arg);
    probe_results[task->id] += 0;
    return arg;
}

extern "C" EMSCRIPTEN_KEEPALIVE __attribute__((noinline))
void matmul_join_complete() {
    volatile int observed = probe_completed;
    (void)observed;
}

static void release_probe_gate(int id) {
    __atomic_store_n(&probe_gates[id], 1, __ATOMIC_SEQ_CST);
    emscripten_futex_wake(&probe_gates[id], 1);
}

static void* probe_worker(void* arg) {
    ProbeTask* task = static_cast<ProbeTask*>(arg);
    while (__atomic_load_n(&probe_gates[task->id], __ATOMIC_SEQ_CST) == 0) {
        emscripten_futex_wait(&probe_gates[task->id], 0, 1000);
    }

    worker_probe_checkpoint(task);
    worker_probe_finished(task);
    __atomic_add_fetch(&probe_completed, 1, __ATOMIC_SEQ_CST);

    // Releasing the next gate only after returning from the checkpoint makes
    // stop/resume ordering deterministic without relying on browser timers.
    if (task->id + 1 < task->count) {
        release_probe_gate(task->id + 1);
    }
    delete task;
    return nullptr;
}

static void* multiply_rows(void* arg) {
    RowRange* range = static_cast<RowRange*>(arg);
    for (int i = range->start; i < range->end; i++) {
        for (int j = 0; j < N; j++) {
            float sum = 0.0f;
            for (int k = 0; k < N; k++) {
                sum += A[i][k] * B[k][j];
            }
            C[i][j] = sum;
        }
    }
    return nullptr;
}

static void* multiply_rows_unjoined(void* arg) {
    multiply_rows(arg);
    delete static_cast<RowRange*>(arg);
    return nullptr;
}

struct DotArg {
    int row_a;
    int row_b;
    float result;
};

static void* compute_dot(void* arg) {
    DotArg* d = static_cast<DotArg*>(arg);
    float sum = 0.0f;
    for (int k = 0; k < N; k++) {
        sum += A[d->row_a][k] * A[d->row_b][k];
    }
    d->result = sum;

    pthread_mutex_lock(&result_mutex);
    dot_product_sum += sum;
    pthread_mutex_unlock(&result_mutex);

    return nullptr;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
void init_matrices() {
    for (int i = 0; i < N; i++) {
        for (int j = 0; j < N; j++) {
            A[i][j] = static_cast<float>(i + j + 1) / N;
            B[i][j] = static_cast<float>(i * j + 1) / N;
            C[i][j] = 0.0f;
        }
    }
}

EMSCRIPTEN_KEEPALIVE
void matmul_threaded(int nthreads) {
    pthread_t* threads = new pthread_t[nthreads];
    RowRange* ranges   = new RowRange[nthreads];

    int rows_per_thread = N / nthreads;
    for (int t = 0; t < nthreads; t++) {
        ranges[t].start = t * rows_per_thread;
        ranges[t].end   = (t == nthreads - 1) ? N : ranges[t].start + rows_per_thread;
        pthread_create(&threads[t], nullptr, multiply_rows, &ranges[t]);
    }
    for (int t = 0; t < nthreads; t++) {
        pthread_join(threads[t], nullptr);
    }

    delete[] threads;
    delete[] ranges;
    matmul_join_complete();
}

EMSCRIPTEN_KEEPALIVE
void start_multiply_worker() {
    // Keep the argument alive until the worker has consumed it. This
    // deliberately returns without joining so the browser's main thread stays
    // available to forward the worker's RDP breakpoint packet.
    RowRange* range = new RowRange{0, N};
    pthread_t thread;
    pthread_create(&thread, nullptr, multiply_rows_unjoined, range);
}

EMSCRIPTEN_KEEPALIVE
void start_probe_workers(int count, int release_first) {
    if (count < 1) count = 1;
    if (count > MAX_PROBE_WORKERS) count = MAX_PROBE_WORKERS;

    __atomic_store_n(&probe_completed, 0, __ATOMIC_SEQ_CST);
    for (int i = 0; i < count; i++) {
        __atomic_store_n(&probe_gates[i], 0, __ATOMIC_SEQ_CST);
        probe_results[i] = -1;
    }
    // Open worker 0 before pthread_create so the first checkpoint does not
    // depend on a futex wake. Later workers are deliberately released from a
    // previous worker after it resumes from its breakpoint.
    if (release_first) __atomic_store_n(&probe_gates[0], 1, __ATOMIC_SEQ_CST);

    for (int i = 0; i < count; i++) {
        ProbeTask* task = new ProbeTask{i, count, 1000 + i * 111};
        pthread_t thread;
        if (pthread_create(&thread, nullptr, probe_worker, task) != 0) {
            delete task;
        }
    }

}

static volatile uint32_t interrupt_spin_gate = 0;
static volatile uint64_t interrupt_spin_iterations = 0;

// Keep one pthread executing wasm while its peers are parked in futex waits.
// Firefox exposes no frames for an Atomics.wait worker, so this gives Ctrl-C's
// all-stop a real worker stack to select from among the empty pool threads.
EMSCRIPTEN_KEEPALIVE __attribute__((noinline))
void* interrupt_spin_worker(void*) {
    uint64_t iterations = 0;
    while (__atomic_load_n(&interrupt_spin_gate, __ATOMIC_SEQ_CST) == 0) {
        iterations = iterations * 1664525u + 1013904223u;
        __atomic_store_n(&interrupt_spin_iterations, iterations, __ATOMIC_RELAXED);
    }
    return nullptr;
}

EMSCRIPTEN_KEEPALIVE
void start_interrupt_workers(int blocked_count) {
    __atomic_store_n(&interrupt_spin_gate, 0, __ATOMIC_SEQ_CST);
    __atomic_store_n(&interrupt_spin_iterations, 0, __ATOMIC_RELAXED);

    pthread_t spinner;
    pthread_create(&spinner, nullptr, interrupt_spin_worker, nullptr);
    start_probe_workers(blocked_count, 0);
}

EMSCRIPTEN_KEEPALIVE
int interrupt_spin_started() {
    return __atomic_load_n(&interrupt_spin_iterations, __ATOMIC_RELAXED) != 0;
}

EMSCRIPTEN_KEEPALIVE
int get_probe_completed() {
    return __atomic_load_n(&probe_completed, __ATOMIC_SEQ_CST);
}

EMSCRIPTEN_KEEPALIVE
int get_probe_result(int id) {
    if (id < 0 || id >= MAX_PROBE_WORKERS) return -1;
    return probe_results[id];
}

EMSCRIPTEN_KEEPALIVE
float get_result(int row, int col) {
    return C[row][col];
}

EMSCRIPTEN_KEEPALIVE
float dot_rows_threaded(int nthreads) {
    pthread_t* threads = new pthread_t[nthreads];
    DotArg*    args    = new DotArg[nthreads];

    dot_product_sum = 0.0f;
    for (int t = 0; t < nthreads; t++) {
        args[t].row_a  = t % N;
        args[t].row_b  = (t + 1) % N;
        args[t].result = 0.0f;
        pthread_create(&threads[t], nullptr, compute_dot, &args[t]);
    }
    for (int t = 0; t < nthreads; t++) {
        pthread_join(threads[t], nullptr);
    }

    float total = dot_product_sum;
    delete[] threads;
    delete[] args;
    return total;
}

}
