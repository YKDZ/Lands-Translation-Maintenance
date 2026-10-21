import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliFile = resolve(packageDirectory, "dist/cli.js");

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [cliFile, ...args], {
    encoding: "utf8",
  });
}

function runCliWithoutPath(...args: string[]) {
  return spawnSync(process.execPath, [cliFile, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
}

async function writeJar(
  jarFile: string,
  options: {
    readonly source?: string;
    readonly settings?: string;
    readonly includeSettings?: boolean;
    readonly extra?: Readonly<Record<string, string>>;
  } = {},
) {
  const resources: Record<string, Uint8Array> = {
    "lang/en.yml": strToU8(
      options.source ??
        [
          "messages:",
          "  greeting: Hello",
          "  welcome: Welcome",
          "  commands:",
          "    registered: Run",
          "list:",
          "  entries: [first, second]",
          "",
        ].join("\n"),
    ),
    "plugin.yml": strToU8("name: Lands\n"),
    "bedrock/lang/en_us.json": strToU8("not parsed by the first scope\n"),
    "me/lands/Plugin.class": strToU8("class bytes"),
  };
  if (options.includeSettings !== false) {
    resources["settings.yml"] = strToU8(options.settings ?? "enabled: true\n");
  }
  for (const [path, content] of Object.entries(options.extra ?? {})) {
    resources[path] = strToU8(content);
  }
  await writeFile(jarFile, zipSync(resources));
}

async function createProject(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "lands-l10n-cli-"));
  t.after(async () => rm(directory, { force: true, recursive: true }));

  const jarFile = join(directory, "Lands.jar");
  await mkdir(join(directory, "lang"), { recursive: true });
  await mkdir(join(directory, ".l10n"), { recursive: true });
  await writeFile(
    jarFile,
    zipSync({
      "lang/en.yml": strToU8(
        [
          "messages:",
          "  greeting: Hello",
          "  welcome: Welcome",
          "  commands:",
          "    registered: Run",
          "list:",
          "  entries: [first, second]",
          "",
        ].join("\n"),
      ),
      "plugin.yml": strToU8("name: Lands\n"),
      "settings.yml": strToU8("enabled: true\n"),
      "bedrock/lang/en_us.json": strToU8("not parsed by the first scope\n"),
      "me/lands/Plugin.class": strToU8("class bytes"),
    }),
  );
  await writeFile(
    join(directory, ".l10n/config.yml"),
    [
      "schemaVersion: 1",
      "source:",
      '  version: "8.0.1"',
      '  translationHistory: "b8f6985a4ad2af1b76b05f0f79b718a2234623ad"',
      "resources:",
      "  - path: lang/en.yml",
      "    purpose: chat-language",
      "  - path: plugin.yml",
      "    purpose: metadata",
      "  - path: settings.yml",
      "    purpose: configuration",
      "  - path: bedrock/lang/en_us.json",
      "    purpose: bedrock-excluded",
      "translationScope:",
      '  sourceLanguage: "en-US"',
      '  targetLanguage: "zh-CN"',
      "  mappings:",
      "    - source: lang/en.yml",
      "      target: lang/zh.yml",
      "      fields:",
      "        - path: [messages]",
      "          category: chat-string",
      "        - path: [list, entries]",
      "          category: chat-string-list",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "lang/zh.yml"),
    [
      "messages:",
      "  greeting: 你好",
      "  commands:",
      "    registered: 已注册",
      "list:",
      "  entries:",
      "    - 第一项",
      "    - 第二项",
      "",
    ].join("\n"),
  );

  return { directory, jarFile };
}

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
      "",
    ].join("\n"),
  );

  return { directory, jarFile, targetPaths };
}

function killInitWhenTargetAppears(
  project: { readonly directory: string; readonly jarFile: string },
  targetPath: string,
) {
  return new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly killedAtTarget: boolean;
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
    let killedAtTarget = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const watcher = watch(join(project.directory, "lang"), (_event, name) => {
      if (name?.toString() === basename(targetPath)) {
        killedAtTarget = child.kill("SIGKILL");
      }
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 20_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      watcher.close();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      watcher.close();
      resolve({ code, signal, killedAtTarget, stdout, stderr });
    });
  });
}

function readEnvelope(stdout: string) {
  return JSON.parse(stdout) as {
    readonly kind?: unknown;
    readonly variant?: unknown;
    readonly data?: Record<string, unknown>;
  };
}

function readReport(output: string) {
  return readEnvelope(output).data?.report as Record<string, unknown>;
}

void describe("CLI 制品", () => {
  void it("通过同一契约提供简体中文帮助和正式命令", () => {
    const result = runCli("--help");

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /初始化/);
    assert.match(result.stdout, /状态/);
    assert.match(result.stdout, /检查/);
    assert.match(result.stdout, /sync/);
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

  void it("sync --dry-run 返回可应用的结构化计划且不写入项目", async (t) => {
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
    const targetBeforeFormatting = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      targetBeforeFormatting.replace(/^ {2}/gm, "    "),
    );
    const files = [
      targetPath,
      join(project.directory, ".l10n/upstream/source-baseline.json"),
      join(project.directory, ".l10n/lock.json"),
    ];
    const before = await Promise.all(files.map((file) => readFile(file)));
    const preview = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(preview.status, 0, preview.stderr);
    const envelope = readEnvelope(preview.stdout);
    assert.equal(envelope.kind, "data");
    const plan = envelope.data?.plan as Record<string, unknown>;
    assert.equal(typeof plan?.sourceVersion, "string");
    assert.equal(Array.isArray(plan?.messages), true);
    assert.equal(Array.isArray(plan?.writes), true);
    assert.equal(Array.isArray(plan?.inputSnapshots), true);
    const targetPlan = (
      plan.targetFiles as readonly Record<string, unknown>[]
    ).find(({ path }) => path === "lang/zh.yml");
    assert.equal(targetPlan?.action, "unchanged");
    assert.equal(targetPlan?.contentSha256, targetPlan?.expectedSha256);
    const inputSnapshots = plan.inputSnapshots as readonly Record<
      string,
      unknown
    >[];
    const snapshotPaths = new Set(inputSnapshots.map(({ path }) => path));
    for (const path of [
      join(project.directory, ".l10n/config.yml"),
      project.jarFile,
      join(project.directory, "lang/zh.yml"),
      join(project.directory, ".l10n/upstream/source-baseline.json"),
      join(project.directory, ".l10n/lock.json"),
    ]) {
      assert.ok(
        snapshotPaths.has(path),
        `${path} 不在计划输入快照中：${JSON.stringify([...snapshotPaths])}`,
      );
    }
    assert.ok(
      inputSnapshots.every(({ sha256: digest }) =>
        /^[0-9a-f]{64}$/.test(digest as string),
      ),
    );
    const welcome = (plan.messages as readonly Record<string, unknown>[]).find(
      ({ path }) => JSON.stringify(path) === '["messages","welcome"]',
    );
    assert.ok(
      (plan.pendingTranslations as readonly string[]).includes(
        welcome?.id as string,
      ),
    );
    const readable = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
    );
    assert.equal(readable.status, 0, readable.stderr);
    assert.match(readable.stdout, /待翻译总数 1 条/);
    assert.match(readable.stdout, /保留译文（原文未变）/);
    assert.match(readable.stdout, /保留译文（原文未变；待翻译）/);
    assert.match(readable.stdout, /预演未写入项目/);
    const after = await Promise.all(files.map((file) => readFile(file)));
    for (let index = 0; index < before.length; index += 1) {
      assert.deepEqual(after[index], before[index]);
    }
  });

  void it("未指定 --dry-run 时明确说明实际同步尚未交付", async (t) => {
    const project = await createProject(t);
    const result = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout || result.stderr, /实际同步尚未交付/);
  });

  void it("完整资源差异先阻断，消费者更新清单后可预演且未维护资源只观察", async (t) => {
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

    await writeJar(project.jarFile, {
      includeSettings: false,
      extra: { "readme.md": "newly declared documentation\n" },
    });
    const paths = [
      join(project.directory, ".l10n/config.yml"),
      join(project.directory, "lang/zh.yml"),
      join(project.directory, ".l10n/upstream/source-baseline.json"),
      join(project.directory, ".l10n/lock.json"),
    ];
    const beforeBlocked = await Promise.all(
      paths.map((path) => readFile(path)),
    );
    const blocked = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(blocked.status, 1, blocked.stderr);
    const blockedResult = readEnvelope(blocked.stdout || blocked.stderr);
    assert.equal(blockedResult.kind, "failure");
    const blockedPreview = blockedResult.data?.preview as Record<
      string,
      unknown
    >;
    assert.deepEqual(
      (blockedPreview.resourceDifference as Record<string, unknown>).undeclared,
      ["readme.md"],
    );
    assert.deepEqual(
      (blockedPreview.resourceDifference as Record<string, unknown>).missing,
      ["settings.yml"],
    );
    const afterBlocked = await Promise.all(paths.map((path) => readFile(path)));
    for (let index = 0; index < beforeBlocked.length; index += 1) {
      assert.deepEqual(afterBlocked[index], beforeBlocked[index]);
    }

    const configPath = paths[0]!;
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "  - path: settings.yml\n    purpose: configuration\n",
        "  - path: readme.md\n    purpose: documentation\n",
      ),
    );
    const beforeAccepted = await Promise.all(
      paths.map((path) => readFile(path)),
    );
    const accepted = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(accepted.status, 0, accepted.stderr);
    const plan = readEnvelope(accepted.stdout).data?.plan as Record<
      string,
      unknown
    >;
    const changes = plan.resourceChanges as Record<string, unknown>;
    assert.deepEqual(changes.added, ["readme.md"]);
    assert.deepEqual(changes.removed, ["settings.yml"]);
    assert.deepEqual((changes.observedOnly as Record<string, unknown>).added, [
      "readme.md",
    ]);
    assert.deepEqual(
      (changes.observedOnly as Record<string, unknown>).removed,
      ["settings.yml"],
    );
    const writeKinds = (plan.writes as readonly Record<string, unknown>[]).map(
      ({ kind }) => kind,
    );
    assert.equal(writeKinds.length, 2);
    assert.ok(writeKinds.includes("baseline"));
    assert.ok(writeKinds.includes("lock"));
    const afterAccepted = await Promise.all(
      paths.map((path) => readFile(path)),
    );
    for (let index = 0; index < beforeAccepted.length; index += 1) {
      assert.deepEqual(afterAccepted[index], beforeAccepted[index]);
    }
  });

  void it("按解析值严格保留或重置消息，列表整体比较并计划增删", async (t) => {
    const project = await createProject(t);
    await writeJar(project.jarFile, {
      source: [
        "messages:",
        '  greeting: "Hello"',
        '  welcome: "Welcome"',
        "  commands:",
        '    registered: "Run <red>now</red>"',
        "    multiline: Line one Line two",
        "    leaving: Farewell",
        "list:",
        "  entries: [first, second]",
        "",
      ].join("\n"),
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
    await writeFile(
      join(project.directory, "lang/zh.yml"),
      [
        "messages:",
        "  greeting: 你好",
        "  welcome: 欢迎",
        "  commands:",
        "    registered: 已注册",
        "    multiline: 多行译文",
        "    leaving: 再见",
        "list:",
        "  entries: [第一项, 第二项]",
        "",
      ].join("\n"),
    );
    const targetPath = join(project.directory, "lang/zh.yml");
    const baselinePath = join(
      project.directory,
      ".l10n/upstream/source-baseline.json",
    );
    const lockPath = join(project.directory, ".l10n/lock.json");
    const before = await Promise.all(
      [targetPath, baselinePath, lockPath].map((path) => readFile(path)),
    );
    await writeJar(project.jarFile, {
      source: [
        "messages:",
        "    greeting: Hello",
        '    welcome: "Welcome "',
        "    commands:",
        '        registered: "Run <green>now</green>"',
        "        multiline: |-",
        "            Line one",
        "            Line two",
        "        added: New line",
        "list:",
        "    entries: [second, extra]",
        "",
      ].join("\n"),
    });
    const result = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(result.status, 0, result.stderr);
    const plan = readEnvelope(result.stdout).data?.plan as Record<
      string,
      unknown
    >;
    const messages = plan.messages as readonly Record<string, unknown>[];
    const byPath = new Map(
      messages.map((message) => [JSON.stringify(message.path), message]),
    );
    assert.equal(byPath.get('["messages","greeting"]')?.action, "preserve");
    assert.equal(byPath.get('["messages","welcome"]')?.action, "reset");
    assert.equal(
      byPath.get('["messages","commands","registered"]')?.action,
      "reset",
    );
    assert.equal(
      byPath.get('["messages","commands","multiline"]')?.action,
      "reset",
    );
    assert.equal(
      byPath.get('["messages","commands","multiline"]')?.source,
      "Line one\nLine two",
    );
    assert.equal(
      byPath.get('["messages","commands","leaving"]')?.action,
      "delete",
    );
    assert.equal(byPath.get('["messages","commands","added"]')?.action, "seed");
    const list = byPath.get('["list","entries"]');
    assert.equal(list?.action, "reset");
    assert.deepEqual(list?.previousTarget, ["第一项", "第二项"]);
    assert.deepEqual(list?.source, ["second", "extra"]);
    assert.deepEqual(list?.target, ["second", "extra"]);
    assert.equal(
      (plan.writes as readonly Record<string, unknown>[]).some(
        ({ kind }) => kind === "target",
      ),
      true,
    );
    const after = await Promise.all(
      [targetPath, baselinePath, lockPath].map((path) => readFile(path)),
    );
    for (let index = 0; index < before.length; index += 1) {
      assert.deepEqual(after[index], before[index]);
    }
  });

  void it("映射字段类型变化沿用身份并重置整条消息", async (t) => {
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
      target.replace("welcome: Welcome", "welcome: 欢迎"),
    );

    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "        - path: [messages]\n          category: chat-string\n",
        [
          "        - path: [messages, greeting]",
          "          category: chat-string",
          "        - path: [messages, welcome]",
          "          category: chat-string-list",
          "        - path: [messages, commands]",
          "          category: chat-string",
          "",
        ].join("\n"),
      ),
    );
    await writeJar(project.jarFile, {
      source: [
        "messages:",
        "  greeting: Hello",
        "  welcome: [Welcome, again]",
        "  commands:",
        "    registered: Run",
        "list:",
        "  entries: [first, second]",
        "",
      ].join("\n"),
    });

    const preview = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(preview.status, 0, preview.stderr);
    const plan = readEnvelope(preview.stdout).data?.plan as Record<
      string,
      unknown
    >;
    const message = (plan.messages as readonly Record<string, unknown>[]).find(
      ({ path }) => JSON.stringify(path) === '["messages","welcome"]',
    );
    assert.equal(message?.action, "reset");
    assert.equal(message?.reason, "source-changed");
    assert.equal(message?.previousSource, "Welcome");
    assert.equal(message?.previousTarget, "欢迎");
    assert.deepEqual(message?.source, ["Welcome", "again"]);
    assert.deepEqual(message?.target, ["Welcome", "again"]);
  });

  void it("映射目标移动后按来源路径保留译文并计划新文件", async (t) => {
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
      config.replace("target: lang/zh.yml", "target: lang/zh-moved.yml"),
    );

    const preview = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(preview.status, 0, preview.stderr);
    const plan = readEnvelope(preview.stdout).data?.plan as Record<
      string,
      unknown
    >;
    assert.deepEqual(plan.unmanagedTargets, ["lang/zh.yml"]);
    assert.ok(
      (plan.messages as readonly Record<string, unknown>[]).every(
        ({ action }) => action === "preserve",
      ),
    );
    const targetWrite = (
      plan.writes as readonly Record<string, unknown>[]
    ).find(({ kind }) => kind === "target");
    assert.match(targetWrite?.path as string, /lang\/zh-moved\.yml$/);
    assert.match(targetWrite?.content as string, /greeting: 你好/);
    assert.match(targetWrite?.content as string, /registered: 已注册/);
    await assert.rejects(
      readFile(join(project.directory, "lang/zh-moved.yml")),
    );
  });

  void it("未维护资源内容变化只更新预演基线，不重置译文", async (t) => {
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
    const targetBefore = await readFile(targetPath);
    await writeJar(project.jarFile, { settings: "enabled: false\n" });

    const result = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(result.status, 0, result.stderr);
    const plan = readEnvelope(result.stdout).data?.plan as Record<
      string,
      unknown
    >;
    const changes = plan.resourceChanges as Record<string, unknown>;
    assert.deepEqual(changes.changed, ["settings.yml"]);
    assert.deepEqual(
      (changes.observedOnly as Record<string, unknown>).changed,
      ["settings.yml"],
    );
    assert.ok(
      (plan.messages as readonly Record<string, unknown>[]).every(
        ({ action }) => action === "preserve",
      ),
    );
    assert.equal(
      (plan.writes as readonly Record<string, unknown>[]).some(
        ({ kind }) => kind === "target",
      ),
      false,
    );
    assert.deepEqual(await readFile(targetPath), targetBefore);
  });

  void it("原文未变但目标字段缺失时计划填入英文并保留待翻译状态", async (t) => {
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
    await writeFile(targetPath, target.replace("  welcome: Welcome\n", ""));
    const before = await readFile(targetPath);

    const preview = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(preview.status, 0, preview.stderr);
    const plan = readEnvelope(preview.stdout).data?.plan as Record<
      string,
      unknown
    >;
    const message = (plan.messages as readonly Record<string, unknown>[]).find(
      ({ path }) => JSON.stringify(path) === '["messages","welcome"]',
    );
    assert.equal(message?.action, "seed");
    assert.equal(message?.reason, "missing-translation");
    assert.equal(message?.target, "Welcome");
    assert.ok(
      (plan.pendingTranslations as readonly string[]).includes(
        message?.id as string,
      ),
    );
    const targetWrite = (
      plan.writes as readonly Record<string, unknown>[]
    ).find(({ kind }) => kind === "target");
    assert.match(targetWrite?.content as string, /welcome: Welcome/);
    assert.deepEqual(await readFile(targetPath), before);
  });

  void it("移出最后一条维护映射后保留整份中文目标", async (t) => {
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
      config.replace(
        /  mappings:\n    - source: lang\/en\.yml\n      target: lang\/zh\.yml\n      fields:\n        - path: \[messages\]\n          category: chat-string\n        - path: \[list, entries\]\n          category: chat-string-list\n/,
        "  mappings: []\n",
      ),
    );
    const targetPath = join(project.directory, "lang/zh.yml");
    const targetBefore = await readFile(targetPath);

    const result = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(result.status, 0, result.stderr);
    const plan = readEnvelope(result.stdout).data?.plan as Record<
      string,
      unknown
    >;
    assert.deepEqual(plan.unmanagedTargets, ["lang/zh.yml"]);
    assert.deepEqual(plan.messages, []);
    assert.equal(
      (plan.writes as readonly Record<string, unknown>[]).some(
        ({ kind }) => kind === "target",
      ),
      false,
    );
    assert.deepEqual(await readFile(targetPath), targetBefore);
  });

  void it("预演更新原始主题 YAML 快照，不运行 Java MiniMessage 检查", async (t) => {
    const project = await createProject(t);
    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "  - path: bedrock/lang/en_us.json\n    purpose: bedrock-excluded\n",
        "  - path: lang/theme.yml\n    purpose: configuration\n  - path: bedrock/lang/en_us.json\n    purpose: bedrock-excluded\n",
      ),
    );
    const initialTheme = 'theme:\n  tokens:\n    accent: "<unknown>"\n';
    await writeJar(project.jarFile, {
      extra: { "lang/theme.yml": initialTheme },
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
    const baselinePath = join(
      project.directory,
      ".l10n/upstream/source-baseline.json",
    );
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
      readonly miniMessageTheme?: {
        readonly file: string;
        readonly source: string;
      };
    };
    assert.deepEqual(baseline.miniMessageTheme, {
      file: "lang/theme.yml",
      source: initialTheme,
    });

    const nextTheme = 'theme:\n  tokens:\n    accent: "<still-unknown>"\n';
    await writeJar(project.jarFile, {
      extra: { "lang/theme.yml": nextTheme },
    });
    const targetPath = join(project.directory, "lang/zh.yml");
    const lockPath = join(project.directory, ".l10n/lock.json");
    const beforePreview = await Promise.all(
      [targetPath, baselinePath, lockPath].map((path) => readFile(path)),
    );
    const preview = runCliWithoutPath(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(preview.status, 0, preview.stderr);
    const plan = readEnvelope(preview.stdout).data?.plan as Record<
      string,
      unknown
    >;
    const changes = plan.resourceChanges as Record<string, unknown>;
    assert.deepEqual(changes.changed, ["lang/theme.yml"]);
    assert.ok(
      (plan.messages as readonly Record<string, unknown>[]).every(
        ({ action }) => action === "preserve",
      ),
    );
    const writes = plan.writes as readonly Record<string, unknown>[];
    const writeKinds = writes.map(({ kind }) => kind);
    assert.equal(writeKinds.length, 2);
    assert.ok(writeKinds.includes("baseline"));
    assert.ok(writeKinds.includes("lock"));
    const candidateBaseline = JSON.parse(
      writes.find(({ kind }) => kind === "baseline")?.content as string,
    ) as {
      readonly miniMessageTheme?: {
        readonly file: string;
        readonly source: string;
      };
    };
    assert.deepEqual(candidateBaseline.miniMessageTheme, {
      file: "lang/theme.yml",
      source: nextTheme,
    });
    const afterPreview = await Promise.all(
      [targetPath, baselinePath, lockPath].map((path) => readFile(path)),
    );
    for (let index = 0; index < beforePreview.length; index += 1) {
      assert.deepEqual(afterPreview[index], beforePreview[index]);
    }
  });

  void it("主题 YAML 有重复键时阻断预演且不改写项目", async (t) => {
    const project = await createProject(t);
    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "  - path: bedrock/lang/en_us.json\n    purpose: bedrock-excluded\n",
        "  - path: lang/theme.yml\n    purpose: configuration\n  - path: bedrock/lang/en_us.json\n    purpose: bedrock-excluded\n",
      ),
    );
    await writeJar(project.jarFile, {
      extra: { "lang/theme.yml": "theme:\n  tokens:\n    accent: red\n" },
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
    await writeJar(project.jarFile, {
      extra: {
        "lang/theme.yml":
          "theme:\n  tokens:\n    accent: red\n    accent: blue\n",
      },
    });
    const files = [
      join(project.directory, "lang/zh.yml"),
      join(project.directory, ".l10n/upstream/source-baseline.json"),
      join(project.directory, ".l10n/lock.json"),
    ];
    const before = await Promise.all(files.map((path) => readFile(path)));

    const result = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout || result.stderr, /lang\/theme\.yml/);
    assert.match(result.stdout || result.stderr, /重复|duplicate|unique/i);
    const after = await Promise.all(files.map((path) => readFile(path)));
    for (let index = 0; index < before.length; index += 1) {
      assert.deepEqual(after[index], before[index]);
    }
  });

  void it("候选资源中有多个 theme.yml 时阻断预演", async (t) => {
    const project = await createProject(t);
    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "  - path: bedrock/lang/en_us.json\n    purpose: bedrock-excluded\n",
        "  - path: lang/theme.yml\n    purpose: configuration\n  - path: bedrock/lang/en_us.json\n    purpose: bedrock-excluded\n",
      ),
    );
    await writeJar(project.jarFile, {
      extra: { "lang/theme.yml": "theme: {}\n" },
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

    const acceptedConfig = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      acceptedConfig.replace(
        "  - path: lang/theme.yml\n    purpose: configuration\n",
        "  - path: lang/theme.yml\n    purpose: configuration\n  - path: ui/theme.yml\n    purpose: configuration\n",
      ),
    );
    await writeJar(project.jarFile, {
      extra: {
        "lang/theme.yml": "theme: {}\n",
        "ui/theme.yml": "theme: {}\n",
      },
    });
    const files = [
      configPath,
      join(project.directory, "lang/zh.yml"),
      join(project.directory, ".l10n/upstream/source-baseline.json"),
      join(project.directory, ".l10n/lock.json"),
    ];
    const before = await Promise.all(files.map((path) => readFile(path)));

    const result = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout || result.stderr, /主题资源不唯一/);
    assert.match(result.stdout || result.stderr, /lang\/theme\.yml/);
    assert.match(result.stdout || result.stderr, /ui\/theme\.yml/);
    const after = await Promise.all(files.map((path) => readFile(path)));
    for (let index = 0; index < before.length; index += 1) {
      assert.deepEqual(after[index], before[index]);
    }
  });

  void it("仅解析已登记为 configuration 的主题资源", async (t) => {
    const project = await createProject(t);
    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "  - path: bedrock/lang/en_us.json\n    purpose: bedrock-excluded\n",
        [
          "  - path: lang/theme.yml",
          "    purpose: configuration",
          "  - path: bedrock/theme.yml",
          "    purpose: bedrock-excluded",
          "  - path: bedrock/lang/en_us.json",
          "    purpose: bedrock-excluded",
          "",
        ].join("\n"),
      ),
    );
    const initialTheme = "theme: {}\n";
    await writeJar(project.jarFile, {
      extra: {
        "lang/theme.yml": initialTheme,
        "bedrock/theme.yml": "theme: [invalid\n",
      },
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
    const baselinePath = join(
      project.directory,
      ".l10n/upstream/source-baseline.json",
    );
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
      readonly miniMessageTheme?: {
        readonly file: string;
        readonly source: string;
      };
    };
    assert.deepEqual(baseline.miniMessageTheme, {
      file: "lang/theme.yml",
      source: initialTheme,
    });

    await writeJar(project.jarFile, {
      extra: {
        "lang/theme.yml": initialTheme,
        "bedrock/theme.yml": "theme: {broken\n",
      },
    });
    const preview = runCliWithoutPath(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(preview.status, 0, preview.stderr);
    const plan = readEnvelope(preview.stdout).data?.plan as Record<
      string,
      unknown
    >;
    assert.deepEqual(
      (plan.resourceChanges as Record<string, unknown>).observedOnly,
      {
        added: [],
        removed: [],
        changed: ["bedrock/theme.yml"],
      },
    );
    const candidateBaseline = JSON.parse(
      (plan.writes as readonly Record<string, unknown>[]).find(
        ({ kind }) => kind === "baseline",
      )?.content as string,
    ) as {
      readonly miniMessageTheme?: {
        readonly file: string;
        readonly source: string;
      };
    };
    assert.deepEqual(candidateBaseline.miniMessageTheme, {
      file: "lang/theme.yml",
      source: initialTheme,
    });
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

    await rename(`${project.jarFile}.unavailable`, project.jarFile);
    const previewFiles = [
      join(project.directory, "lang/zh.yml"),
      join(project.directory, ".l10n/upstream/source-baseline.json"),
      join(project.directory, ".l10n/lock.json"),
    ];
    const beforePreview = await Promise.all(
      previewFiles.map((file) => readFile(file)),
    );
    const preview = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.equal(preview.status, 0, preview.stderr);
    const plan = readEnvelope(preview.stdout).data?.plan as Record<
      string,
      unknown
    >;
    const messages = plan.messages as readonly Record<string, unknown>[];
    const welcome = messages.find(
      ({ path }) => JSON.stringify(path) === '["messages","welcome"]',
    );
    assert.ok(welcome);
    assert.deepEqual(plan.pendingTranslations, []);
    const afterPreview = await Promise.all(
      previewFiles.map((file) => readFile(file)),
    );
    for (let index = 0; index < beforePreview.length; index += 1) {
      assert.deepEqual(afterPreview[index], beforePreview[index]);
    }

    const files = [
      join(project.directory, "lang/zh.yml"),
      join(project.directory, ".l10n/upstream/source-baseline.json"),
      join(project.directory, ".l10n/lock.json"),
    ];
    const before = await Promise.all(files.map((file) => readFile(file)));
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

    const beforePreview = await readFile(targetPath);
    const preview = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.equal(preview.status, 0, preview.stderr);
    const plan = readEnvelope(preview.stdout).data?.plan as Record<
      string,
      unknown
    >;
    const messages = plan.messages as readonly Record<string, unknown>[];
    const greeting = messages.find(
      ({ path }) => JSON.stringify(path) === '["messages","greeting"]',
    );
    assert.equal(greeting?.action, "preserve");
    assert.deepEqual(greeting?.previousTarget, ["旧中文一", "旧中文二"]);
    assert.equal(
      (plan.writes as readonly Record<string, unknown>[]).some(
        ({ kind }) => kind === "target",
      ),
      false,
    );
    assert.deepEqual(await readFile(targetPath), beforePreview);
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
    const interrupted = await killInitWhenTargetAppears(
      project,
      project.targetPaths[0]!,
    );
    assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
    assert.equal(interrupted.killedAtTarget, true);

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

  void it("中断后出现并行编辑时拒绝恢复且保留编辑内容", async (t) => {
    const project = await createInterruptedProject(t);
    const targetPath = project.targetPaths[0]!;
    const interrupted = await killInitWhenTargetAppears(project, targetPath);
    assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
    assert.equal(interrupted.killedAtTarget, true);

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
      `${config}\nrules:\n  structure:\n    enabled: false\n  future-check:\n    enabled: true\n    severity: warning\n    parameters:\n      mode: strict\n`,
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
    assert.deepEqual(coverage.disabledRuleIds, ["structure"]);
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
});
