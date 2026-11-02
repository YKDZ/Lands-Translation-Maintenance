import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const translationFiles = [
  "translations/zhcn/Locale/zh-CN.yml",
  "translations/zhcn/.lioni/project.yml",
  "translations/zhcn/.lioni/source/current.json",
  "translations/zhcn/.lioni/lioni.baseline.json",
  "translations/zhcn/.lioni/lioni.exceptions.yaml",
  "translations/zhcn/.lioni/terms/game.yml",
  "translations/zhcn/Modules/README.md",
] as const;

interface RootManifest {
  readonly packageManager?: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

interface CommandOutput {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function createRepository(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lands-l10n-submit-"));
  context.after(() => rm(directory, { force: true, recursive: true }));

  const rootManifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ) as RootManifest;
  const submitCommand = rootManifest.scripts?.["l10n:submit"];
  await mkdir(join(directory, "translations/zhcn/Locale"), {
    recursive: true,
  });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(
      {
        name: "l10n-submit-git-fixture",
        private: true,
        type: "module",
        packageManager: rootManifest.packageManager,
        scripts:
          submitCommand === undefined ? {} : { "l10n:submit": submitCommand },
      },
      null,
      2,
    ),
  );
  if (submitCommand !== undefined) {
    await mkdir(join(directory, "scripts"), { recursive: true });
    await writeFile(
      join(directory, "scripts/l10n-submit.ts"),
      await readFile(join(repositoryRoot, "scripts/l10n-submit.ts")),
    );
  }
  const lockfile = spawnSync("pnpm", ["install", "--lockfile-only"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(lockfile.status, 0, lockfile.stderr || lockfile.stdout);

  const initialContents = [
    "message: 初始内容\n",
    "name: Lands 翻译项目\n",
    '{"snapshot":"8.9.2"}\n',
    '{"baseline":"8.9.2"}\n',
    "exceptions: []\n",
    "terms:\n  world: 世界\n",
    "# 受管模块资料\n",
  ] as const;
  for (const [index, path] of translationFiles.entries()) {
    const filePath = join(directory, path);
    const content = initialContents[index];
    if (content === undefined) {
      throw new Error("测试仓库初始内容与翻译路径数量不匹配");
    }
    await mkdir(resolve(filePath, ".."), { recursive: true });
    await writeFile(filePath, content);
  }
  await writeFile(join(directory, "README.md"), "工程说明\n");

  runGit(directory, ["init", "--initial-branch=update/lands-9.1.1"]);
  runGit(directory, ["config", "user.name", "翻译维护测试"]);
  runGit(directory, ["config", "user.email", "l10n-submit@example.test"]);
  runGit(directory, ["config", "commit.gpgsign", "false"]);
  runGit(directory, ["add", "--all"]);
  runGit(directory, ["commit", "-m", "建立测试基线"]);

  return directory;
}

async function createBareRemote(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lands-l10n-remote-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const remote = join(directory, "repository.git");
  const result = spawnSync(
    "git",
    ["init", "--bare", "--initial-branch=main", remote],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, String(result.stderr || result.stdout));
  return remote;
}

function runGit(directory: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    String(result.stderr || result.stdout) || "git " + args.join(" ") + " 失败",
  );
  return String(result.stdout).trimEnd();
}

function runSubmit(directory: string, args: readonly string[]): CommandOutput {
  const result = spawnSync("pnpm", ["l10n:submit", ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

function indexTree(directory: string): string {
  return runGit(directory, ["write-tree"]);
}

function remoteRef(remote: string, ref: string): string {
  const result = spawnSync("git", ["--git-dir", remote, "rev-parse", ref], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, String(result.stderr || result.stdout));
  return String(result.stdout).trim();
}

function assertCommandSucceeded(result: CommandOutput): void {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

void test("缺少 --message 时拒绝且不改变 Git index", async (context) => {
  const directory = await createRepository(context);
  const indexTreeBefore = indexTree(directory);

  const result = runSubmit(directory, []);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + "\n" + result.stderr, /提交说明.*必填/u);
  assert.equal(indexTree(directory), indexTreeBefore);
  assert.equal(runGit(directory, ["status", "--porcelain"]), "");
});

void test("只提交翻译项目增删改并沿 origin 同名分支推送", async (context) => {
  const directory = await createRepository(context);
  const origin = await createBareRemote(context);
  runGit(directory, ["remote", "add", "origin", origin]);
  runGit(directory, ["config", "push.default", "matching"]);
  runGit(directory, ["push", "origin", "HEAD:refs/heads/update/lands-9.1.1"]);

  runGit(directory, ["checkout", "-b", "unrelated"]);
  await writeFile(join(directory, "unrelated.txt"), "远端副分支初始内容\n");
  runGit(directory, ["add", "unrelated.txt"]);
  runGit(directory, ["commit", "-m", "建立副分支远端状态"]);
  runGit(directory, ["push", "origin", "HEAD:refs/heads/unrelated"]);
  const remoteUnrelatedBefore = remoteRef(origin, "refs/heads/unrelated");
  await writeFile(join(directory, "unrelated.txt"), "本地副分支未推送内容\n");
  runGit(directory, ["commit", "-am", "副分支本地提交"]);
  runGit(directory, ["checkout", "update/lands-9.1.1"]);

  const stagedProject = join(directory, translationFiles[1]);
  await writeFile(stagedProject, "name: 已暂存项目资料\n");
  runGit(directory, ["add", translationFiles[1]]);
  await writeFile(
    join(directory, translationFiles[0]),
    "message: 已修改译文\n",
  );
  await rm(join(directory, translationFiles[5]));
  await mkdir(join(directory, "translations/zhcn/.lioni/source/snapshots"), {
    recursive: true,
  });
  await writeFile(
    join(directory, "translations/zhcn/.lioni/source/snapshots/9.1.1.json"),
    '{"snapshot":"9.1.1"}\n',
  );
  await writeFile(
    join(directory, "translations/zhcn/.lioni/lioni.baseline.json"),
    '{"baseline":"9.1.1"}\n',
  );
  await writeFile(join(directory, "translations/zhcn/categories.yml"), "[]\n");
  await writeFile(join(directory, "README.md"), "保留范围外工作区改动\n");

  const result = runSubmit(directory, ["--message", "更新 Lands 9.1.1 翻译"]);

  assertCommandSucceeded(result);
  const commit = runGit(directory, ["rev-parse", "HEAD"]);
  assert.equal(
    runGit(directory, ["log", "-1", "--format=%s"]),
    "更新 Lands 9.1.1 翻译",
  );
  const committedPaths = runGit(directory, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "--no-renames",
    "-r",
    "HEAD",
  ])
    .split("\n")
    .filter((path) => path !== "");
  assert.ok(committedPaths.length >= 6);
  assert.ok(
    committedPaths.every(
      (path) =>
        path === "translations/zhcn" || path.startsWith("translations/zhcn/"),
    ),
    committedPaths.join("\n"),
  );
  assert.equal(remoteRef(origin, "refs/heads/update/lands-9.1.1"), commit);
  assert.equal(
    runGit(directory, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]),
    "origin/update/lands-9.1.1",
  );
  assert.equal(
    remoteRef(origin, "refs/heads/unrelated"),
    remoteUnrelatedBefore,
    "显式 refspec 不得推送默认配置匹配到的其他分支",
  );
  assert.equal(runGit(directory, ["status", "--porcelain"]), " M README.md");
  assert.doesNotMatch(result.stdout + "\n" + result.stderr, /质量通过/u);
});

void test("沿用上游实际 remote/ref，即使目标名不同且 push.default 为 matching", async (context) => {
  const directory = await createRepository(context);
  const origin = await createBareRemote(context);
  const publication = await createBareRemote(context);
  runGit(directory, ["remote", "add", "origin", origin]);
  runGit(directory, ["remote", "add", "publication", publication]);
  runGit(directory, [
    "push",
    "publication",
    "HEAD:refs/heads/review/translation-candidate",
  ]);
  runGit(directory, [
    "config",
    "branch.update/lands-9.1.1.remote",
    "publication",
  ]);
  runGit(directory, [
    "config",
    "branch.update/lands-9.1.1.merge",
    "refs/heads/review/translation-candidate",
  ]);
  runGit(directory, ["config", "push.default", "matching"]);
  await writeFile(
    join(directory, translationFiles[4]),
    "exceptions: [] # 审阅后保留\n",
  );

  const result = runSubmit(directory, ["--message=更新例外资料"]);

  assertCommandSucceeded(result);
  const commit = runGit(directory, ["rev-parse", "HEAD"]);
  assert.equal(
    remoteRef(publication, "refs/heads/review/translation-candidate"),
    commit,
  );
  const originRefs = spawnSync(
    "git",
    ["--git-dir", origin, "for-each-ref", "--format=%(refname)"],
    { encoding: "utf8" },
  );
  assert.equal(originRefs.status, 0, originRefs.stderr || originRefs.stdout);
  assert.equal(originRefs.stdout.trim(), "");
  assert.match(
    result.stdout,
    /publication:refs\/heads\/review\/translation-candidate/u,
  );
});

void test("范围外已暂存文件触发停止并保持 index 与其他工作区改动", async (context) => {
  const directory = await createRepository(context);
  await writeFile(join(directory, "README.md"), "用户已暂存的工程改动\n");
  runGit(directory, ["add", "README.md"]);
  await writeFile(
    join(directory, translationFiles[0]),
    "message: 尚未暂存译文\n",
  );
  const indexBefore = indexTree(directory);
  const stagedBefore = runGit(directory, ["diff", "--cached", "--raw", "-z"]);

  const result = runSubmit(directory, ["--message", "不应提交"]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + "\n" + result.stderr, /README\.md/u);
  assert.equal(indexTree(directory), indexBefore);
  assert.equal(
    runGit(directory, ["diff", "--cached", "--raw", "-z"]),
    stagedBefore,
  );
  assert.equal(
    runGit(directory, ["status", "--porcelain"]),
    "M  README.md\n M translations/zhcn/Locale/zh-CN.yml",
  );
});

void test("范围外跨目录 rename 的删除端也会阻止提交且不改 index", async (context) => {
  const directory = await createRepository(context);
  await writeFile(join(directory, "notes.yml"), "同一份内容\n");
  runGit(directory, ["add", "notes.yml"]);
  runGit(directory, ["commit", "-m", "建立范围外文件"]);
  runGit(directory, [
    "mv",
    "notes.yml",
    "translations/zhcn/Locale/moved-notes.yml",
  ]);
  const defaultNameDiff = runGit(directory, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
  ]);
  assert.ok(
    defaultNameDiff.includes("translations/zhcn/Locale/moved-notes.yml"),
  );
  assert.ok(!defaultNameDiff.split("\0").some((path) => path === "notes.yml"));
  const indexBefore = indexTree(directory);
  const stagedBefore = runGit(directory, ["diff", "--cached", "--raw", "-z"]);

  const result = runSubmit(directory, ["--message", "拒绝范围外删除"]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + "\n" + result.stderr, /notes\.yml/u);
  assert.equal(indexTree(directory), indexBefore);
  assert.equal(
    runGit(directory, ["diff", "--cached", "--raw", "-z"]),
    stagedBefore,
  );
  assert.equal(
    runGit(directory, ["status", "--porcelain"]),
    "R  notes.yml -> translations/zhcn/Locale/moved-notes.yml",
  );
});

void test("没有远端时明确失败且不暂存或提交", async (context) => {
  const directory = await createRepository(context);
  await writeFile(
    join(directory, translationFiles[0]),
    "message: 等待配置远端\n",
  );
  const indexBefore = indexTree(directory);
  const headBefore = runGit(directory, ["rev-parse", "HEAD"]);

  const result = runSubmit(directory, ["--message", "本地翻译更新"]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + "\n" + result.stderr, /未配置 Git 远端 origin/u);
  assert.equal(indexTree(directory), indexBefore);
  assert.equal(runGit(directory, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(
    runGit(directory, ["status", "--porcelain"]),
    " M translations/zhcn/Locale/zh-CN.yml",
  );
});

void test("推送失败保留本地提交，修复远端后重试不重复提交", async (context) => {
  const directory = await createRepository(context);
  const origin = await createBareRemote(context);
  runGit(directory, ["remote", "add", "origin", origin]);
  const hook = join(origin, "hooks/pre-receive");
  await writeFile(hook, "#!/bin/sh\nprintf '临时拒绝推送\\n' >&2\nexit 1\n");
  await chmod(hook, 0o755);
  await writeFile(
    join(directory, translationFiles[0]),
    "message: 已审阅但质量错误仍需处理\n",
  );
  const baseCommit = runGit(directory, ["rev-parse", "HEAD"]);

  const rejected = runSubmit(directory, ["--message", "提交审阅后的翻译"]);

  assert.notEqual(rejected.status, 0, rejected.stdout);
  assert.match(rejected.stdout + "\n" + rejected.stderr, /本地提交 .* 已保留/u);
  const retainedCommit = runGit(directory, ["rev-parse", "HEAD"]);
  assert.notEqual(retainedCommit, baseCommit);
  assert.equal(
    runGit(directory, ["log", "-1", "--format=%s"]),
    "提交审阅后的翻译",
  );
  assert.equal(runGit(directory, ["status", "--porcelain"]), "");

  await rm(hook);
  const retry = runSubmit(directory, ["--message", "提交审阅后的翻译"]);

  assertCommandSucceeded(retry);
  assert.equal(runGit(directory, ["rev-parse", "HEAD"]), retainedCommit);
  assert.equal(
    remoteRef(origin, "refs/heads/update/lands-9.1.1"),
    retainedCommit,
  );
  assert.equal(runGit(directory, ["status", "--porcelain"]), "");
  assert.match(retry.stdout + "\n" + retry.stderr, /没有新的翻译项目改动/u);
});
