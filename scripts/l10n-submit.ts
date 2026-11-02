import { spawnSync } from "node:child_process";

interface SubmitArguments {
  readonly message: string;
}

interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

interface PushTarget {
  readonly remote: string;
  readonly ref: string;
  readonly setUpstream: boolean;
}

const translationDirectory = "translations/zhcn";

function parseArguments(args: readonly string[]): SubmitArguments {
  let message: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      throw new Error("读取命令参数失败");
    }
    if (argument === "--message") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("--message 后必须提供提交说明");
      }
      if (message !== undefined) {
        throw new Error("--message 只能提供一次");
      }
      message = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--message=")) {
      if (message !== undefined) {
        throw new Error("--message 只能提供一次");
      }
      message = argument.slice("--message=".length);
      continue;
    }
    throw new Error("不支持参数 " + argument);
  }
  if (message === undefined || message.trim() === "") {
    throw new Error(
      '提交说明为必填参数，请使用：pnpm l10n:submit --message "..."',
    );
  }
  return { message };
}

function runGit(args: readonly string[]): GitResult {
  const result = spawnSync("git", [...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function gitOutput(args: readonly string[], purpose: string): string {
  const result = runGit(args);
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim();
    throw new Error(purpose + (detail === "" ? "" : "：" + detail));
  }
  return result.stdout.trim();
}

function hasGitConfig(key: string): string | undefined {
  const result = runGit(["config", "--get", key]);
  if (result.status === 1) {
    return undefined;
  }
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim();
    throw new Error(
      "读取 Git 配置 " + key + " 失败" + (detail === "" ? "" : "：" + detail),
    );
  }
  return result.stdout.trim();
}

function isInTranslationProject(path: string): boolean {
  return (
    path === translationDirectory || path.startsWith(translationDirectory + "/")
  );
}

function stagedPaths(): string[] {
  // 禁用 rename 折叠，以便跨出翻译目录的删除端也会被范围检查发现。
  const result = runGit([
    "diff",
    "--cached",
    "--name-only",
    "--no-renames",
    "-z",
  ]);
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim();
    throw new Error("读取暂存区失败" + (detail === "" ? "" : "：" + detail));
  }
  return result.stdout.split("\0").filter((path) => path !== "");
}

function determinePushTarget(branch: string): PushTarget {
  const remoteKey = "branch." + branch + ".remote";
  const mergeKey = "branch." + branch + ".merge";
  const configuredRemote = hasGitConfig(remoteKey);
  const configuredRef = hasGitConfig(mergeKey);

  let remote: string;
  let ref: string;
  let setUpstream = false;
  if (configuredRemote === undefined && configuredRef === undefined) {
    remote = "origin";
    ref = "refs/heads/" + branch;
    setUpstream = true;
  } else if (configuredRemote === undefined || configuredRef === undefined) {
    throw new Error(
      "当前分支的 Git 上游配置不完整，请先修复 remote 和 merge 配置",
    );
  } else {
    remote = configuredRemote;
    ref = configuredRef;
  }

  if (!ref.startsWith("refs/heads/") || ref === "refs/heads/") {
    throw new Error("推送目标不是远端分支：" + ref);
  }
  if (remote === ".") {
    throw new Error("当前分支的上游指向本地仓库，无法作为推送远端");
  }

  const remoteResult = runGit(["remote", "get-url", "--push", remote]);
  if (remoteResult.status !== 0) {
    const detail = remoteResult.error?.message ?? remoteResult.stderr.trim();
    if (configuredRemote === undefined && remote === "origin") {
      throw new Error("未配置 Git 远端 origin，无法推送翻译提交");
    }
    throw new Error(
      "推送远端 " +
        remote +
        " 不存在或未配置" +
        (detail === "" ? "" : "：" + detail),
    );
  }
  return { remote, ref, setUpstream };
}

function commitTranslationChanges(message: string): boolean {
  const addResult = runGit(["add", "-A", "--", translationDirectory + "/"]);
  if (addResult.status !== 0) {
    const detail = addResult.error?.message ?? addResult.stderr.trim();
    throw new Error(
      "暂存翻译项目资料失败" + (detail === "" ? "" : "：" + detail),
    );
  }

  const diffResult = runGit([
    "diff",
    "--cached",
    "--quiet",
    "--",
    translationDirectory,
  ]);
  if (diffResult.status === 0) {
    return false;
  }
  if (diffResult.status !== 1) {
    const detail = diffResult.error?.message ?? diffResult.stderr.trim();
    throw new Error(
      "检查翻译暂存内容失败" + (detail === "" ? "" : "：" + detail),
    );
  }

  const commitResult = runGit(["commit", "-m", message]);
  if (commitResult.status !== 0) {
    const detail = commitResult.error?.message ?? commitResult.stderr.trim();
    throw new Error(
      "提交翻译项目资料失败" + (detail === "" ? "" : "：" + detail),
    );
  }
  return true;
}

function pushHead(target: PushTarget, branch: string, commit: string): void {
  const args = ["push"];
  if (target.setUpstream) {
    args.push("--set-upstream");
  }
  // 显式指定单一远端和目标 ref，避免 push.default 推送其他分支。
  args.push(target.remote, "HEAD:" + target.ref);
  const result = runGit(args);
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim();
    throw new Error(
      "推送失败；本地提交 " +
        commit +
        " 已保留，可修复远端问题后重试" +
        (detail === "" ? "" : "：" + detail),
    );
  }
  if (target.setUpstream) {
    process.stdout.write("已建立上游 " + target.remote + "/" + branch + "。\n");
  }
  process.stdout.write(
    "已推送提交 " + commit + " 至 " + target.remote + ":" + target.ref + "。\n",
  );
}

function submit(message: string): void {
  const branch = gitOutput(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "无法确定当前分支，请在有名称的分支上运行提交阶段",
  );
  const outsidePaths = stagedPaths().filter(
    (path) => !isInTranslationProject(path),
  );
  if (outsidePaths.length > 0) {
    throw new Error(
      "暂存区包含翻译项目范围外的改动，已停止且未修改暂存区：\n" +
        outsidePaths.map((path) => "- " + path).join("\n"),
    );
  }

  const target = determinePushTarget(branch);
  const createdCommit = commitTranslationChanges(message);
  const commit = gitOutput(["rev-parse", "HEAD"], "无法读取当前提交");
  if (!createdCommit) {
    process.stdout.write(
      "没有新的翻译项目改动，将推送现有提交 " + commit + "。\n",
    );
  }
  pushHead(target, branch, commit);
}

try {
  const { message } = parseArguments(process.argv.slice(2));
  submit(message);
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : String(error)) + "\n",
  );
  process.exitCode = 1;
}
