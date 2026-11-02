import { spawnSync } from "node:child_process";

import { runTaskGate } from "./task-gates.ts";

interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

const translationDirectory = "translations/zhcn";
const maxDiffBytes = 32 * 1024 * 1024;

function runGit(args: readonly string[]): GitResult {
  const result = spawnSync("git", [...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: maxDiffBytes,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function writeGitFailure(description: string, result: GitResult): void {
  const detail = result.error?.message ?? result.stderr.trim();
  process.stderr.write(
    description + (detail === "" ? "" : "：" + detail) + "\n",
  );
}

function showPendingDiff(): number {
  process.stdout.write("\n当前待提交差异（" + translationDirectory + "）：\n");
  let hasDiff = false;
  let failed = false;

  // 以 HEAD 为基线可同时展示已暂存与未暂存的已跟踪改动，且不改写 index。
  const tracked = runGit([
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--binary",
    "HEAD",
    "--",
    translationDirectory,
  ]);
  if (tracked.status !== 0) {
    writeGitFailure("读取已跟踪的翻译差异失败", tracked);
    failed = true;
  } else if (tracked.stdout !== "") {
    process.stdout.write(tracked.stdout);
    hasDiff = true;
  }

  const untracked = runGit([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    translationDirectory + "/",
  ]);
  if (untracked.status !== 0) {
    writeGitFailure("读取新增翻译文件失败", untracked);
    failed = true;
  } else {
    // Git 常规 diff 不包含未跟踪文件，逐个按新增文件展示其真实内容差异。
    const paths = untracked.stdout.split("\0").filter((path) => path !== "");
    for (const path of paths) {
      const result = runGit([
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-color",
        "--binary",
        "--",
        "/dev/null",
        path,
      ]);
      if (result.status === 0 || result.status === 1) {
        if (result.stdout !== "") {
          process.stdout.write(result.stdout);
          hasDiff = true;
        }
      } else {
        writeGitFailure("读取新增翻译文件差异失败：" + path, result);
        failed = true;
      }
    }
  }

  if (!hasDiff && !failed) {
    process.stdout.write("（无翻译项目待提交差异）\n");
  }
  return failed ? 1 : 0;
}

async function review(): Promise<void> {
  let checkStatus: number;
  let checkRan = false;
  const extraArguments = process.argv.slice(2);
  if (extraArguments.length > 0) {
    process.stderr.write(
      "l10n:review 不接受参数；请直接运行 pnpm l10n:review。\n",
    );
    checkStatus = 2;
  } else {
    checkRan = true;
    process.stdout.write("开始执行正式完整验收（check:full）。\n");
    try {
      checkStatus = await runTaskGate("check:full");
    } catch (error) {
      process.stderr.write(
        "执行完整验收时发生异常：" +
          (error instanceof Error ? error.message : String(error)) +
          "\n",
      );
      checkStatus = 1;
    }
  }

  process.stdout.write(
    !checkRan
      ? "完整验收未执行（退出码 " + String(checkStatus) + "）。\n"
      : checkStatus === 0
        ? "正式完整验收通过。\n"
        : "正式完整验收失败（退出码 " + String(checkStatus) + "）。\n",
  );
  const diffStatus = showPendingDiff();
  process.exitCode = checkStatus === 0 ? diffStatus : checkStatus;
}

void review();
