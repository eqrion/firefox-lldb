/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from "node:crypto";
import { posix } from "node:path";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

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
  return encoder.encode(JSON.stringify(map));
}

export function sourceMapDataUrlBytes(url: string): Uint8Array {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma === -1) throw new Error("invalid source-map data URL");
  const metadata = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  return metadata.split(";").includes("base64")
    ? new Uint8Array(Buffer.from(payload, "base64"))
    : encoder.encode(decodeURIComponent(payload));
}
