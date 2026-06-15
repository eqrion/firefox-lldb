// Backend for the platform server's "remote filesystem" (the vFile:* and
// qPlatform_* packets). LLDB models the debug target's host as a filesystem it
// reaches over the RSP connection.
//
// LocalFileSystem backs it with the real local filesystem, which is what
// LLDB's platform conformance testsuite exercises. The browser use case (the
// remote filesystem is the set of module URLs served over HTTP) gets a
// separate implementation that satisfies the read-only subset of this API.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// LLDB OpenOptions (lldb/include/lldb/Host/File.h), NOT POSIX open(2) flags.
export const enum OpenOption {
  ReadOnly = 0x0,
  WriteOnly = 0x1,
  ReadWrite = 0x2,
  Append = 0x8,
  CanCreate = 0x200,
  Truncate = 0x400,
  CanCreateNewOnly = 0x800,
}

export interface ModuleInfo {
  uuid?: string;
  triple?: string;
  fileOffset: number;
  fileSize: number;
}

export interface PlatformFileSystem {
  open(path: string, flags: number, mode: number): Promise<number>;
  close(fd: number): Promise<void>;
  pread(fd: number, count: number, offset: number): Promise<Uint8Array>;
  pwrite(fd: number, offset: number, data: Uint8Array): Promise<number>;
  size(path: string): Promise<number>;
  mode(path: string): Promise<number>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  symlink(src: string, dst: string): Promise<void>;
  mkdir(path: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Tab-completion candidates for a partial path. */
  pathComplete(partial: string, dirsOnly: boolean): Promise<string[]>;
  moduleInfo(path: string, triple: string): Promise<ModuleInfo | null>;
}

/** Translate LLDB OpenOptions into POSIX open(2) flags for node:fs. */
function toPosixFlags(lldbFlags: number): number {
  const C = fs.constants;
  let flags: number;
  if (lldbFlags & OpenOption.ReadWrite) {
    flags = C.O_RDWR;
  } else if (lldbFlags & OpenOption.WriteOnly) {
    flags = C.O_WRONLY;
  } else {
    flags = C.O_RDONLY;
  }
  if (lldbFlags & OpenOption.Append) flags |= C.O_APPEND;
  if (lldbFlags & OpenOption.CanCreateNewOnly) flags |= C.O_CREAT | C.O_EXCL;
  else if (lldbFlags & OpenOption.CanCreate) flags |= C.O_CREAT;
  if (lldbFlags & OpenOption.Truncate) flags |= C.O_TRUNC;
  return flags;
}

export class LocalFileSystem implements PlatformFileSystem {
  #handles = new Map<number, fsp.FileHandle>();
  #nextFd = 3; // avoid colliding with the conventional 0/1/2

  async open(p: string, flags: number, mode: number): Promise<number> {
    const handle = await fsp.open(p, toPosixFlags(flags), mode || 0o644);
    const fd = this.#nextFd++;
    this.#handles.set(fd, handle);
    return fd;
  }

  async close(fd: number): Promise<void> {
    const handle = this.#handles.get(fd);
    if (!handle) throw new Error("EBADF");
    this.#handles.delete(fd);
    await handle.close();
  }

  async pread(fd: number, count: number, offset: number): Promise<Uint8Array> {
    const handle = this.#handles.get(fd);
    if (!handle) throw new Error("EBADF");
    const buf = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buf, 0, count, offset);
    return buf.subarray(0, bytesRead);
  }

  async pwrite(fd: number, offset: number, data: Uint8Array): Promise<number> {
    const handle = this.#handles.get(fd);
    if (!handle) throw new Error("EBADF");
    const { bytesWritten } = await handle.write(data, 0, data.length, offset);
    return bytesWritten;
  }

  async size(p: string): Promise<number> {
    return (await fsp.stat(p)).size;
  }

  async mode(p: string): Promise<number> {
    return (await fsp.stat(p)).mode & 0o7777;
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }

  async unlink(p: string): Promise<void> {
    await fsp.unlink(p);
  }

  async symlink(src: string, dst: string): Promise<void> {
    await fsp.symlink(src, dst);
  }

  async mkdir(p: string, mode: number): Promise<void> {
    await fsp.mkdir(p, { mode: mode || 0o755 });
  }

  async chmod(p: string, mode: number): Promise<void> {
    await fsp.chmod(p, mode);
  }

  async pathComplete(partial: string, dirsOnly: boolean): Promise<string[]> {
    const dir = partial.endsWith("/") ? partial : path.dirname(partial);
    const prefix = partial.endsWith("/") ? "" : path.basename(partial);
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir || ".", { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (!e.name.startsWith(prefix)) continue;
      if (dirsOnly && !e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      out.push(e.isDirectory() ? full + "/" : full);
    }
    return out;
  }

  async moduleInfo(p: string, triple: string): Promise<ModuleInfo | null> {
    try {
      const stat = await fsp.stat(p);
      return { triple, fileOffset: 0, fileSize: stat.size };
    } catch {
      return null;
    }
  }
}
