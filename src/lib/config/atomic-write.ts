import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Write `data` to `path` atomically and without a world-readable window: the
 * content lands in a temp file created with mode `0o600` in the same
 * directory (so the final `rename` is same-filesystem and instant), then that
 * temp file is renamed onto `path`. A reader never observes a partially
 * written file, and there is no gap between "file exists" and "file has the
 * right mode" for another process on the same host to read through.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const { writeFile, rename, unlink } = await import("node:fs/promises");
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
