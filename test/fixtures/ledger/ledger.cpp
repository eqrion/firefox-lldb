// Small stateful example: apply a list of transfers across accounts and verify
// the total balance is conserved. Exercises struct/array access and a few
// cooperating functions (a more "real world" shape than a single function).

#include <emscripten.h>
#include <cstdint>

struct Account {
    int32_t balance;
};

struct Transaction {
    int32_t from;
    int32_t to;
    int32_t amount;
};

static Account g_accounts[3];

static void apply_transaction(const Transaction* txn) {
    g_accounts[txn->from].balance -= txn->amount;
    g_accounts[txn->to].balance += txn->amount;
}

static int32_t total_balance() {
    int32_t total = 0;
    for (int i = 0; i < 3; i++) {
        total += g_accounts[i].balance;
    }
    return total;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t run_ledger() {
    g_accounts[0].balance = 100;
    g_accounts[1].balance = 50;
    g_accounts[2].balance = 0;
    Transaction txns[2] = {{0, 1, 30}, {1, 2, 20}};
    for (int i = 0; i < 2; i++) {
        apply_transaction(&txns[i]);
    }
    return total_balance(); // conserved: 100 + 50 + 0 = 150
}

}
