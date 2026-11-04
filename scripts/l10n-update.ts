import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  prepareLandsSource,
  runLandsUpdateStage,
} from "@lands-l10n/l10n/maintenance";

const workspaceDirectory = resolve(import.meta.dirname, "..");

async function run(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], {
      cwd: workspaceDirectory,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (status, signal) => {
      if (status === 0) resolveRun();
      else
        rejectRun(
          new Error(
            `${command} 失败（${signal === null ? `退出码 ${String(status)}` : `信号 ${signal}`}）。`,
          ),
        );
    });
  });
}

/**
 * 在同一文件系统的临时副本中准备快照、译文和基线，全部完成后替换项目目录。
 * 保留项目中的人工编辑；普通失败不改动原目录。调用期间应暂停对该项目的其他写入。
 * 目录提交使用两次 rename；第二步失败时恢复原目录，进程强制中断时保留备份供恢复。
 */
export async function updateTranslationProject(
  jarPath: string,
  configPath: string,
) {
  const projectDirectory = dirname(dirname(configPath));
  const temporaryDirectory = await mkdtemp(
    join(dirname(projectDirectory), ".lioni-update-"),
  );
  const stagedProject = join(temporaryDirectory, "project");
  const backup = join(temporaryDirectory, "original");
  let retainBackup = false;
  try {
    await cp(projectDirectory, stagedProject, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const stagedConfig = join(
      stagedProject,
      relative(projectDirectory, configPath),
    );
    const source = await prepareLandsSource(
      jarPath,
      pathToFileURL(stagedConfig),
    );
    const stage = await runLandsUpdateStage(stagedConfig);
    if (stage.status !== "completed") throw new Error(stage.message);
    await run("pnpm", [
      "exec",
      "oxfmt",
      "--write",
      join(dirname(stagedConfig), "lioni.baseline.json"),
    ]);

    await rename(projectDirectory, backup);
    retainBackup = true;
    try {
      await rename(stagedProject, projectDirectory);
    } catch (error) {
      try {
        await rename(backup, projectDirectory);
        retainBackup = false;
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `更新提交失败，原项目保留在 ${backup}，请恢复后重试。`,
        );
      }
      throw error;
    }
    retainBackup = false;
    return source;
  } finally {
    if (!retainBackup)
      await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      jar: { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(
      "用法：pnpm l10n:update --jar <Lands.jar> [--config <lioni.config.ts>]\n",
    );
    return;
  }
  if (values.jar === undefined) throw new Error("必须提供 --jar。");
  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (gitRoot.status !== 0) throw new Error("请在维护仓库中执行更新。");
  const directory = gitRoot.stdout.trim();
  // 直接 pnpm 调用不会执行任务图，构建依赖仍统一交给 Turbo。
  if (process.env.TURBO_HASH === undefined)
    await run("pnpm", ["exec", "turbo", "run", "@lands-l10n/l10n#build"]);
  const source = await updateTranslationProject(
    resolve(directory, values.jar),
    resolve(
      directory,
      values.config ?? "translations/zhcn/.lioni/lioni.config.ts",
    ),
  );
  process.stdout.write(
    `已更新 Lands ${source.sourceVersion} 的原文快照、译文结构和比较基线。请运行 pnpm check:full 验收。\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `Lands 更新失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
