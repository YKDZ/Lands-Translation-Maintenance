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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { z } from "zod";

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

interface TransactionFile {
  readonly path: string;
  readonly expectedSha256?: string | undefined;
  readonly outputSha256: string;
}

interface TransactionJournal {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly phase: "prepared" | "committed";
  readonly files: readonly TransactionFile[];
  readonly createdDirectories: readonly string[];
}

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const journalSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    phase: z.enum(["prepared", "committed"]),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            expectedSha256: hashSchema.optional(),
            outputSha256: hashSchema,
          })
          .strict(),
      )
      .min(1),
    createdDirectories: z.array(z.string()),
  })
  .strict();

interface TransactionPaths {
  readonly path: string;
  readonly temporaryPath: string;
  readonly backupPath: string;
  readonly rollbackPath: string;
}

interface StagedWrite extends FileWrite, TransactionPaths {
  readonly relativePath: string;
  readonly outputSha256: string;
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

function safeProjectPath(projectDirectory: string, path: string): string {
  const parts = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`中断事务包含无效项目路径：${path}`);
  }
  const absolutePath = resolve(projectDirectory, ...parts);
  const fromProject = relative(projectDirectory, absolutePath);
  if (
    fromProject === "" ||
    fromProject === ".." ||
    fromProject.startsWith(`..${sep}`) ||
    isAbsolute(fromProject)
  ) {
    throw new Error(`中断事务路径越界：${path}`);
  }
  return absolutePath;
}

function projectRelativePath(projectDirectory: string, path: string): string {
  const fromProject = relative(projectDirectory, resolve(path));
  if (
    fromProject === "" ||
    fromProject === ".." ||
    fromProject.startsWith(`..${sep}`) ||
    isAbsolute(fromProject)
  ) {
    throw new Error(`事务写入路径必须位于消费项目中：${path}`);
  }
  return fromProject.split(sep).join("/");
}

function transactionPaths(
  projectDirectory: string,
  id: string,
  file: TransactionFile,
): TransactionPaths {
  const path = safeProjectPath(projectDirectory, file.path);
  const fileName = basename(path);
  return {
    path,
    temporaryPath: join(dirname(path), `.${fileName}.${id}.tmp`),
    backupPath: join(dirname(path), `.${fileName}.${id}.bak`),
    rollbackPath: join(dirname(path), `.${fileName}.${id}.rollback`),
  };
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

async function persistJournal(
  journalPath: string,
  journal: TransactionJournal,
  create: boolean,
): Promise<void> {
  const temporaryPath = `${journalPath}.${journal.id}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (create) await link(temporaryPath, journalPath);
  else await rename(temporaryPath, journalPath);
  await unlink(temporaryPath).catch(() => undefined);
}

async function readJournal(
  journalPath: string,
): Promise<TransactionJournal | undefined> {
  let source: string;
  try {
    source = await readFile(journalPath, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("发现无法解析的中断初始化事务记录，未改动项目文件");
  }
  const parsed = journalSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("发现格式无效的中断初始化事务记录，未改动项目文件");
  }
  return parsed.data;
}

async function moveOutputToRollback(
  target: string,
  rollback: string,
  outputSha256: string,
): Promise<void> {
  const current = await readSnapshot(target);
  if (current.sha256 === undefined) return;
  if (current.sha256 !== outputSha256) throw new ConcurrentEditError(target);

  const saved = await readSnapshot(rollback);
  if (saved.sha256 !== undefined) {
    if (saved.sha256 !== outputSha256) throw new ConcurrentEditError(target);
    await rm(target);
    return;
  }

  await rename(target, rollback);
  const moved = await readSnapshot(rollback);
  if (moved.sha256 !== outputSha256) {
    await restoreBackup(rollback, target).catch(() => undefined);
    throw new ConcurrentEditError(target);
  }
}

async function rollbackPreparedTransaction(
  projectDirectory: string,
  journalPath: string,
  journal: TransactionJournal,
): Promise<void> {
  const entries = journal.files.map((file) => ({
    file,
    paths: transactionPaths(projectDirectory, journal.id, file),
  }));

  for (const { file, paths } of entries) {
    const [current, backup, temporary, rollback] = await Promise.all([
      readSnapshot(paths.path),
      readSnapshot(paths.backupPath),
      readSnapshot(paths.temporaryPath),
      readSnapshot(paths.rollbackPath),
    ]);
    if (
      current.sha256 !== undefined &&
      current.sha256 !== file.expectedSha256 &&
      current.sha256 !== file.outputSha256
    ) {
      throw new ConcurrentEditError(paths.path);
    }
    if (
      backup.sha256 !== undefined &&
      (file.expectedSha256 === undefined ||
        backup.sha256 !== file.expectedSha256)
    ) {
      throw new ConcurrentEditError(paths.path);
    }
    if (
      temporary.sha256 !== undefined &&
      temporary.sha256 !== file.outputSha256
    ) {
      throw new ConcurrentEditError(paths.path);
    }
    if (
      rollback.sha256 !== undefined &&
      rollback.sha256 !== file.outputSha256
    ) {
      throw new ConcurrentEditError(paths.path);
    }
    if (
      file.expectedSha256 !== undefined &&
      current.sha256 === undefined &&
      backup.sha256 !== file.expectedSha256
    ) {
      throw new ConcurrentEditError(paths.path);
    }
    if (
      file.expectedSha256 !== undefined &&
      current.sha256 === file.outputSha256 &&
      current.sha256 !== file.expectedSha256 &&
      backup.sha256 !== file.expectedSha256
    ) {
      throw new ConcurrentEditError(paths.path);
    }
  }

  for (const { file, paths } of [...entries].reverse()) {
    const current = await readSnapshot(paths.path);
    if (
      current.sha256 !== undefined &&
      current.sha256 !== file.expectedSha256
    ) {
      await moveOutputToRollback(
        paths.path,
        paths.rollbackPath,
        file.outputSha256,
      );
    }

    const afterMove = await readSnapshot(paths.path);
    if (file.expectedSha256 !== undefined) {
      if (afterMove.sha256 === undefined) {
        const backup = await readSnapshot(paths.backupPath);
        if (backup.sha256 !== file.expectedSha256) {
          throw new ConcurrentEditError(paths.path);
        }
        await restoreBackup(paths.backupPath, paths.path);
      } else if (afterMove.sha256 !== file.expectedSha256) {
        throw new ConcurrentEditError(paths.path);
      }
    } else if (afterMove.sha256 !== undefined) {
      throw new ConcurrentEditError(paths.path);
    }

    await rm(paths.temporaryPath, { force: true });
    await rm(paths.backupPath, { force: true });
    await rm(paths.rollbackPath, { force: true });
  }

  await rm(`${journalPath}.${journal.id}.tmp`, { force: true });
  await rm(journalPath, { force: true });
  for (const directory of journal.createdDirectories) {
    await rmdir(safeProjectPath(projectDirectory, directory)).catch(
      () => undefined,
    );
  }
}

async function finishCommittedTransaction(
  projectDirectory: string,
  journalPath: string,
  journal: TransactionJournal,
): Promise<void> {
  for (const file of journal.files) {
    const paths = transactionPaths(projectDirectory, journal.id, file);
    await rm(paths.temporaryPath, { force: true });
    await rm(paths.backupPath, { force: true });
    await rm(paths.rollbackPath, { force: true });
  }
  await rm(`${journalPath}.${journal.id}.tmp`, { force: true });
  await rm(journalPath, { force: true });
}

export async function recoverInterruptedTransaction(
  projectDirectory: string,
  transactionRelativePath: string,
): Promise<void> {
  const root = resolve(projectDirectory);
  const journalPath = safeProjectPath(root, transactionRelativePath);
  const journal = await readJournal(journalPath);
  if (journal === undefined) return;
  for (const file of journal.files) {
    safeProjectPath(root, file.path);
  }
  for (const directory of journal.createdDirectories) {
    safeProjectPath(root, directory);
  }

  if (journal.phase === "committed") {
    await finishCommittedTransaction(root, journalPath, journal);
    return;
  }
  await rollbackPreparedTransaction(root, journalPath, journal);
}

export async function writeFilesAtomically(
  projectDirectory: string,
  transactionRelativePath: string,
  writes: readonly FileWrite[],
  beforeCommit: () => Promise<void>,
): Promise<void> {
  if (writes.length === 0) return;
  const root = resolve(projectDirectory);
  const journalPath = safeProjectPath(root, transactionRelativePath);
  const createdDirectories = await ensureParents([
    ...writes.map((write) => write.path),
    journalPath,
  ]);
  const transactionId = randomUUID();
  const staged: StagedWrite[] = [];
  let journal: TransactionJournal | undefined;
  let journalPublished = false;

  try {
    for (const write of writes) {
      const relativePath = projectRelativePath(root, write.path);
      const current = await readSnapshot(write.path);
      if (current.sha256 !== write.expectedSha256) {
        throw new ConcurrentEditError(write.path);
      }
      const fileName = basename(write.path);
      const temporaryPath = join(
        dirname(write.path),
        `.${fileName}.${transactionId}.tmp`,
      );
      const backupPath = join(
        dirname(write.path),
        `.${fileName}.${transactionId}.bak`,
      );
      const rollbackPath = join(
        dirname(write.path),
        `.${fileName}.${transactionId}.rollback`,
      );
      const stagedWrite: StagedWrite = {
        ...write,
        relativePath,
        path: write.path,
        temporaryPath,
        backupPath,
        rollbackPath,
        outputSha256: sha256(write.content),
      };
      staged.push(stagedWrite);
      const mode =
        current.sha256 === undefined
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
    journal = {
      schemaVersion: 1,
      id: transactionId,
      phase: "prepared",
      files: staged.map((write) => ({
        path: write.relativePath,
        ...(write.expectedSha256 === undefined
          ? {}
          : { expectedSha256: write.expectedSha256 }),
        outputSha256: write.outputSha256,
      })),
      createdDirectories: createdDirectories.map((directory) =>
        projectRelativePath(root, directory),
      ),
    };
    await persistJournal(journalPath, journal, true);
    journalPublished = true;

    for (const write of staged) {
      const current = await readSnapshot(write.path);
      if (current.sha256 !== write.expectedSha256) {
        throw new ConcurrentEditError(write.path);
      }
      if (current.sha256 !== undefined) {
        await rename(write.path, write.backupPath);
        const moved = await readSnapshot(write.backupPath);
        if (moved.sha256 !== write.expectedSha256) {
          await restoreBackup(write.backupPath, write.path).catch(
            () => undefined,
          );
          throw new ConcurrentEditError(write.path);
        }
      }
      await link(write.temporaryPath, write.path);
      await unlink(write.temporaryPath);
    }

    for (const write of staged) {
      const current = await readSnapshot(write.path);
      if (current.sha256 !== write.outputSha256) {
        throw new ConcurrentEditError(write.path);
      }
    }

    journal = { ...journal, phase: "committed" };
    await persistJournal(journalPath, journal, false);
  } catch (error) {
    if (!journalPublished) {
      for (const write of staged) {
        await rm(write.temporaryPath, { force: true }).catch(() => undefined);
      }
      await rm(`${journalPath}.${transactionId}.tmp`, { force: true }).catch(
        () => undefined,
      );
      for (const directory of createdDirectories) {
        await rmdir(directory).catch(() => undefined);
      }
      throw error;
    }
    try {
      await recoverInterruptedTransaction(root, transactionRelativePath);
    } catch (recoveryError) {
      if (recoveryError instanceof ConcurrentEditError) throw recoveryError;
      throw new Error(
        `初始化事务失败，且无法安全恢复：${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        { cause: error },
      );
    }
    throw error;
  }

  if (journal !== undefined) {
    await finishCommittedTransaction(root, journalPath, journal).catch(
      () => undefined,
    );
  }
}
