import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  prepareLandsSource,
  runLandsUpdateStage,
} from "@lands-l10n/l10n/maintenance";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(scriptDirectory, "..");

function git(workingDirectory: string, arguments_: readonly string[]): string {
  const result = spawnSync("git", [...arguments_], {
    cwd: workingDirectory,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw new Error(`无法运行 Git：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Git ${arguments_.join(" ")} 失败（退出码 ${String(result.status)}）：${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

async function runTurboBuilds(): Promise<void> {
  await new Promise<void>((resolveBuild, rejectBuild) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "turbo",
        "run",
        "@lands-l10n/l10n#build",
        "@lands-l10n/l10n#build:minimessage",
      ],
      { cwd: workspaceDirectory, stdio: "inherit" },
    );
    child.once("error", (error) => rejectBuild(error));
    child.once("exit", (status, signal) => {
      if (status === 0) {
        resolveBuild();
      } else {
        rejectBuild(
          new Error(
            `Lioni 与 MiniMessage 构建失败（${signal === null ? `退出码 ${String(status)}` : `信号 ${signal}`}）。`,
          ),
        );
      }
    });
  });
}

/** 首次建立版本分支，后续切回同版本分支；不暂存或清理工作区。 */
function switchToVersionBranch(
  gitDirectory: string,
  sourceVersion: string,
): string {
  const branch = `update/lands-${sourceVersion}`;
  const validation = spawnSync(
    "git",
    ["check-ref-format", "--branch", branch],
    {
      cwd: gitDirectory,
      encoding: "utf8",
    },
  );
  if (validation.error !== undefined || validation.status !== 0) {
    throw new Error(`Lands 来源版本无法用于 Git 分支名：${sourceVersion}`);
  }

  const currentBranch = git(gitDirectory, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (currentBranch === branch) return branch;

  const existingBranch = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: gitDirectory, encoding: "utf8" },
  );
  if (existingBranch.error !== undefined) {
    throw new Error(`无法检查版本分支：${existingBranch.error.message}`);
  }
  const switchArguments =
    existingBranch.status === 0
      ? ["switch", branch]
      : ["switch", "--create", branch];
  git(gitDirectory, switchArguments);
  return branch;
}

function printUsage(): void {
  process.stdout.write(
    "用法：pnpm l10n:update --jar <Lands.jar> [--config <lioni.config.ts>]\n",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseInvocation() {
  return parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
      jar: { type: "string" },
    },
    strict: true,
  });
}

async function main(): Promise<void> {
  let invocation: ReturnType<typeof parseInvocation>;
  try {
    invocation = parseInvocation();
  } catch (error) {
    process.stderr.write(`参数格式无效：${errorMessage(error)}\n`);
    printUsage();
    process.exitCode = 2;
    return;
  }

  if (invocation.values.help) {
    printUsage();
    return;
  }
  const jar = invocation.values.jar;
  if (jar === undefined) {
    process.stderr.write("必须提供 --jar。\n");
    process.exitCode = 2;
    return;
  }

  try {
    const gitDirectory = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
    const jarPath = resolve(gitDirectory, jar);
    const configPath = resolve(
      gitDirectory,
      invocation.values.config ?? "translations/zhcn/.lioni/lioni.config.ts",
    );

    // pnpm 直接调用不会执行当前任务图，构建依赖由此显式交给 Turbo。
    if (process.env.TURBO_HASH === undefined) await runTurboBuilds();

    const source = await prepareLandsSource(jarPath, pathToFileURL(configPath));
    const branch = switchToVersionBranch(gitDirectory, source.sourceVersion);
    process.stdout.write(
      `正在 ${branch} 准备 Lands ${source.sourceVersion} 的同步。\n`,
    );

    const stage = await runLandsUpdateStage(configPath);
    if (stage.status === "sync-incomplete") {
      process.stderr.write(`${stage.message}\n`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`${stage.qualityReport}\n`);
    if (stage.status === "quality-incomplete") {
      process.stderr.write(`${stage.message}\n`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      stage.qualityDecision.passed
        ? "同步与质量检查均已完成。\n"
        : "同步与质量检查均已完成；质量未通过，请先处理报告中的数据问题。\n",
    );
  } catch (error) {
    process.stderr.write(`Lands 同步准备失败：${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

await main();
