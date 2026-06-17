#include <emscripten.h>
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
