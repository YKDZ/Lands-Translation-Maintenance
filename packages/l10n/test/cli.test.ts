import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { initializeProject, recordException } from "@lands-l10n/l10n";
import { zipSync, strToU8 } from "fflate";
import { parse as parseYaml } from "yaml";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliFile = resolve(packageDirectory, "dist/cli.js");
const guiFixtureDirectory = resolve(
  packageDirectory,
  "test/fixtures/gui-8.0.1",
);
const guiModules = [
  {
    source: "Locale/en-US_gui.yml",
    definitions: "Locale/definitions_gui.yml",
    target: "Locale/zh-CN_gui.yml",
    sourceFixture: "main-en.yml",
    definitionsFixture: "main-definitions.yml",
    targetFixture: "main-zh.yml",
  },
  {
    source: "Locale/Nations/en-US_gui.yml",
    definitions: "Locale/Nations/definitions_gui.yml",
    target: "Locale/Nations/zh-CN_gui.yml",
    sourceFixture: "nations-en.yml",
    definitionsFixture: "nations-definitions.yml",
    targetFixture: "nations-zh.yml",
  },
  {
    source: "Locale/Wars/en-US_gui.yml",
    definitions: "Locale/Wars/definitions_gui.yml",
    target: "Locale/Wars/zh-CN_gui.yml",
    sourceFixture: "wars-en.yml",
    definitionsFixture: "wars-definitions.yml",
    targetFixture: "wars-zh.yml",
  },
] as const;

const guiFieldDeclarations = [
  '        - path: [general, "**"]',
  "          category: gui-string",
  "          scene: gui-general",
  '        - path: [physical, "*", name]',
  "          category: gui-string",
  "          scene: gui-item-name",
  '        - path: [physical, "*", lore]',
  "          category: gui-lore",
  "          scene: gui-item-lore",
  '        - path: [gui, "*", title]',
  "          category: gui-string",
  "          scene: gui-title",
  '        - path: [gui, "*", items, "*", "*", name]',
  "          category: gui-string",
  "          scene: gui-item-name",
  '        - path: [gui, "*", items, "*", "*", lore]',
  "          category: gui-lore",
  "          scene: gui-item-lore",
];

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [cliFile, ...args], {
    encoding: "utf8",
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

async function snapshotProjectFiles(projectDirectory: string) {
  const paths: string[] = [];
  async function collect(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) await collect(absolutePath, relativePath);
      else if (entry.isFile()) paths.push(relativePath);
    }
  }
  await collect(projectDirectory, "");
  return Promise.all(
    paths
      .sort()
      .map(
        async (path) =>
          [path, await readFile(join(projectDirectory, path))] as const,
      ),
  );
}

async function createProject(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "lands-l10n-cli-"));
  t.after(async () => rm(directory, { force: true, recursive: true }));

  const jarFile = join(directory, "Lands.jar");
  await mkdir(join(directory, "lang"), { recursive: true });
  await mkdir(join(directory, ".l10n"), { recursive: true });
  await writeJar(jarFile);
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

async function createGuiProject(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "lands-l10n-gui-"));
  t.after(async () => rm(directory, { force: true, recursive: true }));
  await mkdir(join(directory, ".l10n"), { recursive: true });

  const resources = [
    { path: "plugin.yml", purpose: "metadata" },
    ...guiModules.flatMap(({ source, definitions }) => [
      { path: source, purpose: "gui-language" },
      { path: definitions, purpose: "configuration" },
    ]),
  ];
  const mappings = guiModules.flatMap(({ source, definitions, target }) => [
    `    - source: ${source}`,
    `      target: ${target}`,
    `      definitionsSource: ${definitions}`,
    "      fields:",
    ...guiFieldDeclarations,
  ]);
  await writeFile(
    join(directory, ".l10n/config.yml"),
    [
      "schemaVersion: 1",
      "source:",
      '  version: "8.0.1"',
      '  translationHistory: "b8f6985a4ad2af1b76b05f0f79b718a2234623ad"',
      "resources:",
      ...resources.flatMap(({ path, purpose }) => [
        `  - path: ${path}`,
        `    purpose: ${purpose}`,
      ]),
      "translationScope:",
      '  sourceLanguage: "en-US"',
      '  targetLanguage: "zh-CN"',
      "  mappings:",
      ...mappings,
      "",
    ].join("\n"),
  );

  for (const module of guiModules) {
    const targetPath = join(directory, module.target);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(
      targetPath,
      await readFile(join(guiFixtureDirectory, module.targetFixture), "utf8"),
    );
  }
  const jarFile = join(directory, "Lands.jar");
  await writeGuiJar(jarFile);
  return { directory, jarFile };
}

async function writeGuiJar(
  jarFile: string,
  sourceOverrides: Readonly<Record<string, string>> = {},
  definitionsOverrides: Readonly<Record<string, string>> = {},
): Promise<void> {
  const jarEntries: Record<string, Uint8Array> = {
    "plugin.yml": strToU8("name: Lands\n"),
  };
  for (const module of guiModules) {
    jarEntries[module.source] = strToU8(
      sourceOverrides[module.source] ??
        (await readFile(
          join(guiFixtureDirectory, module.sourceFixture),
          "utf8",
        )),
    );
    jarEntries[module.definitions] = strToU8(
      definitionsOverrides[module.definitions] ??
        (await readFile(
          join(guiFixtureDirectory, module.definitionsFixture),
          "utf8",
        )),
    );
  }
  await writeFile(jarFile, zipSync(jarEntries));
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

function killCliWhenFileAppears(
  project: { readonly directory: string; readonly jarFile: string },
  command: "init",
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
        command,
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
    assert.match(result.stdout, /exempt/);
    const exemptHelp = runCli("exempt", "--help");
    assert.equal(exemptHelp.status, 0, exemptHelp.stderr);
    assert.match(exemptHelp.stdout, /--id/);
    assert.match(exemptHelp.stdout, /--reason/);
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

  void it("配置文本动态 ID 用显式 selector 进入初始化映射", async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "lands-l10n-config-fields-"),
    );
    t.after(async () => rm(directory, { force: true, recursive: true }));
    await mkdir(join(directory, ".l10n"), { recursive: true });
    const targetPath = join(directory, "Locale/zh-CN_categories.yml");
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(
      targetPath,
      [
        "land:",
        "  categories:",
        "    peaceful:",
        "      name: 和平",
        "      description: [不会发生战斗]",
        "      enabled: true",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(directory, ".l10n/config.yml"),
      [
        "schemaVersion: 1",
        "source:",
        '  version: "8.0.1"',
        '  translationHistory: "b8f6985a4ad2af1b76b05f0f79b718a2234623ad"',
        "resources:",
        "  - path: plugin.yml",
        "    purpose: metadata",
        "  - path: categories.yml",
        "    purpose: configuration",
        "translationScope:",
        '  sourceLanguage: "en-US"',
        '  targetLanguage: "zh-CN"',
        "  mappings:",
        "    - source: categories.yml",
        "      target: Locale/zh-CN_categories.yml",
        "      definitionsSource: categories.yml",
        "      fields:",
        '        - path: [land, categories, "*", name]',
        "          category: configuration-string",
        "          scene: category-name",
        '        - path: [land, categories, "*", description]',
        "          category: configuration-string-list",
        "          scene: category-description",
        "",
      ].join("\n"),
    );
    const jarFile = join(directory, "Lands.jar");
    await writeFile(
      jarFile,
      zipSync({
        "plugin.yml": strToU8("name: Lands\n"),
        "categories.yml": strToU8(
          [
            "land:",
            "  categories:",
            "    peaceful:",
            "      name: Peaceful",
            "      description: [No combat here]",
            "      enabled: true",
            "",
          ].join("\n"),
        ),
      }),
    );

    const initialized = runCli(
      "init",
      "--project",
      directory,
      "--jar",
      jarFile,
      "--output-format",
      "structured",
    );

    assert.equal(initialized.status, 0, initialized.stderr);
    const report = readReport(initialized.stdout);
    assert.equal((report.summary as Record<string, unknown>).messages, 2);
  });

  void it("初始化三模块 GUI 时保留中文和已合入的结构定义", async (t) => {
    const project = await createGuiProject(t);
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
    assert.equal((report.summary as Record<string, unknown>).messages, 14);
    const mainTarget = await readFile(
      join(project.directory, "Locale/zh-CN_gui.yml"),
      "utf8",
    );
    const nationTarget = await readFile(
      join(project.directory, "Locale/Nations/zh-CN_gui.yml"),
      "utf8",
    );
    const warTarget = await readFile(
      join(project.directory, "Locale/Wars/zh-CN_gui.yml"),
      "utf8",
    );
    assert.match(mainTarget, /all: <green>所有<\/green>/);
    assert.match(mainTarget, /name: <t:regular_heading>选区工具/);
    assert.match(mainTarget, /material: GOLDEN_HOE/);
    assert.match(
      mainTarget,
      /material: skin:8449b9318e33158e64a46ab0de121c3d40000e3332c1574932b3c849d8fa0dc2/,
    );
    assert.match(nationTarget, /name: <t:regular_heading>联邦职位/);
    assert.match(nationTarget, /material: INHERIT/);
    assert.match(warTarget, /name: <t:negative_heading>攻方/);
    assert.match(warTarget, /material: IRON_SWORD/);

    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const checkReport = readReport(checked.stdout || checked.stderr);
    const diagnostics = checkReport.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.equal(
      diagnostics.some(({ code }) =>
        ["message.extra", "message.type-mismatch"].includes(String(code)),
      ),
      false,
    );
    const coverage = checkReport.coverage as Record<string, unknown>;
    assert.equal(
      (coverage.unavailableCapabilities as string[]).some((capability) =>
        capability.includes("GUI 语言资源"),
      ),
      false,
    );

    const invalidMainTarget = mainTarget.replace(
      /    lore:\n(?:      - [^\n]*\n)+(?=    material: GOLDEN_HOE)/u,
      "    lore: 7\n",
    );
    assert.notEqual(invalidMainTarget, mainTarget);
    await writeFile(
      join(project.directory, "Locale/zh-CN_gui.yml"),
      invalidMainTarget,
    );
    const invalidCheck = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const invalidReport = readReport(
      invalidCheck.stdout || invalidCheck.stderr,
    );
    const invalidDiagnostics = invalidReport.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.ok(
      invalidDiagnostics.some(
        ({ code, location }) =>
          code === "message.type-mismatch" &&
          JSON.stringify((location as Record<string, unknown>).path) ===
            '["physical","selection","lore"]',
      ),
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
    assert.match(result.stdout, /exceptionCandidates/);
    assert.match(result.stdout, /--id/);
    assert.match(result.stdout, /knownOutOfScopeVisibleTexts/);
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
    assert.match(
      stale.stdout || stale.stderr,
      /Lioni 原生 `update <配置入口>`/,
    );
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
    const interrupted = await killCliWhenFileAppears(
      project,
      "init",
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
    const interrupted = await killCliWhenFileAppears(
      project,
      "init",
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
      const transactionIssue = (
        report.diagnostics as Array<Record<string, unknown>>
      ).find((item) => item.code === "transaction.prepared");
      assert.ok(transactionIssue);
      assert.match(String(transactionIssue.reason), /重新执行 init/);
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
    const interrupted = await killCliWhenFileAppears(
      project,
      "init",
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
          (item) =>
            typeof item.code === "string" &&
            item.code.startsWith("transaction."),
        ),
      );
      if (command === "status") {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(report.operation, "status");
        assert.equal(report.state, "ready");
      } else {
        assert.ok(
          result.status === 0 || result.status === 1,
          result.stderr || result.stdout,
        );
        assert.equal(report.operation, "check");
        assert.ok(
          ["ready", "issues", "incomplete"].includes(String(report.state)),
        );
      }
      assert.deepEqual(await snapshotProjectFiles(project.directory), before);
    }
  });

  void it("中断后出现并行编辑时拒绝恢复且保留编辑内容", async (t) => {
    const project = await createInterruptedProject(t);
    const targetPath = project.targetPaths[0]!;
    const interrupted = await killCliWhenFileAppears(
      project,
      "init",
      targetPath,
    );
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
    assert.match(retried.stdout || retried.stderr, /维护事务/);
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

  void it("结构规则禁用后仍按映射事实阻止同文确认", async (t) => {
    const project = await createProject(t);
    const targetPath = join(project.directory, "lang/zh.yml");
    const initialTarget = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      initialTarget.replace("greeting: 你好", "greeting: Hello"),
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

    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${config}\nrules:\n  structure:\n    enabled: false\n`,
    );
    await writeFile(
      targetPath,
      (await readFile(targetPath, "utf8")).replace(
        "welcome: Welcome",
        "welcome: [broken]",
      ),
    );

    const status = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(status.status, 0, status.stderr);
    const candidate = (
      readReport(status.stdout || status.stderr)
        .exceptionCandidates as readonly Record<string, unknown>[]
    )
      .filter((candidate) => candidate.ruleId === "translation-review")
      .find(
        (item) =>
          (item.message as Record<string, unknown>).path !== undefined &&
          JSON.stringify((item.message as Record<string, unknown>).path) ===
            '["messages","greeting"]',
      );
    assert.ok(candidate);
    if (candidate === undefined) throw new Error("缺少同文候选");

    const confirmation = runCli(
      "exempt",
      "--project",
      project.directory,
      "--id",
      String(candidate.id),
      "--reason",
      "结构规则关闭时仍须检查映射前提",
      "--output-format",
      "structured",
    );
    assert.equal(confirmation.status, 1);
    assert.match(confirmation.stdout || confirmation.stderr, /执行前提/u);
    await assert.rejects(
      readFile(join(project.directory, ".l10n/exceptions.yml")),
      { code: "ENOENT" },
    );
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

  void it("同一例外模型接受不同检查结论，分别派生待译状态和质量报告", async (t) => {
    const project = await createProject(t);
    const targetPath = join(project.directory, "lang/zh.yml");
    await writeFile(
      targetPath,
      (await readFile(targetPath, "utf8")).replace(
        "greeting: 你好",
        "greeting: Hello",
      ),
    );
    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(
      targetPath,
      (await readFile(targetPath, "utf8"))
        .replace("  welcome: Welcome\n", "")
        .replace("  commands:\n    registered: 已注册\n", ""),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stdout || checked.stderr);
    const candidates = report.exceptionCandidates as readonly Record<
      string,
      unknown
    >[];
    const sameText = candidates.find(
      (candidate) =>
        candidate.ruleId === "translation-review" &&
        JSON.stringify((candidate.message as Record<string, unknown>).path) ===
          '["messages","greeting"]',
    );
    const missing = candidates.find(
      (candidate) =>
        candidate.ruleId !== "translation-review" &&
        candidate.code === "message.missing" &&
        JSON.stringify((candidate.message as Record<string, unknown>).path) ===
          '["messages","welcome"]',
    );
    assert.ok(sameText);
    assert.ok(missing);
    for (const candidate of [sameText, missing]) {
      const recorded = runCli(
        "exempt",
        "--project",
        project.directory,
        "--id",
        String(candidate.id),
        "--reason",
        "已复核此具体例外",
        "--output-format",
        "structured",
      );
      assert.equal(recorded.status, 0, recorded.stdout || recorded.stderr);
      const receipt = readEnvelope(recorded.stdout).data?.exception as Record<
        string,
        unknown
      >;
      assert.equal(receipt.id, candidate.id);
      assert.equal(receipt.contentFingerprint, candidate.contentFingerprint);
    }
    const renewed = runCli(
      "exempt",
      "--project",
      project.directory,
      "--id",
      String(missing.id),
      "--reason",
      "补充接受理由",
    );
    assert.equal(renewed.status, 0, renewed.stdout || renewed.stderr);
    const saved = parseYaml(
      await readFile(join(project.directory, ".l10n/exceptions.yml"), "utf8"),
    ) as {
      schemaVersion: number;
      records: readonly Record<string, unknown>[];
    };
    assert.equal(saved.schemaVersion, 3);
    assert.equal(saved.records.length, 2);
    assert.deepEqual(
      new Set(saved.records.map((record) => record.ruleId)),
      new Set(["structure", "translation-review"]),
    );
    assert.equal(
      saved.records.find((record) => record.id === missing.id)?.reason,
      "补充接受理由",
    );
    const beforeStatus = await snapshotProjectFiles(project.directory);
    const status = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const after = readReport(status.stdout || status.stderr);
    assert.equal(status.status, 1);
    const summary = after.summary as Record<string, unknown>;
    assert.equal(summary.confirmedSameText, 1);
    assert.equal(summary.sameTextCandidates, 0);
    assert.equal(summary.pendingTranslations, 0);
    const remaining = after.exceptionCandidates as readonly Record<
      string,
      unknown
    >[];
    assert.ok(
      !remaining.some(
        (candidate) =>
          candidate.id === sameText.id || candidate.id === missing.id,
      ),
    );
    const diagnostics = after.diagnostics as readonly Record<string, unknown>[];
    assert.ok(
      !diagnostics.some((diagnostic) => diagnostic.diagnosticId === missing.id),
    );
    assert.ok(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "message.missing" &&
          JSON.stringify(
            (diagnostic.message as Record<string, unknown>).path,
          ) === '["messages","commands","registered"]',
      ),
    );
    assert.deepEqual(
      await snapshotProjectFiles(project.directory),
      beforeStatus,
    );
  });

  void it("同文确认与诊断豁免都不能绕过尚未同步的维护声明", async (t) => {
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
    await writeFile(
      targetPath,
      (await readFile(targetPath, "utf8")).replace("  welcome: Welcome\n", ""),
    );

    const status = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const sameTextCandidate = (
      readReport(status.stdout || status.stderr)
        .exceptionCandidates as readonly Record<string, unknown>[]
    )
      .filter((candidate) => candidate.ruleId === "translation-review")
      .find(
        (candidate) =>
          JSON.stringify(
            (candidate.message as Record<string, unknown>).path,
          ) === '["messages","greeting"]',
      );
    assert.ok(sameTextCandidate);
    if (sameTextCandidate === undefined)
      throw new Error("缺少待确认的同文候选");
    const check = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const missing = (
      readReport(check.stdout || check.stderr).diagnostics as readonly Record<
        string,
        unknown
      >[]
    ).find(
      (diagnostic) =>
        diagnostic.code === "message.missing" &&
        JSON.stringify((diagnostic.message as Record<string, unknown>).path) ===
          '["messages","welcome"]',
    );
    assert.ok(missing);
    if (missing === undefined) throw new Error("缺少目标消息诊断");

    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "b8f6985a4ad2af1b76b05f0f79b718a2234623ad",
        "a8f6985a4ad2af1b76b05f0f79b718a2234623ad",
      ),
    );

    for (const result of [
      runCli(
        "exempt",
        "--project",
        project.directory,
        "--id",
        String(sameTextCandidate.id),
        "--reason",
        "未同步时不得确认",
        "--output-format",
        "structured",
      ),
      runCli(
        "exempt",
        "--project",
        project.directory,
        "--id",
        String(missing.diagnosticId),
        "--reason",
        "未同步时不得豁免",
        "--output-format",
        "structured",
      ),
    ]) {
      assert.equal(result.status, 1);
      assert.match(result.stdout || result.stderr, /执行前提/u);
    }
    await assert.rejects(
      readFile(join(project.directory, ".l10n/exceptions.yml")),
      { code: "ENOENT" },
    );
  });

  void it("写入前诊断对象变化时拒绝记录豁免", async (t) => {
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
    const originalTarget = await readFile(targetPath, "utf8");
    const missingTarget = originalTarget.replace("  welcome: Welcome\n", "");
    await writeFile(targetPath, missingTarget);
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const diagnostics = readReport(checked.stdout || checked.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    const missing = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "message.missing" &&
        JSON.stringify(
          (diagnostic.message as Record<string, unknown> | undefined)?.path,
        ) === '["messages","welcome"]',
    );
    assert.ok(missing);
    if (missing === undefined) throw new Error("缺少待豁免的消息诊断");

    await assert.rejects(
      recordException(
        project.directory,
        String(missing.diagnosticId),
        "写入前对象发生变化",
        {
          beforeApply: async () => {
            await writeFile(targetPath, originalTarget);
          },
        },
      ),
      (error: unknown) =>
        error instanceof Error && /写入前例外对象已变化/u.test(error.message),
    );
    await assert.rejects(
      readFile(join(project.directory, ".l10n/exceptions.yml")),
      { code: "ENOENT" },
    );
    assert.equal(await readFile(targetPath, "utf8"), originalTarget);
  });
});
