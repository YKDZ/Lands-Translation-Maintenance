import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const l10nPackage = join(repositoryRoot, "packages/l10n");
const taskGateScript = join(repositoryRoot, "scripts/task-gates.ts");
const reviewScript = join(repositoryRoot, "scripts/l10n-review.ts");
const lioniCli = join(l10nPackage, "node_modules/.bin/lioni");
const turboCli = join(repositoryRoot, "node_modules/.bin/turbo");
const projectDirectory = "translations/zhcn";
const targetFile = projectDirectory + "/Locale/zh-CN.yml";

interface RootManifest {
  readonly packageManager?: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

async function createReviewRepository(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lands-l10n-review-"));
  context.after(() => rm(directory, { force: true, recursive: true }));

  const rootManifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ) as RootManifest;
  const rootScripts = rootManifest.scripts ?? {};
  const fixtureScripts = Object.fromEntries(
    Object.entries({
      check: rootScripts.check,
      "check:heavy": rootScripts["check:heavy"],
      "check:full": rootScripts["check:full"],
      fix: rootScripts.fix,
      "l10n:review": rootScripts["l10n:review"],
      "check:l10n": [
        JSON.stringify(process.execPath),
        "--conditions=source",
        JSON.stringify(lioniCli),
        "qa",
        JSON.stringify(projectDirectory + "/.lioni/lioni.config.ts"),
        "--output-format",
        "structured",
      ].join(" "),
      "format:check": "node --version",
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

  await mkdir(join(directory, "scripts"), { recursive: true });
  await writeFile(
    join(directory, "scripts/task-gates.ts"),
    await readFile(taskGateScript),
  );
  try {
    await access(reviewScript);
    await writeFile(
      join(directory, "scripts/l10n-review.ts"),
      await readFile(reviewScript),
    );
  } catch {
    // 首个红测在入口尚未实现时仍能运行到真实 CLI 调用处。
  }

  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(
      {
        name: "l10n-review-fixture",
        private: true,
        type: "module",
        packageManager: rootManifest.packageManager,
        scripts: fixtureScripts,
      },
      null,
      2,
    ),
  );
  await mkdir(join(directory, projectDirectory + "/.lioni"), {
    recursive: true,
  });
  await mkdir(join(directory, projectDirectory + "/Locale"), {
    recursive: true,
  });
  await writeFile(
    join(directory, "turbo.json"),
    JSON.stringify(
      {
        tasks: {
          "//#check": { tags: ["quality:entry"] },
          "//#check:heavy": { tags: ["quality:entry"] },
          "//#check:full": { tags: ["quality:entry"] },
          "//#fix": { tags: ["work:repair"] },
          "//#check:l10n": {
            outputs: [],
            tags: ["quality:heavy"],
          },
          "//#format:check": {
            outputs: [],
            tags: ["quality:light"],
          },
          "//#l10n:review": {
            cache: false,
            outputs: [],
            tags: ["work:on-demand"],
          },
          verify: {
            outputs: [],
            tags: ["quality:light"],
          },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(directory, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/*"\n',
  );
  await mkdir(join(directory, "packages/review-fixture"), {
    recursive: true,
  });
  await writeFile(
    join(directory, "packages/review-fixture/package.json"),
    JSON.stringify({
      name: "review-fixture",
      private: true,
      scripts: { verify: "node --version" },
    }),
  );
  await writeFile(join(directory, ".gitignore"), "node_modules/\n.turbo/\n");
  await mkdir(join(directory, "node_modules/.bin"), { recursive: true });
  await symlink(turboCli, join(directory, "node_modules/.bin/turbo"));
  await mkdir(join(directory, "node_modules/@lands-l10n"), {
    recursive: true,
  });
  await symlink(
    l10nPackage,
    join(directory, "node_modules/@lands-l10n/l10n"),
    "dir",
  );

  const rootLock = spawnSync("pnpm", ["install", "--lockfile-only"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(rootLock.status, 0, String(rootLock.stderr || rootLock.stdout));

  await writeFile(
    join(directory, projectDirectory + "/.lioni/project.yml"),
    [
      "format: lands-l10n-project/v1",
      "resources:",
      "  - path: plugin.yml",
      "    purpose: metadata",
      "  - path: Locale/en-US.yml",
      "    purpose: chat-language",
      "  - path: Locale/theme.yml",
      "    purpose: configuration",
      "translationScope:",
      '  sourceLanguage: "en-US"',
      '  targetLanguage: "zh-CN"',
      "  mappings:",
      "    - source: Locale/en-US.yml",
      "      target: Locale/zh-CN.yml",
      "      fields:",
      "        - path: [messages]",
      "          category: chat-string",
      "",
    ].join("\n"),
  );
  await mkdir(join(directory, projectDirectory + "/.lioni/terms"), {
    recursive: true,
  });
  await writeFile(
    join(directory, projectDirectory + "/.lioni/lioni.config.ts"),
    [
      'import { createLandsConfig } from "@lands-l10n/l10n/lioni.config";',
      "",
      "export default createLandsConfig(import.meta.url);",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(directory, projectDirectory + "/.lioni/terms/concepts.yaml"),
    "concepts: {}\n",
  );
  await writeFile(
    join(directory, projectDirectory + "/.lioni/terms/en-US.yaml"),
    "concepts: {}\n",
  );
  await writeFile(
    join(directory, projectDirectory + "/.lioni/terms/zh-CN.yaml"),
    "concepts: {}\n",
  );
  await writeFile(
    join(directory, projectDirectory + "/Locale/zh-CN.yml"),
    "messages:\n  greet: 你好\n",
  );
  await mkdir(join(directory, ".review-source/Locale"), { recursive: true });
  await writeFile(
    join(directory, ".review-source/plugin.yml"),
    "name: Lands\nversion: 9.1.1\n",
  );
  await writeFile(
    join(directory, ".review-source/Locale/en-US.yml"),
    "messages:\n  greet: Hello\n",
  );
  await writeFile(
    join(directory, ".review-source/Locale/theme.yml"),
    'theme:\n  tokens:\n    error: "<red>"\n',
  );

  const jarFile = join(directory, ".review-source.jar");
  const jar = spawnSync(
    "jar",
    [
      "--create",
      "--file",
      jarFile,
      "--no-manifest",
      "-C",
      join(directory, ".review-source"),
      ".",
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(jar.status, 0, String(jar.stderr || jar.stdout));
  const prepared = spawnSync(
    process.execPath,
    [
      "--conditions=source",
      join(l10nPackage, "scripts/prepare-lioni-source.ts"),
      "--jar",
      jarFile,
      "--config",
      join(directory, projectDirectory + "/.lioni/lioni.config.ts"),
    ],
    { cwd: directory, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(prepared.status, 0, String(prepared.stderr || prepared.stdout));
  await rm(jarFile);
  await rm(join(directory, ".review-source"), { recursive: true, force: true });

  runGit(directory, ["init", "--initial-branch=update/lands-9.1.1"]);
  runGit(directory, ["config", "user.name", "审阅阶段测试"]);
  runGit(directory, ["config", "user.email", "l10n-review@example.test"]);
  runGit(directory, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(directory, "README.md"), "临时审阅项目\n");
  runGit(directory, ["add", "--all"]);
  runGit(directory, ["commit", "-m", "建立临时审阅项目"]);

  return directory;
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

function runGitRaw(directory: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    String(result.stderr || result.stdout) || "git " + args.join(" ") + " 失败",
  );
  return String(result.stdout);
}

function runReview(directory: string): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync("pnpm", ["l10n:review"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

void test("正式完整验收通过后展示 staged、unstaged 与新增翻译差异且不改 Git 状态", async (context) => {
  const directory = await createReviewRepository(context);
  await writeFile(
    join(directory, targetFile),
    "messages:\n  greet: 已暂存译文\n",
  );
  runGit(directory, ["add", targetFile]);
  await writeFile(
    join(directory, targetFile),
    "messages:\n  greet: 当前译文\n",
  );
  await writeFile(
    join(directory, projectDirectory + "/Locale/extra.yml"),
    "extra: 新增译文\n",
  );
  const headBefore = runGit(directory, ["rev-parse", "HEAD"]);
  const indexBefore = runGit(directory, ["write-tree"]);
  const statusBefore = runGitRaw(directory, ["status", "--porcelain", "-z"]);

  const result = runReview(directory);

  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  assert.match(result.stdout + result.stderr, /完整验收通过/u);
  assert.match(result.stdout, /\+  greet: 当前译文/u);
  assert.match(result.stdout, /Locale\/extra\.yml/u);
  assert.match(result.stdout, /\+extra: 新增译文/u);
  assert.equal(runGit(directory, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(runGit(directory, ["write-tree"]), indexBefore);
  assert.equal(
    runGitRaw(directory, ["status", "--porcelain", "-z"]),
    statusBefore,
  );
});

void test("正式 QA 存在数据 error 时保留失败退出并继续展示差异", async (context) => {
  const directory = await createReviewRepository(context);
  await rm(join(directory, targetFile));
  const headBefore = runGit(directory, ["rev-parse", "HEAD"]);
  const indexBefore = runGit(directory, ["write-tree"]);
  const statusBefore = runGitRaw(directory, ["status", "--porcelain", "-z"]);

  const result = runReview(directory);

  assert.notEqual(result.status, 0, result.stdout + "\n" + result.stderr);
  assert.match(result.stdout + result.stderr, /正式完整验收失败/u);
  assert.match(result.stdout + result.stderr, /translation\.missing/u);
  assert.match(result.stdout, /当前待提交差异/u);
  assert.match(result.stdout, /Locale\/zh-CN\.yml/u);
  assert.equal(runGit(directory, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(runGit(directory, ["write-tree"]), indexBefore);
  assert.equal(
    runGitRaw(directory, ["status", "--porcelain", "-z"]),
    statusBefore,
  );
});

void test("QA 执行失败时保留非零退出并仍输出待提交差异", async (context) => {
  const directory = await createReviewRepository(context);
  await writeFile(
    join(directory, projectDirectory + "/.lioni/source/current.json"),
    "{损坏的来源指针\n",
  );
  await writeFile(
    join(directory, targetFile),
    "messages:\n  greet: 执行失败时待审阅的译文\n",
  );
  const headBefore = runGit(directory, ["rev-parse", "HEAD"]);
  const indexBefore = runGit(directory, ["write-tree"]);
  const statusBefore = runGitRaw(directory, ["status", "--porcelain", "-z"]);

  const result = runReview(directory);

  assert.notEqual(result.status, 0, result.stdout + "\n" + result.stderr);
  assert.match(result.stdout + result.stderr, /正式完整验收失败/u);
  assert.match(result.stdout + result.stderr, /source|来源|JSON/u);
  assert.match(result.stdout, /当前待提交差异/u);
  assert.match(result.stdout, /\+  greet: 执行失败时待审阅的译文/u);
  assert.equal(runGit(directory, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(runGit(directory, ["write-tree"]), indexBefore);
  assert.equal(
    runGitRaw(directory, ["status", "--porcelain", "-z"]),
    statusBefore,
  );
});
