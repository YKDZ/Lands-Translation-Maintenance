import { randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { sha256 } from "#/value";

export interface FileSnapshot {
  readonly path: string;
  readonly sha256: string | undefined;
}

export interface FileWrite {
  readonly path: string;
  readonly content: string;
  readonly expectedSha256: string | undefined;
}

export class ConcurrentEditError extends Error {
  readonly file: string;

  constructor(file: string) {
    super(`初始化期间文件发生变化，未覆盖并行编辑：${file}`);
    this.name = "ConcurrentEditError";
    this.file = file;
  }
}

async function readSnapshot(path: string): Promise<FileSnapshot> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`预期为普通文件：${path}`);
    const bytes = await readFile(path);
    return { path, sha256: sha256(bytes) };
  } catch (error) {
    if (isMissing(error)) return { path, sha256: undefined };
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

export async function captureFileSnapshots(
  paths: readonly string[],
): Promise<readonly FileSnapshot[]> {
  return Promise.all(paths.map(readSnapshot));
}

export async function assertFileSnapshots(
  expected: readonly FileSnapshot[],
): Promise<void> {
  for (const snapshot of expected) {
    const current = await readSnapshot(snapshot.path);
    if (current.sha256 !== snapshot.sha256) {
      throw new ConcurrentEditError(snapshot.path);
    }
  }
}

async function ensureParents(
  paths: readonly string[],
): Promise<readonly string[]> {
  const missing = new Set<string>();
  for (const file of paths) {
    let directory = dirname(file);
    const chain: string[] = [];
    while (true) {
      try {
        const info = await lstat(directory);
        if (!info.isDirectory())
          throw new Error(`目标父路径不是目录：${directory}`);
        break;
      } catch (error) {
        if (!isMissing(error)) throw error;
        chain.push(directory);
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    for (const missingPath of chain) missing.add(missingPath);
  }
  const created: string[] = [];
  try {
    for (const directory of [...missing].sort(
      (left, right) => left.length - right.length,
    )) {
      try {
        await mkdir(directory);
        created.push(directory);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const info = await lstat(directory);
        if (!info.isDirectory()) {
          throw new Error(`目标父路径不是目录：${directory}`);
        }
      }
    }
  } catch (error) {
    for (const directory of created.sort(
      (left, right) => right.length - left.length,
    )) {
      await rmdir(directory).catch(() => undefined);
    }
    throw error;
  }
  return created.sort((left, right) => right.length - left.length);
}

async function restoreBackup(
  backup: string,
  destination: string,
): Promise<void> {
  await link(backup, destination);
  await unlink(backup);
}

interface StagedWrite extends FileWrite {
  readonly temporaryPath: string;
  readonly backupPath: string;
  readonly outputSha256: string;
  movedOriginal: boolean;
  linkedOutput: boolean;
}

export async function writeFilesAtomically(
  writes: readonly FileWrite[],
  beforeCommit: () => Promise<void>,
): Promise<void> {
  if (writes.length === 0) return;
  const createdDirectories = await ensureParents(
    writes.map((write) => write.path),
  );
  const staged: StagedWrite[] = [];
  const transactionId = randomUUID();

  try {
    for (const write of writes) {
      const fileName = basename(write.path);
      const info = await readSnapshot(write.path);
      if (info.sha256 !== write.expectedSha256)
        throw new ConcurrentEditError(write.path);
      const temporaryPath = join(
        dirname(write.path),
        `.${fileName}.${transactionId}.tmp`,
      );
      const backupPath = join(
        dirname(write.path),
        `.${fileName}.${transactionId}.bak`,
      );
      const stagedWrite: StagedWrite = {
        ...write,
        temporaryPath,
        backupPath,
        outputSha256: sha256(write.content),
        movedOriginal: false,
        linkedOutput: false,
      };
      staged.push(stagedWrite);
      const mode =
        info.sha256 === undefined
          ? 0o666
          : (await lstat(write.path)).mode & 0o777;
      const handle = await open(temporaryPath, "wx", mode);
      try {
        await handle.writeFile(write.content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }

    await beforeCommit();
    for (const write of staged) {
      const current = await readSnapshot(write.path);
      if (current.sha256 !== write.expectedSha256)
        throw new ConcurrentEditError(write.path);
      if (current.sha256 !== undefined) {
        await rename(write.path, write.backupPath);
        write.movedOriginal = true;
        const moved = await readSnapshot(write.backupPath);
        if (moved.sha256 !== write.expectedSha256) {
          await restoreBackup(write.backupPath, write.path).catch(
            () => undefined,
          );
          write.movedOriginal = false;
          throw new ConcurrentEditError(write.path);
        }
      }
      await link(write.temporaryPath, write.path);
      write.linkedOutput = true;
      await unlink(write.temporaryPath);
    }
  } catch (error) {
    for (const write of [...staged].reverse()) {
      if (write.linkedOutput) {
        const current = await readSnapshot(write.path).catch(() => undefined);
        if (current?.sha256 === write.outputSha256) {
          await rm(write.path, { force: true }).catch(() => undefined);
        }
      }
      if (write.movedOriginal) {
        try {
          await lstat(write.path);
        } catch (pathError) {
          if (isMissing(pathError)) {
            await restoreBackup(write.backupPath, write.path).catch(
              () => undefined,
            );
          }
        }
      }
      await rm(write.temporaryPath, { force: true }).catch(() => undefined);
    }
    for (const directory of createdDirectories) {
      await rmdir(directory).catch(() => undefined);
    }
    throw error;
  }

  for (const write of staged) {
    if (write.movedOriginal) {
      await rm(write.backupPath, { force: true }).catch(() => undefined);
    }
  }
}
