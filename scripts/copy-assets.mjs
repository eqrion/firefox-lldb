import { cp, mkdir, readdir } from "node:fs/promises";
import { extname } from "node:path";

await mkdir("dist/gdb/worker", { recursive: true });
const workerFiles = await readdir("src/gdb/worker");
for (const file of workerFiles.filter((f) => extname(f) === ".mjs")) {
  await cp(`src/gdb/worker/${file}`, `dist/gdb/worker/${file}`);
}

await cp("src/gdb/generated", "dist/gdb/generated", { recursive: true });
