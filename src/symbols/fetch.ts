/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Fetch one bounded symbol/module body. Cancellation covers headers and body. */
export async function fetchBytes(
  url: string,
  options: {
    maxBytes: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    headers?: Record<string, string>;
  }
): Promise<Uint8Array> {
  const abort = new AbortController();
  const cancel = () => abort.abort(options.signal?.reason);
  options.signal?.throwIfAborted();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timeoutMs = options.timeoutMs ?? 10_000;
  const timer = setTimeout(
    () => abort.abort(new Error(`fetch ${url} timed out after ${timeoutMs} ms`)),
    timeoutMs
  );
  try {
    const response = await fetch(url, { signal: abort.signal, headers: options.headers });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const declared = Number(response.headers.get("content-length"));
    if (declared > options.maxBytes)
      throw new Error(`response too large (${declared} > ${options.maxBytes} bytes)`);
    if (!response.body) throw new Error("response has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > options.maxBytes)
          throw new Error(`response too large (more than ${options.maxBytes} bytes)`);
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } catch (error) {
    abort.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    // Abort also releases unread bodies on status/length/decode failure.
    abort.abort();
  }
}
