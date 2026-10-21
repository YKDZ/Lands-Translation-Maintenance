import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { initializeProject } from "@lands-l10n/l10n";
import { zipSync, strToU8 } from "fflate";

import {
  createProject,
  readEnvelope,
  readReport,
  runCli,
  runCliWithoutJava,
  snapshotProjectFiles,
} from "./cli-fixtures.ts";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliFile = resolve(packageDirectory, "dist/cli.js");

async function createInterruptedProject(t: TestContext, resourceCount = 150) {
  const directory = await mkdtemp(join(tmpdir(), "lands-l10n-interrupted-"));
  t.after(async () => rm(directory, { force: true, recursive: true }));
  await mkdir(join(directory, "lang"), { recursive: true });
  await mkdir(join(directory, ".l10n"), { recursive: true });

  const resources: string[] = [];
  const mappings: string[] = [];
  const jarEntries: Record<string, Uint8Array> = {};
  const targetPaths: string[] = [];
  for (let index = 0; index < resourceCount; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const source = `lang/en${suffix}.yml`;
    const target = `lang/zh${suffix}.yml`;
    targetPaths.push(target);
    resources.push(`  - path: ${source}`, "    purpose: chat-language");
    mappings.push(
      `    - source: ${source}`,
      `      target: ${target}`,
      "      fields:",
      "        - path: [messages]",
      "          category: chat-string",
    );
    jarEntries[source] = strToU8(`messages:\n  greeting: Hello ${suffix}\n`);
  }

  const jarFile = join(directory, "Lands.jar");
  await writeFile(jarFile, zipSync(jarEntries));
  await writeFile(
    join(directory, ".l10n/config.yml"),
    [
      "schemaVersion: 1",
      "source:",
      '  version: "8.0.1"',
      '  translationHistory: "b8f6985a4ad2af1b76b05f0f79b718a2234623ad"',
      "resources:",
      ...resources,
      "translationScope:",
      '  sourceLanguage: "en-US"',
      '  targetLanguage: "zh-CN"',
      "  mappings:",
      ...mappings,
      "rules:",
      "  minimessage-syntax:",
      "    enabled: false",
      "",
    ].join("\n"),
  );

  return { directory, jarFile, targetPaths };
}

function killInitWhenFileAppears(
  project: { readonly directory: string; readonly jarFile: string },
  relativePath: string,
  shouldKill?: (contents: string) => boolean,
) {
  return new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly killedAtFile: boolean;
    readonly stdout: string;
    readonly stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        cliFile,
        "init",
        "--project",
        project.directory,
        "--jar",
        project.jarFile,
        "--output-format",
        "structured",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let killedAtFile = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const watcher = watch(
      join(project.directory, dirname(relativePath)),
      (_event, name) => {
        if (name?.toString() !== basename(relativePath) || killedAtFile) return;
        if (shouldKill === undefined) {
          killedAtFile = child.kill("SIGKILL");
          return;
        }
        void readFile(join(project.directory, relativePath), "utf8").then(
          (contents) => {
            if (shouldKill(contents) && !killedAtFile) {
              killedAtFile = child.kill("SIGKILL");
            }
          },
        );
      },
    );
    const timeout = setTimeout(() => child.kill("SIGTERM"), 20_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      watcher.close();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      watcher.close();
      resolve({ code, signal, killedAtFile, stdout, stderr });
    });
  });
}

void describe("CLI 制品", () => {
  void it("通过同一契约提供简体中文帮助和正式命令", () => {
    const result = runCli("--help");

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /初始化/);
    assert.match(result.stdout, /状态/);
    assert.match(result.stdout, /检查/);
    assert.match(result.stdout, /schema/);
  });

  void it("在已确认的 .l10n 布局建立配置、锁和原文基线", async (t) => {
    const project = await createProject(t);
    const stateDirectory = join(project.directory, ".l10n");

    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );

    assert.equal(initialized.status, 0, initialized.stderr);
    await readFile(join(stateDirectory, "lock.json"), "utf8");
    await readFile(
      join(stateDirectory, "upstream/source-baseline.json"),
      "utf8",
    );
  });

  void it("输出 CLI 契约生成的结构化 Schema", () => {
    const result = runCli("schema", "--output-format", "structured");

    assert.equal(result.status, 0, result.stderr);
    const envelope: unknown = JSON.parse(result.stdout);
    assert.equal(typeof envelope, "object");
    assert.notEqual(envelope, null);
    assert.equal((envelope as { readonly kind?: unknown }).kind, "data");
    assert.match(result.stdout, /schemaVersion/);
    assert.match(result.stdout, /status/);
  });

  void it("初始化保留现有译文并记录缺失消息，状态查询无需 JAR", async (t) => {
    const project = await createProject(t);
    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );

    assert.equal(initialized.status, 0, initialized.stderr);
    const initData = readReport(initialized.stdout).summary as Record<
      string,
      unknown
    >;
    assert.equal(initData?.pendingTranslations, 1);
    assert.equal(initData?.messages, 4);
    assert.equal(initData?.resourceFiles, 4);

    const target = await readFile(
      join(project.directory, "lang/zh.yml"),
      "utf8",
    );
    assert.match(target, /greeting: 你好/);
    assert.match(target, /welcome: Welcome/);
    assert.match(target, /第一项/);
    assert.match(target, /第二项/);
    assert.match(target, /registered: 已注册/);

    const savedState = await readFile(
      join(project.directory, ".l10n/lock.json"),
      "utf8",
    );
    await rename(project.jarFile, `${project.jarFile}.unavailable`);
    const statusFiles = [
      join(project.directory, "lang/zh.yml"),
      join(project.directory, ".l10n/upstream/source-baseline.json"),
      join(project.directory, ".l10n/lock.json"),
    ];
    const beforeStatus = await Promise.all(
      statusFiles.map((file) => readFile(file)),
    );
    const status = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );

    assert.equal(status.status, 0, status.stderr);
    const statusData = readReport(status.stdout).summary as Record<
      string,
      unknown
    >;
    assert.equal(statusData?.pendingTranslations, 1);
    assert.equal(statusData?.modifiedTranslations, 0);
    assert.match(savedState, /jarSha256/);
    const afterStatus = await Promise.all(
      statusFiles.map((file) => readFile(file)),
    );
    for (let index = 0; index < beforeStatus.length; index += 1) {
      assert.deepEqual(afterStatus[index], beforeStatus[index]);
    }
    const textStatus = runCli("status", "--project", project.directory);
    assert.equal(textStatus.status, 0, textStatus.stderr);
    assert.match(textStatus.stdout, /待翻译 1 条/);

    await writeFile(
      join(project.directory, "lang/zh.yml"),
      target.replace("welcome: Welcome", "welcome: 欢迎"),
    );
    const editedStatus = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(editedStatus.status, 0, editedStatus.stderr);
    const editedSummary = readReport(editedStatus.stdout).summary as Record<
      string,
      unknown
    >;
    assert.equal(editedSummary.pendingTranslations, 0);
    assert.equal(editedSummary.modifiedTranslations, 1);

    const files = [
      join(project.directory, "lang/zh.yml"),
      join(project.directory, ".l10n/upstream/source-baseline.json"),
      join(project.directory, ".l10n/lock.json"),
    ];
    const before = await Promise.all(files.map((file) => readFile(file)));
    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${config}\nrules:\n  minimessage-syntax:\n    enabled: false\n`,
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(checked.status, 1, checked.stderr);
    const check = readReport(checked.stderr || checked.stdout);
    assert.equal(check.state, "incomplete");
    assert.equal((check.coverage as Record<string, unknown>).complete, false);
    assert.ok(
      (
        (check.coverage as Record<string, unknown>)
          .unavailableCapabilities as string[]
      ).some((capability) => capability.includes("Bedrock")),
    );
    const after = await Promise.all(files.map((file) => readFile(file)));
    for (let index = 0; index < before.length; index += 1) {
      assert.deepEqual(after[index], before[index]);
    }
  });

  void it("初始化保留已有的错误类型译文并继续报告结构诊断", async (t) => {
    const project = await createProject(t);
    const targetPath = join(project.directory, "lang/zh.yml");
    const original = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      original.replace("greeting: 你好", "greeting: [旧中文一, 旧中文二]"),
    );

    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );

    assert.equal(initialized.status, 0, initialized.stderr);
    const preserved = await readFile(targetPath, "utf8");
    assert.match(preserved, /greeting: \[\s*旧中文一, 旧中文二\s*\]/);
    const initReport = readReport(initialized.stdout);
    const initDiagnostics = initReport.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.ok(
      initDiagnostics.some(
        (diagnostic) => diagnostic.code === "message.type-mismatch",
      ),
    );

    const status = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(status.status, 1);
    assert.match(status.stdout || status.stderr, /message.type-mismatch/);
    assert.match(
      await readFile(targetPath, "utf8"),
      /greeting: \[\s*旧中文一, 旧中文二\s*\]/,
    );
  });

  void it("已有消息路径为对象时保留结构，并只补写安全缺失项", async (t) => {
    const project = await createProject(t);
    const targetPath = join(project.directory, "lang/zh.yml");
    await writeFile(
      targetPath,
      [
        "messages:",
        "  greeting:",
        "    text: 旧中文",
        "  commands:",
        "    registered: 已注册",
        "list:",
        "  entries: [第一项, 第二项]",
        "",
      ].join("\n"),
    );

    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );

    assert.equal(initialized.status, 0, initialized.stderr);
    const report = readReport(initialized.stdout);
    assert.equal(report.state, "issues");
    assert.equal(
      (report.summary as Record<string, unknown>).pendingTranslations,
      1,
    );
    assert.equal(
      (report.summary as Record<string, unknown>).missingTranslations,
      0,
    );
    assert.ok(
      (report.diagnostics as Array<Record<string, unknown>>).some(
        (item) => item.code === "message.type-mismatch",
      ),
    );
    const target = await readFile(targetPath, "utf8");
    assert.match(target, /text: 旧中文/);
    assert.match(target, /welcome: Welcome/);
    const lock = JSON.parse(
      await readFile(join(project.directory, ".l10n/lock.json"), "utf8"),
    ) as { readonly translationSeeds: readonly unknown[] };
    assert.equal(lock.translationSeeds.length, 1);
    const baseline = JSON.parse(
      await readFile(
        join(project.directory, ".l10n/upstream/source-baseline.json"),
        "utf8",
      ),
    ) as {
      readonly mappings: readonly {
        readonly sourceValue: {
          readonly messages: { readonly greeting: string };
        };
      }[];
    };
    assert.equal(baseline.mappings[0]?.sourceValue.messages.greeting, "Hello");
    const status = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(status.status, 1);
    assert.match(status.stdout || status.stderr, /message.type-mismatch/);
    assert.match(await readFile(targetPath, "utf8"), /text: 旧中文/);
  });

  void it("消息路径的字符串或列表祖先保持原样并建立质量基线", async (t) => {
    for (const ancestor of ["旧中文", "[旧中文一, 旧中文二]"]) {
      const project = await createProject(t);
      const targetPath = join(project.directory, "lang/zh.yml");
      const original = `messages: ${ancestor}\nlist:\n  entries: [第一项, 第二项]\n`;
      await writeFile(targetPath, original);

      const initialized = runCli(
        "init",
        "--project",
        project.directory,
        "--jar",
        project.jarFile,
        "--output-format",
        "structured",
      );

      assert.equal(initialized.status, 0, initialized.stderr);
      assert.equal(await readFile(targetPath, "utf8"), original);
      const report = readReport(initialized.stdout);
      assert.equal(report.state, "issues");
      assert.equal(
        (report.summary as Record<string, unknown>).missingTranslations,
        0,
      );
      assert.ok(
        (report.diagnostics as Array<Record<string, unknown>>).some(
          (item) => item.code === "message.type-mismatch",
        ),
      );
      const lock = JSON.parse(
        await readFile(join(project.directory, ".l10n/lock.json"), "utf8"),
      ) as { readonly translationSeeds: readonly unknown[] };
      assert.equal(lock.translationSeeds.length, 0);
      const baseline = JSON.parse(
        await readFile(
          join(project.directory, ".l10n/upstream/source-baseline.json"),
          "utf8",
        ),
      ) as {
        readonly mappings: readonly {
          readonly sourceValue: {
            readonly messages: { readonly greeting: string };
          };
        }[];
      };
      assert.equal(
        baseline.mappings[0]?.sourceValue.messages.greeting,
        "Hello",
      );
    }
  });

  void it("资源清单不匹配时拒绝初始化且不留下目标或锁文件", async (t) => {
    const project = await createProject(t);
    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "  - path: settings.yml\n    purpose: configuration\n",
        "",
      ),
    );

    const result = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );

    assert.equal(result.status, 1);
    const failure = readEnvelope(result.stdout || result.stderr);
    assert.equal(failure.kind, "failure");
    assert.match(result.stdout || result.stderr, /settings.yml/);
    await assert.rejects(readFile(join(project.directory, ".l10n/lock.json")));
    const target = await readFile(
      join(project.directory, "lang/zh.yml"),
      "utf8",
    );
    assert.match(target, /greeting: 你好/);
    assert.doesNotMatch(target, /welcome:/);
  });

  void it("检查报告定位额外受管理消息且不改写项目文件", async (t) => {
    const project = await createProject(t);
    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(initialized.status, 0, initialized.stderr);

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace(
        "  welcome: Welcome",
        "  welcome: Welcome\n  obsolete: 旧键",
      ),
    );
    const files = [
      targetPath,
      join(project.directory, ".l10n/upstream/source-baseline.json"),
      join(project.directory, ".l10n/lock.json"),
    ];
    const before = await Promise.all(files.map((file) => readFile(file)));
    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${config}\nrules:\n  minimessage-syntax:\n    enabled: false\n`,
    );
    const result = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );

    assert.equal(result.status, 1);
    const report = readReport(result.stdout || result.stderr);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.ok(
      diagnostics.some((diagnostic) => diagnostic.code === "message.extra"),
    );
    assert.ok(
      diagnostics.some((diagnostic) =>
        JSON.stringify(diagnostic).includes("obsolete"),
      ),
    );
    const after = await Promise.all(files.map((file) => readFile(file)));
    for (let index = 0; index < before.length; index += 1) {
      assert.deepEqual(after[index], before[index]);
    }
  });

  void it("影响维护范围的声明变化报告尚未同步", async (t) => {
    const project = await createProject(t);
    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(initialized.status, 0, initialized.stderr);

    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace('targetLanguage: "zh-CN"', 'targetLanguage: "zh-Hans"'),
    );
    const stale = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(stale.status, 1);
    assert.match(stale.stdout || stale.stderr, /需重新初始化/);
  });

  void it("允许 JAR 原文路径与本地中文目标路径同名", async (t) => {
    const project = await createProject(t);
    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace("target: lang/zh.yml", "target: lang/en.yml"),
    );
    const targetPath = join(project.directory, "lang/en.yml");
    await writeFile(
      targetPath,
      "messages:\n  greeting: 既有中文\n  commands:\n    registered: 已注册\nlist:\n  entries: [甲, 乙]\n",
    );

    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );

    assert.equal(initialized.status, 0, initialized.stderr);
    const savedTarget = await readFile(targetPath, "utf8");
    assert.match(savedTarget, /greeting: 既有中文/);
    assert.match(savedTarget, /welcome: Welcome/);
    assert.doesNotMatch(savedTarget, /greeting: Hello/);
  });

  void it("目标路径与字段类别变化时仍使用原文资源和字段身份", async (t) => {
    const scalarProject = await createProject(t);
    const scalarConfigPath = join(scalarProject.directory, ".l10n/config.yml");
    const scalarConfig = await readFile(scalarConfigPath, "utf8");
    await writeFile(
      scalarConfigPath,
      scalarConfig.replace(
        "        - path: [messages]\n          category: chat-string\n        - path: [list, entries]\n          category: chat-string-list",
        "        - path: [messages, greeting]\n          category: chat-string",
      ),
    );
    await rm(join(scalarProject.directory, "lang/zh.yml"));
    const scalarInit = runCli(
      "init",
      "--project",
      scalarProject.directory,
      "--jar",
      scalarProject.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(scalarInit.status, 0, scalarInit.stderr);

    const listProject = await createProject(t);
    const listConfigPath = join(listProject.directory, ".l10n/config.yml");
    const listConfig = await readFile(listConfigPath, "utf8");
    await writeFile(
      listConfigPath,
      listConfig
        .replace("target: lang/zh.yml", "target: lang/zh-new.yml")
        .replace(
          "        - path: [messages]\n          category: chat-string\n        - path: [list, entries]\n          category: chat-string-list",
          "        - path: [messages, greeting]\n          category: chat-string-list",
        ),
    );
    await writeFile(
      listProject.jarFile,
      zipSync({
        "lang/en.yml": strToU8("messages:\n  greeting: [Hello]\n"),
        "plugin.yml": strToU8("name: Lands\n"),
        "settings.yml": strToU8("enabled: true\n"),
        "bedrock/lang/en_us.json": strToU8("not parsed by the first scope\n"),
        "me/lands/Plugin.class": strToU8("class bytes"),
      }),
    );
    const listInit = runCli(
      "init",
      "--project",
      listProject.directory,
      "--jar",
      listProject.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(listInit.status, 0, listInit.stderr);

    const scalarLock = JSON.parse(
      await readFile(join(scalarProject.directory, ".l10n/lock.json"), "utf8"),
    ) as { readonly translationSeeds: readonly { readonly id: string }[] };
    const listLock = JSON.parse(
      await readFile(join(listProject.directory, ".l10n/lock.json"), "utf8"),
    ) as { readonly translationSeeds: readonly { readonly id: string }[] };
    assert.equal(scalarLock.translationSeeds.length, 1);
    assert.equal(listLock.translationSeeds.length, 1);
    assert.equal(
      scalarLock.translationSeeds[0]?.id,
      listLock.translationSeeds[0]?.id,
    );
  });

  void it("SIGKILL 后重试先回滚残留，再建立完整待翻译状态", async (t) => {
    const project = await createInterruptedProject(t);
    const interrupted = await killInitWhenFileAppears(
      project,
      project.targetPaths[0]!,
    );
    assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
    assert.equal(interrupted.killedAtFile, true);

    const presentTargets = await Promise.all(
      project.targetPaths.map(async (target) => {
        try {
          await readFile(join(project.directory, target));
          return true;
        } catch {
          return false;
        }
      }),
    );
    const partialCount = presentTargets.filter(Boolean).length;
    assert.ok(partialCount > 0 && partialCount < project.targetPaths.length);

    const retried = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(retried.status, 0, retried.stderr);
    const summary = readReport(retried.stdout).summary as Record<
      string,
      unknown
    >;
    assert.equal(summary.messages, project.targetPaths.length);
    assert.equal(summary.pendingTranslations, project.targetPaths.length);
    assert.equal(summary.sameTextCandidates, 0);
    const lock = JSON.parse(
      await readFile(join(project.directory, ".l10n/lock.json"), "utf8"),
    ) as {
      readonly translationSeeds: readonly unknown[];
      readonly sameTextCandidates: readonly unknown[];
    };
    assert.equal(lock.translationSeeds.length, project.targetPaths.length);
    assert.equal(lock.sameTextCandidates.length, 0);
  });

  void it("只读查询拒绝尚未提交的晚期事务，并保持文件不变", async (t) => {
    const project = await createInterruptedProject(t);
    const interrupted = await killInitWhenFileAppears(
      project,
      ".l10n/lock.json",
    );
    assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
    assert.equal(interrupted.killedAtFile, true);
    const transactionPath = join(project.directory, ".l10n/transaction.json");
    const transaction = JSON.parse(await readFile(transactionPath, "utf8")) as {
      readonly phase: string;
    };
    assert.equal(transaction.phase, "prepared");

    const before = await snapshotProjectFiles(project.directory);
    for (const command of ["status", "check"]) {
      const result = runCli(
        command,
        "--project",
        project.directory,
        "--output-format",
        "structured",
      );
      assert.equal(result.status, 1, result.stderr);
      const report = readReport(result.stderr || result.stdout);
      assert.equal(report.state, "issues");
      assert.ok(
        (report.diagnostics as Array<Record<string, unknown>>).some(
          (item) => item.code === "transaction.prepared",
        ),
      );
      assert.deepEqual(await snapshotProjectFiles(project.directory), before);
    }

    const retried = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(retried.status, 0, retried.stderr);
    const summary = readReport(retried.stdout).summary as Record<
      string,
      unknown
    >;
    assert.equal(summary.pendingTranslations, project.targetPaths.length);
    assert.equal(summary.sameTextCandidates, 0);
  });

  void it("只读查询接受已提交但尚未清理的事务", async (t) => {
    const project = await createInterruptedProject(t, 300);
    const interrupted = await killInitWhenFileAppears(
      project,
      ".l10n/transaction.json",
      (contents) =>
        (JSON.parse(contents) as { readonly phase: string }).phase ===
        "committed",
    );
    assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
    assert.equal(interrupted.killedAtFile, true);
    const transactionPath = join(project.directory, ".l10n/transaction.json");
    const transaction = JSON.parse(await readFile(transactionPath, "utf8")) as {
      readonly phase: string;
    };
    assert.equal(transaction.phase, "committed");

    const before = await snapshotProjectFiles(project.directory);
    for (const command of ["status", "check"]) {
      const result = runCli(
        command,
        "--project",
        project.directory,
        "--output-format",
        "structured",
      );
      const report = readReport(result.stderr || result.stdout);
      assert.ok(
        !(report.diagnostics as Array<Record<string, unknown>>).some(
          (item) => item.code === "transaction.prepared",
        ),
      );
      if (command === "status") assert.equal(result.status, 0, result.stderr);
      else assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(await snapshotProjectFiles(project.directory), before);
    }
  });

  void it("中断后出现并行编辑时拒绝恢复且保留编辑内容", async (t) => {
    const project = await createInterruptedProject(t);
    const targetPath = project.targetPaths[0]!;
    const interrupted = await killInitWhenFileAppears(project, targetPath);
    assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
    assert.equal(interrupted.killedAtFile, true);

    const targetFile = join(project.directory, targetPath);
    const parallelEdit = "messages:\n  greeting: 并行编辑\n";
    await writeFile(targetFile, parallelEdit);
    const retried = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );

    assert.equal(retried.status, 1);
    assert.match(retried.stdout || retried.stderr, /中断|并行编辑/);
    assert.equal(await readFile(targetFile, "utf8"), parallelEdit);
    await assert.rejects(readFile(join(project.directory, ".l10n/lock.json")));
    await assert.rejects(
      readFile(join(project.directory, ".l10n/upstream/source-baseline.json")),
    );
  });

  void it("初始化拒绝重复 YAML 键且不留下任何基线文件", async (t) => {
    const project = await createProject(t);
    await writeFile(
      project.jarFile,
      zipSync({
        "lang/en.yml": strToU8(
          "messages:\n  greeting: Hello\n  greeting: Duplicate\n",
        ),
        "plugin.yml": strToU8("name: Lands\n"),
        "settings.yml": strToU8("enabled: true\n"),
        "bedrock/lang/en_us.json": strToU8("not parsed by the first scope\n"),
        "me/lands/Plugin.class": strToU8("class bytes"),
      }),
    );
    const result = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout || result.stderr, /重复|duplicate/i);
    await assert.rejects(
      readFile(join(project.directory, ".l10n/upstream/source-baseline.json")),
    );
    await assert.rejects(readFile(join(project.directory, ".l10n/lock.json")));
  });

  void it("初始化提交前发现并行编辑并保留编辑者内容", async (t) => {
    const project = await createProject(t);
    const targetPath = join(project.directory, "lang/zh.yml");

    await assert.rejects(
      initializeProject(project.directory, project.jarFile, {
        beforeApply: async () => {
          const current = await readFile(targetPath, "utf8");
          await writeFile(
            targetPath,
            current.replace("greeting: 你好", "greeting: 并行编辑"),
          );
        },
      }),
      /并行编辑/,
    );

    assert.match(await readFile(targetPath, "utf8"), /greeting: 并行编辑/);
    await assert.rejects(
      readFile(join(project.directory, ".l10n/upstream/source-baseline.json")),
    );
    await assert.rejects(readFile(join(project.directory, ".l10n/lock.json")));
  });

  void it("规则策略变更不要求重建基线，但禁用结构规则会显示为不完整", async (t) => {
    const project = await createProject(t);
    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(initialized.status, 0, initialized.stderr);

    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${config}\nrules:\n  structure:\n    enabled: false\n  minimessage-syntax:\n    enabled: false\n  future-check:\n    enabled: true\n    severity: warning\n    parameters:\n      mode: strict\n`,
    );
    const status = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(status.status, 0, status.stderr);

    const check = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(check.status, 1);
    const report = readReport(check.stdout || check.stderr);
    const coverage = report.coverage as Record<string, unknown>;
    assert.deepEqual(coverage.disabledRuleIds, [
      "minimessage-syntax",
      "structure",
    ]);
    assert.deepEqual(coverage.unsupportedRuleIds, ["future-check"]);
    assert.equal(coverage.complete, false);
  });

  void it("同步锁内部状态不一致时拒绝状态查询", async (t) => {
    const project = await createProject(t);
    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(initialized.status, 0, initialized.stderr);

    const lockPath = join(project.directory, ".l10n/lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as Record<
      string,
      unknown
    >;
    lock.translationSeeds = [];
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const status = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(status.status, 1);
    assert.match(status.stdout || status.stderr, /锁文件校验/);
  });

  void it("历史同文只记录候选，不标为待翻译或已审核", async (t) => {
    const project = await createProject(t);
    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace("greeting: 你好", "greeting: Hello"),
    );

    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    const summary = readReport(initialized.stdout).summary as Record<
      string,
      unknown
    >;
    assert.equal(summary.pendingTranslations, 1);
    assert.equal(summary.sameTextCandidates, 1);

    const status = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(status.status, 0, status.stderr);
    const statusSummary = readReport(status.stdout).summary as Record<
      string,
      unknown
    >;
    assert.equal(statusSummary.sameTextCandidates, 1);
  });

  void it("只把配置用途的主题作为主题输入，Bedrock 同名资源保持排除", async (t) => {
    const project = await createProject(t, {
      theme: 'theme:\n  tokens:\n    regular: "<gray>"\n',
      bedrockTheme:
        "theme:\n  tokens:\n    regular: '<gray>'\n    regular: '<red>'\n",
    });
    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );

    assert.equal(initialized.status, 0, initialized.stderr);
    const baseline = JSON.parse(
      await readFile(
        join(project.directory, ".l10n/upstream/source-baseline.json"),
        "utf8",
      ),
    ) as {
      readonly miniMessageTheme?: {
        readonly file: string;
        readonly source: string;
      };
    };
    assert.equal(baseline.miniMessageTheme?.file, "Locale/theme.yml");
    assert.match(baseline.miniMessageTheme?.source ?? "", /regular/u);
  });

  void it("初始化阻断主题 YAML 歧义且不改写项目文件", async (t) => {
    const project = await createProject(t, {
      theme: 'theme:\n  tokens:\n    regular: "<gray>"\n    regular: "<red>"\n',
    });
    const before = await snapshotProjectFiles(project.directory);
    const rejected = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );

    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr || rejected.stdout, /主题 YAML 无法安全读取/u);
    assert.deepEqual(await snapshotProjectFiles(project.directory), before);
  });

  void it("Java 缺失时完整检查未完成，初始化和状态仍使用 Node", async (t) => {
    const project = await createProject(t);
    const initialized = runCliWithoutJava(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(initialized.status, 0, initialized.stderr);

    const status = runCliWithoutJava(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(status.status, 0, status.stderr);
    const checked = runCliWithoutJava(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(checked.status, 1, checked.stderr);
    const report = readReport(checked.stderr || checked.stdout);
    const coverage = report.coverage as Record<string, unknown>;
    assert.equal(coverage.complete, false);
    assert.match(
      JSON.stringify(coverage.unavailableCapabilities),
      /Java 运行环境/u,
    );
  });
});
