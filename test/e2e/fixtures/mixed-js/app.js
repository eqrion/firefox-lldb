// Application-level JS: orchestrates wasm calls.
// This file is intentionally separate from math.js (emscripten glue)
// so that breakpoints in application code can be distinguished from
// breakpoints in the generated wasm wrapper.

let computeFactorial = null;
let computeFib = null;
let initialized = false;

function processNumbers(numbers) {
    const results = [];
    for (let i = 0; i < numbers.length; i++) {
        const n = numbers[i];
        const factResult = computeFactorial(n);
        const fibResult = computeFib(n);
        results.push({ n, factResult, fibResult });
    }
    return results;
}

function runBatch() {
    const inputs = [5, 6, 7, 8];
    const batchResults = processNumbers(inputs);
    let factSum = 0;
    let fibSum = 0;
    for (const r of batchResults) {
        factSum += r.factResult;
        fibSum += r.fibResult;
    }
    return { factSum, fibSum, count: inputs.length };
}

function renderResult(res) {
    const el = document.getElementById("result");
    el.textContent = `factSum=${res.factSum} fibSum=${res.fibSum} count=${res.count}`;
}

MathModule().then(mod => {
    computeFactorial = mod.cwrap("compute_factorial", "number", ["number"]);
    computeFib = mod.cwrap("compute_fib", "number", ["number"]);
    initialized = true;
});

function runApp() {
    if (!initialized) {
        document.getElementById("result").textContent = "not ready";
        return;
    }
    const res = runBatch();
    renderResult(res);
}
