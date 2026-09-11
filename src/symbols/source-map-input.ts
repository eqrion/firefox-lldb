/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from "node:crypto";
import { posix } from "node:path";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
export const MAX_SOURCE_MAP_BYTES = 31 * 1024 * 1024;

export function checkSourceMapSize(bytes: Uint8Array): void {
  if (bytes.length > MAX_SOURCE_MAP_BYTES) throw new Error("source map exceeds 31 MiB limit");
}

function safeRelativePath(path: string): string | null {
  if (!path || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    return null;
  }
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z][A-Za-z+.-]*:\/\//.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) return null;
  const clean = parts.filter((part) => part !== "" && part !== ".").join("/");
  return clean || null;
}

function relocatedPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const name = posix.basename(normalized) || "source";
  const key = createHash("sha256").update(path).digest("hex").slice(0, 12);
  return `_external/${key}/${name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** Rewrite every source name to a safe relative path before it enters DWARF.
 * Source indices and sourcesContent stay aligned, so mappings are unchanged. */
export function sanitizeSourceMapBytes(bytes: Uint8Array): Uint8Array {
  checkSourceMapSize(bytes);
  const map = JSON.parse(decoder.decode(bytes)) as {
    version?: number;
    sourceRoot?: unknown;
    sources?: unknown;
  };
  if (!Array.isArray(map.sources)) throw new Error("source map has no sources array");
  const root = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
  map.sources = map.sources.map((source) => {
    if (typeof source !== "string") throw new Error("source map contains a non-string source");
    const combined = root ? `${root.replace(/[\\/]+$/, "")}/${source}` : source;
    return safeRelativePath(combined) ?? relocatedPath(combined);
  });
  map.sourceRoot = "";
  const result = encoder.encode(JSON.stringify(map));
  checkSourceMapSize(result);
  return result;
}

export function sourceMapDataUrlBytes(url: string): Uint8Array {
  // Bound encoded input before decoding or allocating a second representation.
  if (url.length > MAX_SOURCE_MAP_BYTES * 3 + 256)
    throw new Error("source-map data URL exceeds limit");
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma === -1) throw new Error("invalid source-map data URL");
  const metadata = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  const bytes = metadata.split(";").includes("base64")
    ? new Uint8Array(Buffer.from(payload, "base64"))
    : encoder.encode(decodeURIComponent(payload));
  checkSourceMapSize(bytes);
  return bytes;
}
