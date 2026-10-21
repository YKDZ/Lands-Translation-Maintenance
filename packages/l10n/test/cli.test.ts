import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import {
  chmod,
  chown,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  applySyncProject,
  confirmSameText,
  initializeProject,
} from "@lands-l10n/l10n";
import { zipSync, strToU8 } from "fflate";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliFile = resolve(packageDirectory, "dist/cli.js");
const guiFixtureDirectory = resolve(
  packageDirectory,
  "test/fixtures/gui-8.0.1",
);
const landsFixtureDirectory = resolve(
  packageDirectory,
  "test/fixtures/lands-8.0.1",
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

function runCliWithoutPath(...args: string[]) {
  return spawnSync(process.execPath, [cliFile, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
}

function runCliAs(uid: number, gid: number, ...args: string[]) {
  return spawnSync(process.execPath, [cliFile, ...args], {
    encoding: "utf8",
    ...(process.getuid?.() === uid ? {} : { uid }),
    ...(process.getgid?.() === gid ? {} : { gid }),
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

async function setProjectOwner(
  directory: string,
  uid: number,
  gid: number,
): Promise<void> {
  await chown(directory, uid, gid);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await setProjectOwner(path, uid, gid);
    else await chown(path, uid, gid);
  }
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
  command: "init" | "sync",
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
    assert.match(result.stdout, /confirm-same-text/);
    assert.match(result.stdout, /sync/);
    assert.match(result.stdout, /schema/);
    const confirmHelp = runCli("confirm-same-text", "--help");
    assert.equal(confirmHelp.status, 0, confirmHelp.stderr);
    assert.match(confirmHelp.stdout, /--candidate/);
    assert.match(confirmHelp.stdout, /--reason/);
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

  void it("初始化对话框和混合配置时只收录声明字段并保留已有中文", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "lands-l10n-dialogs-"));
    t.after(async () => rm(directory, { force: true, recursive: true }));
    await mkdir(join(directory, ".l10n"), { recursive: true });
    await mkdir(join(directory, "Locale"), { recursive: true });
    await mkdir(join(directory, "Locale/Nations"), { recursive: true });
    await mkdir(join(directory, "zh"), { recursive: true });

    const [
      dialogSource,
      nationDialogSource,
      categoriesSource,
      levelsSource,
      rolesSource,
    ] = await Promise.all([
      readFile(join(landsFixtureDirectory, "en-US_dialogs.fixture"), "utf8"),
      readFile(
        join(landsFixtureDirectory, "nations-en-US_dialogs.fixture"),
        "utf8",
      ),
      readFile(join(landsFixtureDirectory, "categories.fixture"), "utf8"),
      readFile(join(landsFixtureDirectory, "levels.fixture"), "utf8"),
      readFile(join(landsFixtureDirectory, "roles.fixture"), "utf8"),
    ]);
    const jarFile = join(directory, "Lands.jar");
    await writeFile(
      jarFile,
      zipSync({
        "Locale/en-US_dialogs.yml": strToU8(dialogSource),
        "Locale/Nations/en-US_dialogs.yml": strToU8(nationDialogSource),
        "categories.yml": strToU8(categoriesSource),
        "levels.yml": strToU8(levelsSource),
        "roles.yml": strToU8(rolesSource),
        "plugin.yml": strToU8("name: Lands\n"),
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
        "  - path: Locale/en-US_dialogs.yml",
        "    purpose: dialog-language",
        "  - path: Locale/Nations/en-US_dialogs.yml",
        "    purpose: dialog-language",
        "  - path: categories.yml",
        "    purpose: configuration",
        "  - path: levels.yml",
        "    purpose: configuration",
        "  - path: roles.yml",
        "    purpose: configuration",
        "  - path: plugin.yml",
        "    purpose: metadata",
        "translationScope:",
        '  sourceLanguage: "en-US"',
        '  targetLanguage: "zh-CN"',
        "  mappings:",
        "    - source: Locale/en-US_dialogs.yml",
        "      target: Locale/zh-CN_dialogs.yml",
        "      definitionsSource: Locale/en-US_dialogs.yml",
        "      fields:",
        '        - path: [dialogs, "*", title]',
        "          category: dialog-string",
        "          scene: dialog-title",
        '        - path: [dialogs, "*", buttons, "*", label]',
        "          category: dialog-string",
        "          scene: dialog-button-label",
        '        - path: [dialogs, "*", buttons, "*", tooltip]',
        "          category: dialog-string",
        "          scene: dialog-button-tooltip",
        '        - path: [dialogs, "*", inputs, "*", label]',
        "          category: dialog-string",
        "          scene: dialog-input-label",
        '        - path: [dialogs, "*", inputs, "*", label-format]',
        "          category: dialog-label-format",
        "          scene: dialog-label-format",
        '        - path: [dialogs, "*", bodies, "*", text]',
        "          category: dialog-string",
        "          scene: dialog-body-text",
        '        - path: [dialogs, "*", bodies, "*", item, name]',
        "          category: gui-string",
        "          scene: gui-item-name",
        '        - path: [dialogs, "*", bodies, "*", item, lore]',
        "          category: gui-lore",
        "          scene: gui-item-lore",
        "    - source: Locale/Nations/en-US_dialogs.yml",
        "      target: Locale/Nations/zh-CN_dialogs.yml",
        "      definitionsSource: Locale/Nations/en-US_dialogs.yml",
        "      fields:",
        '        - path: [dialogs, "*", title]',
        "          category: dialog-string",
        "          scene: dialog-title",
        "    - source: categories.yml",
        "      target: zh/categories.yml",
        "      definitionsSource: categories.yml",
        "      fields:",
        '        - path: [land, categories, "*", name]',
        "          category: configuration-string",
        "          scene: category-name",
        '        - path: [land, categories, "*", description]',
        "          category: configuration-string-list",
        "          scene: category-description",
        "    - source: levels.yml",
        "      target: zh/levels.yml",
        "      definitionsSource: levels.yml",
        "      fields:",
        '        - path: [land, levels, "*", title]',
        "          category: configuration-string",
        "          scene: level-title",
        '        - path: [land, levels, "*", attributes, "*", description]',
        "          category: configuration-string",
        "          scene: level-attribute-description",
        '        - path: [land, levels, "*", requirements, "*", title]',
        "          category: configuration-string",
        "          scene: level-requirement-title",
        '        - path: [land, levels, "*", requirements, "*", description]',
        "          category: configuration-string-list",
        "          scene: level-requirement-description",
        "    - source: roles.yml",
        "      target: zh/roles.yml",
        "      definitionsSource: roles.yml",
        "      fields:",
        '        - path: [land, roles, "*", name]',
        "          category: configuration-string",
        "          scene: role-name",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(directory, "Locale/zh-CN_dialogs.yml"),
      "dialogs:\n  input:\n    title: 输入\n",
    );
    await writeFile(
      join(directory, "Locale/Nations/zh-CN_dialogs.yml"),
      "dialogs:\n  nation_create:\n    title: 创建国家\n",
    );
    await writeFile(
      join(directory, "zh/categories.yml"),
      "land:\n  categories:\n    members:\n      name: 招募成员\n      description: [正在招募, 请联系领主]\n",
    );
    await writeFile(
      join(directory, "zh/levels.yml"),
      "land:\n  levels:\n    '2':\n      title: 村庄\n      requirements:\n        members:\n          title: 信任玩家\n          description: [信任四位玩家, 输入命令]\n",
    );
    await writeFile(
      join(directory, "zh/roles.yml"),
      "land:\n  roles:\n    owner:\n      name: 主人\n",
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
    assert.equal((report.summary as Record<string, unknown>).messages, 94);
    assert.match(
      await readFile(join(directory, "Locale/zh-CN_dialogs.yml"), "utf8"),
      /title: 输入/,
    );
    assert.match(
      await readFile(
        join(directory, "Locale/Nations/zh-CN_dialogs.yml"),
        "utf8",
      ),
      /title: 创建国家/,
    );
    assert.match(
      await readFile(join(directory, "zh/categories.yml"), "utf8"),
      /name: 招募成员/,
    );
    assert.match(
      await readFile(join(directory, "zh/levels.yml"), "utf8"),
      /title: 村庄/,
    );
    assert.match(
      await readFile(join(directory, "zh/roles.yml"), "utf8"),
      /name: 主人/,
    );
    const seededDialog = parseYaml(
      await readFile(join(directory, "Locale/zh-CN_dialogs.yml"), "utf8"),
    ) as {
      dialogs: {
        add_member_duration: {
          inputs: { days: { type: string; start: number } };
        };
        land_create: { bodies: { tag: { item: { material: string } } } };
      };
    };
    assert.equal(
      seededDialog.dialogs.add_member_duration.inputs.days.type,
      "number-range",
    );
    assert.equal(seededDialog.dialogs.add_member_duration.inputs.days.start, 0);
    assert.equal(
      seededDialog.dialogs.land_create.bodies.tag.item.material,
      "NAME_TAG",
    );
    const status = runCli(
      "status",
      "--project",
      directory,
      "--output-format",
      "structured",
    );
    assert.equal(status.status, 0, status.stderr);
    assert.equal(
      (readReport(status.stdout).summary as Record<string, unknown>)
        .pendingTranslations,
      86,
    );

    seededDialog.dialogs.add_member_duration.inputs.days.type = "custom";
    await writeFile(
      join(directory, "Locale/zh-CN_dialogs.yml"),
      stringifyYaml(seededDialog),
    );
    const seededRoles = parseYaml(
      await readFile(join(directory, "zh/roles.yml"), "utf8"),
    ) as {
      land: { roles: { owner: { default: string; [key: string]: unknown } } };
    };
    seededRoles.land.roles.owner.default = "local-default";
    seededRoles.land.roles.owner["local-option"] = "保留";
    await writeFile(
      join(directory, "zh/roles.yml"),
      stringifyYaml(seededRoles),
    );

    const beforePreview = await snapshotProjectFiles(directory);
    const preview = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.equal(preview.status, 0, preview.stderr);
    const plan = readEnvelope(preview.stdout).data?.plan as Record<
      string,
      unknown
    >;
    const plannedMessages = plan.messages as readonly Record<string, unknown>[];
    const inputFormat = plannedMessages.find(
      ({ path }) =>
        JSON.stringify(path) ===
        '["dialogs","add_member_duration","inputs","days","label-format"]',
    );
    assert.equal(inputFormat?.category, "dialog-label-format");
    assert.equal(inputFormat?.scene, "dialog-label-format");
    assert.equal(inputFormat?.format, "label-format");
    const buttonLabel = plannedMessages.find(
      ({ path }) =>
        JSON.stringify(path) ===
        '["dialogs","input","buttons","confirm","label"]',
    );
    assert.equal(buttonLabel?.category, "dialog-string");
    assert.equal(buttonLabel?.scene, "dialog-button-label");
    assert.equal(buttonLabel?.format, "minimessage");
    const buttonTooltip = plannedMessages.find(
      ({ path }) =>
        JSON.stringify(path) ===
        '["dialogs","input","buttons","confirm","tooltip"]',
    );
    assert.equal(buttonTooltip?.scene, "dialog-button-tooltip");
    assert.equal(buttonTooltip?.format, "minimessage");
    const inputLabel = plannedMessages.find(
      ({ path }) =>
        JSON.stringify(path) ===
        '["dialogs","add_member_duration","inputs","days","label"]',
    );
    assert.equal(inputLabel?.scene, "dialog-input-label");
    assert.equal(inputLabel?.format, "minimessage");
    const bodyText = plannedMessages.find(
      ({ path }) =>
        JSON.stringify(path) ===
        '["dialogs","add_member_duration","bodies","info","text"]',
    );
    assert.equal(bodyText?.scene, "dialog-body-text");
    assert.equal(bodyText?.format, "minimessage");
    const dialogTitle = plannedMessages.find(
      ({ path }) => JSON.stringify(path) === '["dialogs","input","title"]',
    );
    assert.equal(dialogTitle?.category, "dialog-string");
    assert.equal(dialogTitle?.format, "minimessage");
    assert.equal(
      plannedMessages.some(({ path }) =>
        JSON.stringify(path).includes("material"),
      ),
      false,
    );
    const categoryDescription = plannedMessages.find(
      ({ path }) =>
        JSON.stringify(path) ===
        '["land","categories","members","description"]',
    );
    assert.equal(categoryDescription?.category, "configuration-string-list");
    assert.equal(categoryDescription?.scene, "category-description");
    assert.equal(categoryDescription?.format, "legacy-color-minimessage");
    const categoryName = plannedMessages.find(
      ({ path }) =>
        JSON.stringify(path) === '["land","categories","members","name"]',
    );
    assert.equal(categoryName?.scene, "category-name");
    assert.equal(categoryName?.format, "legacy-color-minimessage");
    const levelTitle = plannedMessages.find(
      ({ path }) => JSON.stringify(path) === '["land","levels","2","title"]',
    );
    assert.equal(levelTitle?.scene, "level-title");
    assert.equal(levelTitle?.format, "legacy-color-minimessage");
    const attributeDescription = plannedMessages.find(
      ({ path }) =>
        JSON.stringify(path) ===
        '["land","levels","1","attributes","chunks","description"]',
    );
    assert.equal(attributeDescription?.scene, "level-attribute-description");
    assert.equal(
      attributeDescription?.format,
      "legacy-color-variable-minimessage",
    );
    const requirementTitle = plannedMessages.find(
      ({ path }) =>
        JSON.stringify(path) ===
        '["land","levels","2","requirements","members","title"]',
    );
    assert.equal(requirementTitle?.format, "legacy-variable-minimessage");
    const roleName = plannedMessages.find(
      ({ path }) => JSON.stringify(path) === '["land","roles","owner","name"]',
    );
    assert.equal(roleName?.scene, "role-name");
    assert.equal(roleName?.format, "legacy-color-minimessage");
    const requirementDescription = plannedMessages.find(
      ({ path }) =>
        JSON.stringify(path) ===
        '["land","levels","2","requirements","members","description"]',
    );
    assert.equal(requirementDescription?.category, "configuration-string-list");
    assert.equal(
      requirementDescription?.format,
      "legacy-color-variable-minimessage",
    );
    assert.deepEqual(await snapshotProjectFiles(directory), beforePreview);

    const candidateJar = join(directory, "Lands-8.9.2.jar");
    const changedDialogSource = dialogSource
      .replace("title: Input", "title: Text Input")
      .replace("type: number-range", "type: text")
      .replace("start: 0", "start: 1")
      .replace("material: NAME_TAG", "material: PAPER")
      .replace("hide-tooltip: true", "hide-tooltip: 'enabled'");
    const changedCategoriesSource = categoriesSource
      .replace("allow-auto-accept: true", "allow-auto-accept: false")
      .replace(
        "&7This land is actively searching",
        "&7New members are welcome",
      );
    const changedCategories = parseYaml(changedCategoriesSource) as {
      land: { categories: Record<string, unknown> };
    };
    delete changedCategories.land.categories.mobfarm;
    const candidateCategoriesSource = stringifyYaml(changedCategories);
    const changedLevelsSource = levelsSource
      .replace("value: 0", "value: 5")
      .replace(
        "&7Trust {req} players in this land.",
        "&7Trust {req} residents in this land.",
      )
      .replace("reached: [ ]", "reached: ['say updated']");
    const changedRolesSource = rolesSource
      .replace(
        "skin:83f642814fa2551e7763d04060c532adea51015cbfe030cbb78e82c92092a6fb",
        "DIAMOND",
      )
      .replace("      default: 'ALL'", "");
    const changedRoles = parseYaml(changedRolesSource) as {
      land: { roles: { owner: Record<string, unknown> } };
    };
    changedRoles.land.roles.owner["custom-flags"] = {};
    const candidateRolesSource = stringifyYaml(changedRoles);
    await writeFile(
      candidateJar,
      zipSync({
        "Locale/en-US_dialogs.yml": strToU8(changedDialogSource),
        "Locale/Nations/en-US_dialogs.yml": strToU8(nationDialogSource),
        "categories.yml": strToU8(candidateCategoriesSource),
        "levels.yml": strToU8(changedLevelsSource),
        "roles.yml": strToU8(candidateRolesSource),
        "plugin.yml": strToU8("name: Lands\n"),
      }),
    );
    const beforeChangedPreview = await snapshotProjectFiles(directory);
    const changedPreview = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      candidateJar,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.equal(changedPreview.status, 0, changedPreview.stderr);
    const changedPlan = readEnvelope(changedPreview.stdout).data
      ?.plan as Record<string, unknown>;
    const changedStructures = changedPlan.structures as readonly Record<
      string,
      unknown
    >[];
    const inputTypeStructure = changedStructures.find(
      ({ path }) =>
        JSON.stringify(path) ===
        '["dialogs","add_member_duration","inputs","days","type"]',
    );
    assert.equal(inputTypeStructure?.action, "update");
    assert.equal(inputTypeStructure?.previous, "custom");
    assert.equal(inputTypeStructure?.expected, "text");
    const migratedStructure = changedStructures.find(
      ({ path }) =>
        JSON.stringify(path) ===
        '["dialogs","land_create","bodies","tag","item","hide-tooltip"]',
    );
    assert.equal(migratedStructure?.action, "update");
    assert.equal(migratedStructure?.previous, true);
    assert.equal(migratedStructure?.expected, "enabled");
    const commandStructure = changedStructures.find(
      ({ path }) =>
        JSON.stringify(path) === '["land","levels","2","commands","reached"]',
    );
    assert.equal(commandStructure?.action, "update");
    assert.deepEqual(commandStructure?.expected, ["say updated"]);
    const removedRoleStructure = changedStructures.find(
      ({ path }) =>
        JSON.stringify(path) === '["land","roles","owner","default"]',
    );
    assert.equal(removedRoleStructure?.action, "delete");
    assert.equal(removedRoleStructure?.previous, "local-default");
    const targetOnlyRoleOption = changedStructures.find(
      ({ path }) =>
        JSON.stringify(path) === '["land","roles","owner","local-option"]',
    );
    assert.equal(targetOnlyRoleOption?.action, "preserve");
    assert.equal(targetOnlyRoleOption?.previous, "保留");
    const deletedCategoryStructure = changedStructures.find(
      ({ path }) => JSON.stringify(path) === '["land","categories","mobfarm"]',
    );
    assert.equal(deletedCategoryStructure?.action, "delete");
    const emptyMapStructure = changedStructures.find(
      ({ path }) =>
        JSON.stringify(path) === '["land","roles","owner","custom-flags"]',
    );
    assert.equal(emptyMapStructure?.action, "update");
    assert.deepEqual(emptyMapStructure?.expected, {});
    assert.equal(
      changedStructures.some(
        ({ path }) => JSON.stringify(path) === '["dialogs","input","title"]',
      ),
      false,
    );
    const changedMessages = changedPlan.messages as readonly Record<
      string,
      unknown
    >[];
    const resetDialogTitle = changedMessages.find(
      ({ path }) => JSON.stringify(path) === '["dialogs","input","title"]',
    );
    assert.equal(resetDialogTitle?.action, "reset");
    assert.equal(resetDialogTitle?.previousTarget, "输入");
    const resetDescription = changedMessages.find(
      ({ path }) =>
        JSON.stringify(path) ===
        '["land","categories","members","description"]',
    );
    assert.equal(resetDescription?.action, "reset");
    assert.deepEqual(resetDescription?.previousTarget, [
      "正在招募",
      "请联系领主",
    ]);
    assert.deepEqual(
      await snapshotProjectFiles(directory),
      beforeChangedPreview,
    );

    const applied = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      candidateJar,
      "--output-format",
      "structured",
    );
    assert.equal(applied.status, 0, applied.stderr);
    const updatedDialog = parseYaml(
      await readFile(join(directory, "Locale/zh-CN_dialogs.yml"), "utf8"),
    ) as {
      readonly dialogs: {
        readonly input: { readonly title: string };
        readonly add_member_duration: {
          readonly inputs: {
            readonly days: { readonly type: string; readonly start: number };
          };
        };
        readonly land_create: {
          readonly bodies: {
            readonly tag: {
              readonly item: {
                readonly material: string;
                readonly "hide-tooltip": string;
              };
            };
          };
        };
      };
    };
    assert.equal(updatedDialog.dialogs.input.title, "Text Input");
    assert.equal(
      updatedDialog.dialogs.add_member_duration.inputs.days.type,
      "text",
    );
    assert.equal(
      updatedDialog.dialogs.add_member_duration.inputs.days.start,
      1,
    );
    assert.equal(
      updatedDialog.dialogs.land_create.bodies.tag.item.material,
      "PAPER",
    );
    assert.equal(
      updatedDialog.dialogs.land_create.bodies.tag.item["hide-tooltip"],
      "enabled",
    );
    const updatedCategories = parseYaml(
      await readFile(join(directory, "zh/categories.yml"), "utf8"),
    ) as {
      readonly land: {
        readonly categories: {
          readonly members: {
            readonly name: string;
            readonly enabled: boolean;
            readonly "allow-auto-accept": boolean;
            readonly description: readonly string[];
          };
          readonly [key: string]: unknown;
        };
      };
    };
    assert.equal(updatedCategories.land.categories.members.name, "招募成员");
    assert.equal("mobfarm" in updatedCategories.land.categories, false);
    assert.equal(updatedCategories.land.categories.members.enabled, true);
    assert.equal(
      updatedCategories.land.categories.members["allow-auto-accept"],
      false,
    );
    assert.deepEqual(updatedCategories.land.categories.members.description, [
      "&7New members are welcome",
      "&7for new members.",
    ]);
    const updatedLevels = parseYaml(
      await readFile(join(directory, "zh/levels.yml"), "utf8"),
    ) as {
      readonly land: {
        readonly levels: {
          readonly "1": {
            readonly attributes: {
              readonly chunks: { readonly value: number };
            };
          };
          readonly "2": {
            readonly commands: { readonly reached: readonly string[] };
            readonly requirements: {
              readonly members: { readonly description: readonly string[] };
            };
          };
        };
      };
    };
    assert.equal(updatedLevels.land.levels["1"].attributes.chunks.value, 5);
    assert.deepEqual(updatedLevels.land.levels["2"].commands.reached, [
      "say updated",
    ]);
    assert.deepEqual(
      updatedLevels.land.levels["2"].requirements.members.description,
      ["&7Trust {req} residents in this land.", "&7Command: &e/lands trust"],
    );
    const updatedRoles = parseYaml(
      await readFile(join(directory, "zh/roles.yml"), "utf8"),
    ) as {
      readonly land: {
        readonly roles: {
          readonly owner: {
            readonly name: string;
            readonly icon: string;
            readonly [key: string]: unknown;
          };
        };
      };
    };
    assert.equal(updatedRoles.land.roles.owner.name, "主人");
    assert.equal(updatedRoles.land.roles.owner.icon, "DIAMOND");
    assert.equal("default" in updatedRoles.land.roles.owner, false);
    assert.deepEqual(updatedRoles.land.roles.owner["custom-flags"], {});
    assert.equal(
      (updatedRoles.land.roles.owner as Record<string, unknown>)[
        "local-option"
      ],
      "保留",
    );

    const roleTargetFile = join(directory, "zh/roles.yml");
    const owner = updatedRoles.land.roles.owner as Record<string, unknown>;
    owner["custom-flags"] = { "local-option": "保留的子项" };
    await writeFile(roleTargetFile, stringifyYaml(updatedRoles));
    const customFlagStatus = runCli(
      "status",
      "--project",
      directory,
      "--output-format",
      "structured",
    );
    assert.equal(customFlagStatus.status, 0, customFlagStatus.stderr);

    delete owner["custom-flags"];
    await writeFile(roleTargetFile, stringifyYaml(updatedRoles));
    const missingCustomFlagStatus = runCli(
      "status",
      "--project",
      directory,
      "--output-format",
      "structured",
    );
    assert.equal(missingCustomFlagStatus.status, 1);
    assert.ok(
      (
        readReport(
          missingCustomFlagStatus.stdout || missingCustomFlagStatus.stderr,
        ).diagnostics as readonly Record<string, unknown>[]
      ).some(
        ({ code, location }) =>
          code === "structure.definition-mismatch" &&
          JSON.stringify((location as Record<string, unknown>).path) ===
            '["land","roles","owner","custom-flags"]',
      ),
    );

    owner["custom-flags"] = "结构类型冲突";
    await writeFile(roleTargetFile, stringifyYaml(updatedRoles));
    const wrongTypeCustomFlagStatus = runCli(
      "status",
      "--project",
      directory,
      "--output-format",
      "structured",
    );
    assert.equal(wrongTypeCustomFlagStatus.status, 1);
    assert.ok(
      (
        readReport(
          wrongTypeCustomFlagStatus.stdout || wrongTypeCustomFlagStatus.stderr,
        ).diagnostics as readonly Record<string, unknown>[]
      ).some(
        ({ code, location }) =>
          code === "structure.definition-mismatch" &&
          JSON.stringify((location as Record<string, unknown>).path) ===
            '["land","roles","owner","custom-flags"]',
      ),
    );

    owner["custom-flags"] = { "local-option": "保留的子项" };
    await writeFile(roleTargetFile, stringifyYaml(updatedRoles));
    const customFlagPreview = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      candidateJar,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.equal(customFlagPreview.status, 0, customFlagPreview.stderr);
    const customFlagStructures = readEnvelope(customFlagPreview.stdout).data
      ?.plan as { readonly structures: readonly Record<string, unknown>[] };
    assert.ok(
      customFlagStructures.structures.some(
        ({ path, action }) =>
          JSON.stringify(path) ===
            '["land","roles","owner","custom-flags","local-option"]' &&
          action === "preserve",
      ),
    );

    const appliedDialogFile = join(directory, "Locale/zh-CN_dialogs.yml");
    const driftedDialog = parseYaml(
      await readFile(appliedDialogFile, "utf8"),
    ) as {
      dialogs: {
        add_member_duration: { inputs: { days: { type: string } } };
      };
    };
    driftedDialog.dialogs.add_member_duration.inputs.days.type = "local-drift";
    await writeFile(appliedDialogFile, stringifyYaml(driftedDialog));
    const driftStatus = runCli(
      "status",
      "--project",
      directory,
      "--output-format",
      "structured",
    );
    assert.equal(driftStatus.status, 1);
    const driftDiagnostics = readReport(
      driftStatus.stdout || driftStatus.stderr,
    ).diagnostics as readonly Record<string, unknown>[];
    assert.ok(
      driftDiagnostics.some(
        ({ code, location }) =>
          code === "structure.definition-mismatch" &&
          JSON.stringify((location as Record<string, unknown>).path) ===
            '["dialogs","add_member_duration","inputs","days","type"]',
      ),
    );
    const beforeStructureDriftPreview = await snapshotProjectFiles(directory);
    const structureDriftPreview = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      candidateJar,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.equal(structureDriftPreview.status, 0, structureDriftPreview.stderr);
    const structureDriftPlan = readEnvelope(structureDriftPreview.stdout).data
      ?.plan as Record<string, unknown>;
    const repairedType = (
      structureDriftPlan.structures as readonly Record<string, unknown>[]
    ).find(
      ({ path }) =>
        JSON.stringify(path) ===
        '["dialogs","add_member_duration","inputs","days","type"]',
    );
    assert.equal(repairedType?.action, "update");
    assert.equal(repairedType?.previous, "local-drift");
    assert.equal(repairedType?.expected, "text");
    assert.deepEqual(
      await snapshotProjectFiles(directory),
      beforeStructureDriftPreview,
    );
    const structureDriftApplied = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      candidateJar,
      "--output-format",
      "structured",
    );
    assert.equal(structureDriftApplied.status, 0, structureDriftApplied.stderr);
    const afterApply = await snapshotProjectFiles(directory);
    const repeated = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      candidateJar,
      "--output-format",
      "structured",
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(await snapshotProjectFiles(directory), afterApply);

    const rolesPath = join(directory, "zh/roles.yml");
    const malformedRoles = parseYaml(await readFile(rolesPath, "utf8")) as {
      land: { roles: { owner: { icon: unknown } } };
    };
    malformedRoles.land.roles.owner.icon = { material: "DIAMOND" };
    await writeFile(rolesPath, stringifyYaml(malformedRoles));
    const beforeMalformedStructurePreview =
      await snapshotProjectFiles(directory);
    const malformedStructurePreview = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      candidateJar,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.equal(malformedStructurePreview.status, 1);
    const malformedStructureEnvelope = readEnvelope(
      malformedStructurePreview.stdout || malformedStructurePreview.stderr,
    );
    assert.equal(malformedStructureEnvelope.kind, "failure");
    const malformedStructureResult = malformedStructureEnvelope.data
      ?.preview as Record<string, unknown>;
    assert.equal(malformedStructureResult.ready, false);
    assert.equal(
      (
        malformedStructureResult.blockers as readonly Record<string, unknown>[]
      )[0]?.code,
      "sync.structure-target-path-type",
    );
    assert.deepEqual(
      await snapshotProjectFiles(directory),
      beforeMalformedStructurePreview,
    );
    malformedRoles.land.roles.owner.icon = "DIAMOND";
    await writeFile(rolesPath, stringifyYaml(malformedRoles));

    const badJar = join(directory, "Lands-invalid-description.jar");
    const malformedCategories = parseYaml(candidateCategoriesSource) as {
      land: { categories: { members: { description: string | string[] } } };
    };
    malformedCategories.land.categories.members.description = "&7Market";
    await writeFile(
      badJar,
      zipSync({
        "Locale/en-US_dialogs.yml": strToU8(changedDialogSource),
        "Locale/Nations/en-US_dialogs.yml": strToU8(nationDialogSource),
        "categories.yml": strToU8(stringifyYaml(malformedCategories)),
        "levels.yml": strToU8(changedLevelsSource),
        "roles.yml": strToU8(candidateRolesSource),
        "plugin.yml": strToU8("name: Lands\n"),
      }),
    );
    const beforeInvalidPreview = await snapshotProjectFiles(directory);
    const invalidPreview = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      badJar,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.notEqual(invalidPreview.status, 0);
    assert.match(invalidPreview.stdout + invalidPreview.stderr, /type|类型/i);
    assert.deepEqual(
      await snapshotProjectFiles(directory),
      beforeInvalidPreview,
    );

    const configPath = join(directory, ".l10n/config.yml");
    const releasedTranslation = parseYaml(
      await readFile(join(directory, "zh/categories.yml"), "utf8"),
    ) as {
      land: { categories: { members: { description: string[] } } };
    };
    releasedTranslation.land.categories.members.description = [
      "仍在招募成员",
      "请联系领主",
    ];
    await writeFile(
      join(directory, "zh/categories.yml"),
      stringifyYaml(releasedTranslation),
    );
    const configWithDescription = await readFile(configPath, "utf8");
    const releasedDescriptionField = [
      '        - path: [land, categories, "*", description]',
      "          category: configuration-string-list",
      "          scene: category-description",
      "",
    ].join("\n");
    assert.ok(configWithDescription.includes(releasedDescriptionField));
    await writeFile(
      configPath,
      configWithDescription.replace(releasedDescriptionField, ""),
    );
    const descriptionBeforeScopeRelease = (
      parseYaml(
        await readFile(join(directory, "zh/categories.yml"), "utf8"),
      ) as {
        readonly land: {
          readonly categories: {
            readonly members: { readonly description: readonly string[] };
          };
        };
      }
    ).land.categories.members.description;
    const beforeScopeReleasePreview = await snapshotProjectFiles(directory);
    const scopeReleasePreview = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      candidateJar,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.equal(scopeReleasePreview.status, 0, scopeReleasePreview.stderr);
    const scopeReleasePlan = readEnvelope(scopeReleasePreview.stdout).data
      ?.plan as Record<string, unknown>;
    assert.equal(
      (scopeReleasePlan.messages as readonly Record<string, unknown>[]).some(
        ({ path, action }) =>
          JSON.stringify(path) ===
            '["land","categories","members","description"]' &&
          action === "delete",
      ),
      false,
    );
    assert.deepEqual(
      await snapshotProjectFiles(directory),
      beforeScopeReleasePreview,
    );
    const scopeReleaseApplied = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      candidateJar,
      "--output-format",
      "structured",
    );
    assert.equal(scopeReleaseApplied.status, 0, scopeReleaseApplied.stderr);
    const descriptionAfterScopeRelease = (
      parseYaml(
        await readFile(join(directory, "zh/categories.yml"), "utf8"),
      ) as {
        readonly land: {
          readonly categories: {
            readonly members: { readonly description: readonly string[] };
          };
        };
      }
    ).land.categories.members.description;
    assert.deepEqual(
      descriptionAfterScopeRelease,
      descriptionBeforeScopeRelease,
    );
    const afterScopeRelease = await snapshotProjectFiles(directory);
    const repeatedScopeRelease = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      candidateJar,
      "--output-format",
      "structured",
    );
    assert.equal(repeatedScopeRelease.status, 0, repeatedScopeRelease.stderr);
    const descriptionAfterRepeatedRelease = (
      parseYaml(
        await readFile(join(directory, "zh/categories.yml"), "utf8"),
      ) as {
        readonly land: {
          readonly categories: {
            readonly members: { readonly description: readonly string[] };
          };
        };
      }
    ).land.categories.members.description;
    assert.deepEqual(
      descriptionAfterRepeatedRelease,
      descriptionBeforeScopeRelease,
    );
    assert.deepEqual(await snapshotProjectFiles(directory), afterScopeRelease);
    const categoriesChangedWhileReleased = candidateCategoriesSource
      .replace("&7New members are welcome", "&7Changed while unselected")
      .replace("&7for new members.", "&7Updated while unselected.");
    const releasedSourceJar = join(directory, "Lands-8.9.3.jar");
    await writeFile(
      releasedSourceJar,
      zipSync({
        "Locale/en-US_dialogs.yml": strToU8(changedDialogSource),
        "Locale/Nations/en-US_dialogs.yml": strToU8(nationDialogSource),
        "categories.yml": strToU8(categoriesChangedWhileReleased),
        "levels.yml": strToU8(changedLevelsSource),
        "roles.yml": strToU8(candidateRolesSource),
        "plugin.yml": strToU8("name: Lands\n"),
      }),
    );
    const beforeChangedReleasedPreview = await snapshotProjectFiles(directory);
    const changedReleasedPreview = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      releasedSourceJar,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.equal(
      changedReleasedPreview.status,
      0,
      changedReleasedPreview.stderr,
    );
    const changedReleasedPlan = readEnvelope(changedReleasedPreview.stdout).data
      ?.plan as Record<string, unknown>;
    assert.equal(
      (changedReleasedPlan.messages as readonly Record<string, unknown>[]).some(
        ({ path }) =>
          JSON.stringify(path) ===
          '["land","categories","members","description"]',
      ),
      false,
    );
    assert.equal(
      (
        changedReleasedPlan.structures as readonly Record<string, unknown>[]
      ).some(
        ({ path, action }) =>
          JSON.stringify(path) ===
            '["land","categories","members","description"]' &&
          action !== "preserve",
      ),
      false,
    );
    assert.deepEqual(
      await snapshotProjectFiles(directory),
      beforeChangedReleasedPreview,
    );
    const changedReleasedApplied = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      releasedSourceJar,
      "--output-format",
      "structured",
    );
    assert.equal(
      changedReleasedApplied.status,
      0,
      changedReleasedApplied.stderr,
    );
    const descriptionAfterReleasedSourceChange = (
      parseYaml(
        await readFile(join(directory, "zh/categories.yml"), "utf8"),
      ) as {
        readonly land: {
          readonly categories: {
            readonly members: { readonly description: readonly string[] };
          };
        };
      }
    ).land.categories.members.description;
    assert.deepEqual(
      descriptionAfterReleasedSourceChange,
      descriptionBeforeScopeRelease,
    );
    const afterChangedReleasedSync = await snapshotProjectFiles(directory);
    const repeatedChangedReleasedSync = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      releasedSourceJar,
      "--output-format",
      "structured",
    );
    assert.equal(
      repeatedChangedReleasedSync.status,
      0,
      repeatedChangedReleasedSync.stderr,
    );
    assert.deepEqual(
      await snapshotProjectFiles(directory),
      afterChangedReleasedSync,
    );
    const baseline = JSON.parse(
      await readFile(
        join(directory, ".l10n/upstream/source-baseline.json"),
        "utf8",
      ),
    ) as {
      readonly releasedTranslationPaths?: readonly {
        readonly sourceFile: string;
        readonly targetFile: string;
        readonly path: readonly string[];
      }[];
    };
    assert.deepEqual(baseline.releasedTranslationPaths, [
      {
        sourceFile: "categories.yml",
        targetFile: "zh/categories.yml",
        path: ["land", "categories", "members", "description"],
      },
      {
        sourceFile: "categories.yml",
        targetFile: "zh/categories.yml",
        path: ["land", "categories", "pvp", "description"],
      },
      {
        sourceFile: "categories.yml",
        targetFile: "zh/categories.yml",
        path: ["land", "categories", "shop", "description"],
      },
    ]);
    for (const command of ["status", "check"]) {
      const reportResult = runCli(
        command,
        "--project",
        directory,
        "--output-format",
        "structured",
      );
      const report = readReport(reportResult.stdout || reportResult.stderr);
      assert.ok(
        !(report.diagnostics as readonly Record<string, unknown>[]).some(
          ({ code }) => code === "structure.definition-mismatch",
        ),
      );
    }
    const selectedAgainConfig = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      selectedAgainConfig.replace(
        "    - source: levels.yml",
        `${releasedDescriptionField}    - source: levels.yml`,
      ),
    );
    const reselectedPreview = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      releasedSourceJar,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.equal(reselectedPreview.status, 0, reselectedPreview.stderr);
    const reselectedPlan = readEnvelope(reselectedPreview.stdout).data
      ?.plan as Record<string, unknown>;
    const reselectedDescription = (
      reselectedPlan.messages as readonly Record<string, unknown>[]
    ).filter(
      ({ path }) =>
        JSON.stringify(path) ===
        '["land","categories","members","description"]',
    );
    assert.deepEqual(
      reselectedDescription.map(({ action, reason }) => ({ action, reason })),
      [{ action: "seed", reason: "new-message" }],
    );
    const reselectedApplied = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      releasedSourceJar,
      "--output-format",
      "structured",
    );
    assert.equal(reselectedApplied.status, 0, reselectedApplied.stderr);
    const descriptionAfterReselection = (
      parseYaml(
        await readFile(join(directory, "zh/categories.yml"), "utf8"),
      ) as {
        readonly land: {
          readonly categories: {
            readonly members: { readonly description: readonly string[] };
          };
        };
      }
    ).land.categories.members.description;
    const selectedSourceDescription = (
      parseYaml(categoriesChangedWhileReleased) as {
        readonly land: {
          readonly categories: {
            readonly members: { readonly description: readonly string[] };
          };
        };
      }
    ).land.categories.members.description;
    assert.deepEqual(descriptionAfterReselection, selectedSourceDescription);
    const reselectedBaseline = JSON.parse(
      await readFile(
        join(directory, ".l10n/upstream/source-baseline.json"),
        "utf8",
      ),
    ) as { readonly releasedTranslationPaths?: readonly unknown[] };
    assert.equal(reselectedBaseline.releasedTranslationPaths, undefined);
  });

  void it("沿显式场景选择器读取对话框并保留 GUI lore 列表译文", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "lands-l10n-dialog-"));
    t.after(async () => rm(directory, { force: true, recursive: true }));
    await mkdir(join(directory, ".l10n"), { recursive: true });
    await mkdir(join(directory, "Locale"), { recursive: true });

    const source = [
      "dialogs:",
      "  announcement:",
      "    title: <t:heading>Notice",
      "    bodies:",
      "      icon:",
      "        item:",
      "          material: STONE",
      "          name: '&aBeacon'",
      "          lore: '&7A useful marker'",
      "          hide-tooltip: true",
      "",
    ].join("\n");
    const target = [
      "dialogs:",
      "  announcement:",
      "    title: <t:heading>通知",
      "    bodies:",
      "      icon:",
      "        item:",
      "          material: STONE",
      "          name: <green>信标",
      "          lore:",
      "            - 第一行",
      "            - 第二行",
      "          hide-tooltip: true",
      "",
    ].join("\n");
    await writeFile(join(directory, "Locale/zh-CN_dialogs.yml"), target);
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
        "  - path: Locale/en-US_dialogs.yml",
        "    purpose: dialog-language",
        "translationScope:",
        '  sourceLanguage: "en-US"',
        '  targetLanguage: "zh-CN"',
        "  mappings:",
        "    - source: Locale/en-US_dialogs.yml",
        "      target: Locale/zh-CN_dialogs.yml",
        "      definitionsSource: Locale/en-US_dialogs.yml",
        "      fields:",
        '        - path: [dialogs, "*", title]',
        "          category: dialog-string",
        "          scene: dialog-title",
        '        - path: [dialogs, "*", bodies, "*", item, name]',
        "          category: gui-string",
        "          scene: gui-item-name",
        '        - path: [dialogs, "*", bodies, "*", item, lore]',
        "          category: gui-lore",
        "          scene: gui-item-lore",
        "",
      ].join("\n"),
    );
    const jarFile = join(directory, "Lands.jar");
    await writeFile(
      jarFile,
      zipSync({
        "plugin.yml": strToU8("name: Lands\n"),
        "Locale/en-US_dialogs.yml": strToU8(source),
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
    assert.equal(
      (readReport(initialized.stdout).summary as Record<string, unknown>)
        .messages,
      3,
    );

    const preview = runCli(
      "sync",
      "--dry-run",
      "--project",
      directory,
      "--jar",
      jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(preview.status, 0, preview.stderr);
    const envelope = readEnvelope(preview.stdout);
    const plan = (envelope.data as Record<string, unknown>).plan as {
      messages: readonly {
        action: string;
        category: string;
        format?: string;
        scene?: string;
      }[];
    };
    assert.equal(plan.messages.length, 3);
    assert.deepEqual(
      plan.messages
        .map(({ action, category, format, scene }) => ({
          action,
          category,
          format,
          scene,
        }))
        .sort((left, right) => left.category.localeCompare(right.category)),
      [
        {
          action: "preserve",
          category: "dialog-string",
          format: "minimessage",
          scene: "dialog-title",
        },
        {
          action: "preserve",
          category: "gui-lore",
          format: "legacy-color-minimessage",
          scene: "gui-item-lore",
        },
        {
          action: "preserve",
          category: "gui-string",
          format: "legacy-color-minimessage",
          scene: "gui-item-name",
        },
      ],
    );
    const targetAfter = await readFile(
      join(directory, "Locale/zh-CN_dialogs.yml"),
      "utf8",
    );
    assert.match(targetAfter, /material: STONE/);
    assert.match(targetAfter, /hide-tooltip: true/);
    assert.match(targetAfter, /- 第一行\n            - 第二行/);
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

  void it("同步 GUI 外部 definitions 的结构改动并保留已译文本", async (t) => {
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

    const targetPath = join(project.directory, "Locale/zh-CN_gui.yml");
    const originalTarget = await readFile(targetPath);
    const definitions = await readFile(
      join(guiFixtureDirectory, "main-definitions.yml"),
      "utf8",
    );
    const changedDefinitions = definitions
      .replace("material: GOLDEN_HOE", "material: IRON_HOE")
      .replace("slots: 11", "slots: 12");
    assert.notEqual(changedDefinitions, definitions);
    const candidateJar = join(project.directory, "candidate.jar");
    await writeGuiJar(
      candidateJar,
      {},
      {
        "Locale/definitions_gui.yml": changedDefinitions,
      },
    );

    const preview = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      candidateJar,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.equal(preview.status, 0, preview.stderr);
    const plan = readEnvelope(preview.stdout).data?.plan as Record<
      string,
      unknown
    >;
    const structures = plan.structures as readonly Record<string, unknown>[];
    const material = structures.find(
      ({ path }) =>
        JSON.stringify(path) === '["physical","selection","material"]',
    );
    const slots = structures.find(
      ({ path }) =>
        JSON.stringify(path) ===
        '["gui","main","items","default","lands","slots"]',
    );
    assert.equal(material?.action, "update");
    assert.equal(material?.expected, "IRON_HOE");
    assert.equal(slots?.action, "update");
    assert.equal(slots?.expected, 12);
    assert.ok(
      (plan.inputSnapshots as readonly Record<string, unknown>[]).some(
        ({ path }) => path === candidateJar,
      ),
    );
    assert.ok(
      (plan.messages as readonly Record<string, unknown>[]).every(
        ({ action }) => action === "preserve",
      ),
    );
    assert.deepEqual(await readFile(targetPath), originalTarget);

    const applied = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      candidateJar,
      "--output-format",
      "structured",
    );
    assert.equal(applied.status, 0, applied.stderr);
    const updatedTarget = await readFile(targetPath, "utf8");
    assert.match(updatedTarget, /material: IRON_HOE/);
    assert.match(updatedTarget, /slots: 12/);
    assert.match(updatedTarget, /name: <t:regular_heading>选区工具/);
    assert.match(updatedTarget, /all: <green>所有<\/green>/);

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
      diagnostics.some(({ code }) => code === "structure.definition-mismatch"),
      false,
    );

    const repeated = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      candidateJar,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    const repeatedPlan = readEnvelope(repeated.stdout).data?.plan as Record<
      string,
      unknown
    >;
    assert.deepEqual(repeatedPlan.structures, []);
    assert.equal(
      (repeatedPlan.writes as readonly Record<string, unknown>[]).some(
        ({ kind }) => kind === "target",
      ),
      false,
    );
  });

  void it("递归 GUI selector 的前缀叶变分支时删除旧消息并新增子消息", async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "lands-l10n-gui-recursive-"),
    );
    t.after(async () => rm(directory, { force: true, recursive: true }));
    await mkdir(join(directory, ".l10n"), { recursive: true });
    await mkdir(join(directory, "Locale"), { recursive: true });

    const targetPath = join(directory, "Locale/zh-CN_gui.yml");
    await writeFile(targetPath, "general:\n  all: 全部\n");
    await writeFile(
      join(directory, ".l10n/config.yml"),
      [
        "schemaVersion: 1",
        "source:",
        '  version: "8.0.1"',
        '  translationHistory: "review"',
        "resources:",
        "  - path: plugin.yml",
        "    purpose: metadata",
        "  - path: Locale/en-US_gui.yml",
        "    purpose: gui-language",
        "  - path: Locale/definitions_gui.yml",
        "    purpose: configuration",
        "translationScope:",
        '  sourceLanguage: "en-US"',
        '  targetLanguage: "zh-CN"',
        "  mappings:",
        "    - source: Locale/en-US_gui.yml",
        "      target: Locale/zh-CN_gui.yml",
        "      definitionsSource: Locale/definitions_gui.yml",
        "      fields:",
        '        - path: [general, all, "**"]',
        "          category: gui-string",
        "          scene: gui-general",
        "",
      ].join("\n"),
    );

    const jarFile = join(directory, "Lands.jar");
    const writeSourceJar = async (source: string): Promise<void> =>
      writeFile(
        jarFile,
        zipSync({
          "plugin.yml": strToU8("name: Lands\n"),
          "Locale/en-US_gui.yml": strToU8(source),
          "Locale/definitions_gui.yml": strToU8("settings:\n  enabled: true\n"),
        }),
      );
    await writeSourceJar("general:\n  all: All\n");

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
    assert.match(await readFile(targetPath, "utf8"), /all: 全部/);

    await writeSourceJar("general:\n  all:\n    child: New\n");
    const beforePreview = await snapshotProjectFiles(directory);
    const preview = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      jarFile,
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
    const oldMessage = messages.find(
      ({ path }) => JSON.stringify(path) === '["general","all"]',
    );
    assert.equal(oldMessage?.action, "delete");
    assert.equal(oldMessage?.reason, "source-removed");
    assert.equal(oldMessage?.previousTarget, "全部");
    const newMessage = messages.find(
      ({ path }) => JSON.stringify(path) === '["general","all","child"]',
    );
    assert.equal(newMessage?.action, "seed");
    assert.equal(newMessage?.reason, "new-message");
    assert.equal(newMessage?.target, "New");
    assert.deepEqual(await snapshotProjectFiles(directory), beforePreview);

    const applied = runCli(
      "sync",
      "--project",
      directory,
      "--jar",
      jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(applied.status, 0, applied.stderr);
    const appliedTarget = parseYaml(await readFile(targetPath, "utf8")) as {
      readonly general: { readonly all: { readonly child: string } };
      readonly settings: { readonly enabled: boolean };
    };
    assert.deepEqual(appliedTarget.general.all, { child: "New" });
    assert.equal(appliedTarget.settings.enabled, true);
  });

  void it("GUI lore 从含换行标签的串改为列表时仍按严格原文重置", async (t) => {
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

    const originalTarget = await readFile(
      join(project.directory, "Locale/zh-CN_gui.yml"),
    );
    const mainSource = await readFile(
      join(guiFixtureDirectory, "main-en.yml"),
      "utf8",
    );
    const changedMainSource = mainSource.replace(
      '    lore: "<t:regular>Use this tool to create a selection.<newline>Selections can be used for:<newline> <t:decoration>• </t><t:regular>Claiming<newline> <t:decoration>• </t><t:regular>Unclaiming<newline> <t:decoration>• </t><t:regular>Resizing areas"',
      [
        "    lore:",
        "      - <t:regular>Use this tool to create a selection.",
        "      - 'Selections can be used for:'",
        "      - ' <t:decoration>• </t><t:regular>Claiming'",
        "      - ' <t:decoration>• </t><t:regular>Unclaiming'",
        "      - ' <t:decoration>• </t><t:regular>Resizing areas'",
      ].join("\n"),
    );
    assert.notEqual(changedMainSource, mainSource);
    const candidateJar = join(project.directory, "candidate.jar");
    await writeGuiJar(candidateJar, {
      "Locale/en-US_gui.yml": changedMainSource,
    });

    const preview = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      candidateJar,
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
    const lore = messages.find(
      ({ path }) => JSON.stringify(path) === '["physical","selection","lore"]',
    );
    const changedLore = [
      "<t:regular>Use this tool to create a selection.",
      "Selections can be used for:",
      " <t:decoration>• </t><t:regular>Claiming",
      " <t:decoration>• </t><t:regular>Unclaiming",
      " <t:decoration>• </t><t:regular>Resizing areas",
    ];
    assert.equal(lore?.action, "reset");
    assert.equal(lore?.reason, "source-changed");
    assert.equal(typeof lore?.previousSource, "string");
    assert.deepEqual(lore?.source, changedLore);
    assert.deepEqual(lore?.target, changedLore);
    assert.deepEqual(
      await readFile(join(project.directory, "Locale/zh-CN_gui.yml")),
      originalTarget,
    );

    const applied = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      candidateJar,
      "--output-format",
      "structured",
    );
    assert.equal(applied.status, 0, applied.stderr);
    const updatedTarget = await readFile(
      join(project.directory, "Locale/zh-CN_gui.yml"),
      "utf8",
    );
    assert.match(updatedTarget, /Use this tool to create a selection/);
    assert.doesNotMatch(updatedTarget, /使用此工具创建选区/);

    const repeated = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      candidateJar,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    const repeatedPlan = readEnvelope(repeated.stdout).data?.plan as Record<
      string,
      unknown
    >;
    const repeatedMessages = repeatedPlan.messages as readonly Record<
      string,
      unknown
    >[];
    const preservedLore = repeatedMessages.find(
      ({ path }) => JSON.stringify(path) === '["physical","selection","lore"]',
    );
    assert.equal(preservedLore?.action, "preserve");
    assert.equal(preservedLore?.reason, "unchanged");
    assert.equal(
      (repeatedPlan.writes as readonly Record<string, unknown>[]).some(
        ({ kind }) => kind === "target",
      ),
      false,
    );
  });

  void it("同步应用候选原文并一致更新译文、基线和锁", async (t) => {
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

    const baselinePath = join(
      project.directory,
      ".l10n/upstream/source-baseline.json",
    );
    const lockPath = join(project.directory, ".l10n/lock.json");
    const beforeBaseline = await readFile(baselinePath, "utf8");
    const beforeLock = await readFile(lockPath, "utf8");
    const candidateJar = join(project.directory, "Lands-8.9.2.jar");
    await writeJar(candidateJar, {
      source: [
        "messages:",
        "  greeting: Bonjour",
        "  welcome: Welcome",
        "  commands:",
        "    registered: Run",
        "list:",
        "  entries: [first, second]",
        "",
      ].join("\n"),
    });

    const beforePreview = await snapshotProjectFiles(project.directory);
    const preview = runCliWithoutPath(
      "sync",
      "--project",
      project.directory,
      "--jar",
      candidateJar,
      "--dry-run",
      "--output-format",
      "structured",
    );
    assert.equal(preview.status, 0, preview.stderr);
    const planned = readEnvelope(preview.stdout).data?.plan as Record<
      string,
      unknown
    >;
    const plannedWrites = planned.writes as readonly {
      readonly kind: string;
      readonly path: string;
      readonly content: string;
    }[];
    assert.deepEqual(
      await snapshotProjectFiles(project.directory),
      beforePreview,
    );

    const applied = runCliWithoutPath(
      "sync",
      "--project",
      project.directory,
      "--jar",
      candidateJar,
      "--output-format",
      "structured",
    );

    assert.equal(applied.status, 0, applied.stderr);
    const appliedEnvelope = readEnvelope(applied.stdout);
    assert.equal(appliedEnvelope.variant, "applied");
    const appliedData = appliedEnvelope.data as Record<string, unknown>;
    assert.deepEqual(appliedData.plan, planned);
    for (const write of plannedWrites) {
      assert.equal(await readFile(write.path, "utf8"), write.content);
    }
    assert.deepEqual(
      new Set(plannedWrites.map((write) => write.kind)),
      new Set(["target", "baseline", "lock"]),
    );
    const target = await readFile(
      join(project.directory, "lang/zh.yml"),
      "utf8",
    );
    assert.match(target, /greeting: Bonjour/);
    assert.match(target, /welcome: Welcome/);
    const afterBaseline = await readFile(baselinePath, "utf8");
    const afterLock = await readFile(lockPath, "utf8");
    assert.notEqual(afterBaseline, beforeBaseline);
    assert.match(afterBaseline, /Bonjour/);
    assert.notEqual(afterLock, beforeLock);

    const status = runCliWithoutPath(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(status.status, 0, status.stderr);
    const summary = readReport(status.stdout).summary as Record<
      string,
      unknown
    >;
    assert.equal(summary.pendingTranslations, 2);

    const translatedTarget = target.replace(
      "greeting: Bonjour",
      "greeting: 你好",
    );
    await writeFile(join(project.directory, "lang/zh.yml"), translatedTarget);
    const beforeRepeatedSync = await snapshotProjectFiles(project.directory);
    const repeated = runCliWithoutPath(
      "sync",
      "--project",
      project.directory,
      "--jar",
      candidateJar,
      "--output-format",
      "structured",
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(
      await readFile(join(project.directory, "lang/zh.yml"), "utf8"),
      translatedTarget,
    );
    assert.deepEqual(
      await snapshotProjectFiles(project.directory),
      beforeRepeatedSync,
    );

    const repeatedStatus = runCliWithoutPath(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(repeatedStatus.status, 0, repeatedStatus.stderr);
    const repeatedSummary = readReport(repeatedStatus.stdout).summary as Record<
      string,
      unknown
    >;
    assert.equal(repeatedSummary.pendingTranslations, 1);
    assert.equal(repeatedSummary.modifiedTranslations, 1);
    const repeatedLock = JSON.parse(await readFile(lockPath, "utf8")) as {
      readonly translationSeeds: readonly unknown[];
    };
    assert.equal(repeatedLock.translationSeeds.length, 2);

    const beforeTextSync = await snapshotProjectFiles(project.directory);
    const textSync = runCliWithoutPath(
      "sync",
      "--project",
      project.directory,
      "--jar",
      candidateJar,
    );
    assert.equal(textSync.status, 0, textSync.stderr);
    assert.match(textSync.stdout, /sync：已应用来源 8\.0\.1/);
    assert.match(textSync.stdout, /待翻译 1 条；已修改 1 条/);
    assert.deepEqual(
      await snapshotProjectFiles(project.directory),
      beforeTextSync,
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
    assert.match(result.stdout, /confirm-same-text/);
    assert.match(result.stdout, /--candidate/);
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

  void it("资源差异阻断应用，消费者更新清单后才提交观察记录", async (t) => {
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
    const blockedApply = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(blockedApply.status, 1);
    const blockedApplyResult = readEnvelope(
      blockedApply.stdout || blockedApply.stderr,
    );
    assert.equal(blockedApplyResult.kind, "failure");
    assert.equal(blockedApplyResult.variant, "blocked");

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

    const applied = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(applied.status, 0, applied.stderr);
    const appliedEnvelope = readEnvelope(applied.stdout);
    assert.equal(appliedEnvelope.variant, "applied");
    assert.deepEqual(appliedEnvelope.data?.plan, plan);
    const baseline = JSON.parse(await readFile(paths[2]!, "utf8")) as {
      readonly resources: readonly { readonly path: string }[];
    };
    assert.deepEqual(
      baseline.resources.map(({ path }) => path),
      [
        "lang/en.yml",
        "plugin.yml",
        "readme.md",
        "bedrock/lang/en_us.json",
      ].sort(),
    );
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

    const applied = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(applied.status, 0, applied.stderr);
    const appliedEnvelope = readEnvelope(applied.stdout);
    assert.equal(appliedEnvelope.variant, "applied");
    assert.deepEqual(appliedEnvelope.data?.plan, plan);
    const appliedTarget = await readFile(targetPath, "utf8");
    const appliedSource = parseYaml(appliedTarget) as {
      readonly messages: {
        readonly greeting: string;
        readonly welcome: string;
        readonly commands: {
          readonly registered: string;
          readonly multiline: string;
          readonly added: string;
          readonly leaving?: string;
        };
      };
      readonly list: { readonly entries: readonly string[] };
    };
    assert.equal(appliedSource.messages.greeting, "你好");
    assert.equal(appliedSource.messages.welcome, "Welcome ");
    assert.equal(
      appliedSource.messages.commands.registered,
      "Run <green>now</green>",
    );
    assert.equal(
      appliedSource.messages.commands.multiline,
      "Line one\nLine two",
    );
    assert.equal(appliedSource.messages.commands.added, "New line");
    assert.equal(appliedSource.messages.commands.leaving, undefined);
    assert.deepEqual(appliedSource.list.entries, ["second", "extra"]);
  });

  void it("删除消息原文实际清除旧目标对象整棵子树", async (t) => {
    const project = await createProject(t);
    const targetPath = join(project.directory, "lang/zh.yml");
    await writeFile(
      targetPath,
      [
        "messages:",
        "  greeting:",
        "    text: 旧中文",
        "  keep: 保留",
        "list:",
        "  entries: [第一项, 第二项]",
        "",
      ].join("\n"),
    );
    const sourceBefore = [
      "messages:",
      "  greeting: Hello",
      "  keep: Keep",
      "list:",
      "  entries: [first, second]",
      "",
    ].join("\n");
    await writeJar(project.jarFile, { source: sourceBefore });
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
      source: [
        "messages:",
        "  keep: Keep",
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
    const greeting = (plan.messages as readonly Record<string, unknown>[]).find(
      ({ path }) => JSON.stringify(path) === '["messages","greeting"]',
    );
    assert.equal(greeting?.action, "delete");
    assert.equal(greeting?.reason, "source-removed");
    assert.equal(greeting?.previousSource, "Hello");
    assert.deepEqual(greeting?.previousTarget, { text: "旧中文" });
    assert.equal(
      (plan.messages as readonly Record<string, unknown>[]).some(
        ({ path, reason }) =>
          JSON.stringify(path) === '["messages","greeting","text"]' &&
          reason === "orphaned-translation",
      ),
      false,
    );
    const targetWrite = (
      plan.writes as readonly Record<string, unknown>[]
    ).find(({ kind }) => kind === "target");
    assert.match(targetWrite?.content as string, /keep: 保留/);
    assert.doesNotMatch(targetWrite?.content as string, /greeting|text/);

    const applied = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(applied.status, 0, applied.stderr);
    const appliedEnvelope = readEnvelope(applied.stdout);
    assert.equal(appliedEnvelope.variant, "applied");
    assert.deepEqual(appliedEnvelope.data?.plan, plan);
    assert.doesNotMatch(await readFile(targetPath, "utf8"), /greeting|text/);
  });

  void it("通配聊天列表中的旧类型路径可由新子列表替换", async (t) => {
    const project = await createProject(t);
    await writeFile(
      join(project.directory, ".l10n/config.yml"),
      (
        await readFile(join(project.directory, ".l10n/config.yml"), "utf8")
      ).replace("[list, entries]", '[list, "**"]'),
    );
    await writeFile(
      join(project.directory, "lang/zh.yml"),
      [
        "messages:",
        "  greeting: 你好",
        "list:",
        "  greeting: [旧译文]",
        "",
      ].join("\n"),
    );
    const oldSource = [
      "messages:",
      "  greeting: Hello",
      "  welcome: Welcome",
      "  commands:",
      "    registered: Run",
      "list:",
      "  greeting: [Hello]",
      "",
    ].join("\n");
    await writeJar(project.jarFile, { source: oldSource });

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

    const newSource = [
      "messages:",
      "  greeting: Hello",
      "  welcome: Welcome",
      "  commands:",
      "    registered: Run",
      "list:",
      "  greeting:",
      "    child: [New]",
      "",
    ].join("\n");
    await writeJar(project.jarFile, { source: newSource });

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
    const oldList = messages.find(
      ({ path }) => JSON.stringify(path) === '["list","greeting"]',
    );
    const newList = messages.find(
      ({ path }) => JSON.stringify(path) === '["list","greeting","child"]',
    );
    assert.equal(oldList?.action, "delete");
    assert.equal(oldList?.reason, "source-removed");
    assert.deepEqual(oldList?.previousTarget, ["旧译文"]);
    assert.equal(newList?.action, "seed");
    assert.equal(newList?.reason, "new-message");
    assert.deepEqual(newList?.target, ["New"]);
  });

  void it("旧标量消息变为分支时先删除旧身份再新增子消息", async (t) => {
    const project = await createProject(t);
    const targetPath = join(project.directory, "lang/zh.yml");
    await writeFile(
      targetPath,
      [
        "messages:",
        "  greeting: 你好",
        "  keep: 保留",
        "list:",
        "  entries: [第一项, 第二项]",
        "",
      ].join("\n"),
    );
    await writeJar(project.jarFile, {
      source: [
        "messages:",
        "  greeting: Hello",
        "  keep: Keep",
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
    await writeJar(project.jarFile, {
      source: [
        "messages:",
        "  greeting:",
        "    child: New",
        "  keep: Keep",
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
    const messages = plan.messages as readonly Record<string, unknown>[];
    const oldGreeting = messages.find(
      ({ path }) => JSON.stringify(path) === '["messages","greeting"]',
    );
    const child = messages.find(
      ({ path }) => JSON.stringify(path) === '["messages","greeting","child"]',
    );
    assert.equal(oldGreeting?.action, "delete");
    assert.equal(oldGreeting?.reason, "source-removed");
    assert.equal(oldGreeting?.previousTarget, "你好");
    assert.equal(child?.action, "seed");
    assert.equal(child?.reason, "new-message");
    assert.equal(child?.target, "New");
    const targetWrite = (
      plan.writes as readonly Record<string, unknown>[]
    ).find(({ kind }) => kind === "target");
    assert.match(targetWrite?.content as string, /child: New/);
    assert.doesNotMatch(targetWrite?.content as string, /greeting: 你好/);
  });

  void it("旧分支消息变为标量时列出旧删除和新消息", async (t) => {
    const project = await createProject(t);
    const targetPath = join(project.directory, "lang/zh.yml");
    await writeFile(
      targetPath,
      [
        "messages:",
        "  greeting:",
        "    child: 你好",
        "  keep: 保留",
        "list:",
        "  entries: [第一项, 第二项]",
        "",
      ].join("\n"),
    );
    await writeJar(project.jarFile, {
      source: [
        "messages:",
        "  greeting:",
        "    child: Hello",
        "  keep: Keep",
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
    await writeJar(project.jarFile, {
      source: [
        "messages:",
        "  greeting: New",
        "  keep: Keep",
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
    const messages = plan.messages as readonly Record<string, unknown>[];
    const oldChild = messages.find(
      ({ path }) => JSON.stringify(path) === '["messages","greeting","child"]',
    );
    const greeting = messages.find(
      ({ path }) => JSON.stringify(path) === '["messages","greeting"]',
    );
    assert.equal(oldChild?.action, "delete");
    assert.equal(oldChild?.reason, "source-removed");
    assert.equal(oldChild?.previousTarget, "你好");
    assert.equal(greeting?.action, "seed");
    assert.equal(greeting?.reason, "new-message");
    assert.equal(greeting?.target, "New");
    const targetWrite = (
      plan.writes as readonly Record<string, unknown>[]
    ).find(({ kind }) => kind === "target");
    assert.match(targetWrite?.content as string, /greeting: New/);
    assert.doesNotMatch(targetWrite?.content as string, /child: 你好/);
  });

  void it("映射字段类型变化实际重置整条消息", async (t) => {
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

    const applied = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(applied.status, 0, applied.stderr);
    const appliedEnvelope = readEnvelope(applied.stdout);
    assert.equal(appliedEnvelope.variant, "applied");
    assert.deepEqual(appliedEnvelope.data?.plan, plan);
    assert.deepEqual(
      (
        parseYaml(await readFile(targetPath, "utf8")) as {
          readonly messages: { readonly welcome: readonly string[] };
        }
      ).messages.welcome,
      ["Welcome", "again"],
    );
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

  void it("同步未维护资源变化只更新观察基线，不重置译文", async (t) => {
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
    const baselinePath = join(
      project.directory,
      ".l10n/upstream/source-baseline.json",
    );
    const lockPath = join(project.directory, ".l10n/lock.json");
    const targetBefore = await readFile(targetPath);
    const baselineBefore = await readFile(baselinePath);
    const lockBefore = await readFile(lockPath);
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

    const applied = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(applied.status, 0, applied.stderr);
    const envelope = readEnvelope(applied.stdout);
    assert.equal(envelope.variant, "applied");
    assert.deepEqual(envelope.data?.plan, plan);
    assert.deepEqual(await readFile(targetPath), targetBefore);
    assert.notDeepEqual(await readFile(baselinePath), baselineBefore);
    assert.notDeepEqual(await readFile(lockPath), lockBefore);
  });

  void it("原文未变但目标字段缺失时实际填入英文并保留待翻译状态", async (t) => {
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

    const applied = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(applied.status, 0, applied.stderr);
    const appliedEnvelope = readEnvelope(applied.stdout);
    assert.equal(appliedEnvelope.variant, "applied");
    assert.deepEqual(appliedEnvelope.data?.plan, plan);
    assert.match(await readFile(targetPath, "utf8"), /welcome: Welcome/);
    const status = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(status.status, 0, status.stderr);
    assert.equal(
      (readReport(status.stdout).summary as Record<string, unknown>)
        .pendingTranslations,
      1,
    );
  });

  void it("同步移出最后一条维护映射后保留整份中文目标", async (t) => {
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
      "--output-format",
      "structured",
    );

    assert.equal(result.status, 0, result.stderr);
    const envelope = readEnvelope(result.stdout);
    assert.equal(envelope.variant, "applied");
    const plan = envelope.data?.plan as Record<string, unknown>;
    assert.deepEqual(plan.unmanagedTargets, ["lang/zh.yml"]);
    assert.deepEqual(plan.messages, []);
    assert.equal(
      (plan.writes as readonly Record<string, unknown>[]).some(
        ({ kind }) => kind === "target",
      ),
      false,
    );
    assert.deepEqual(await readFile(targetPath), targetBefore);
    const baseline = JSON.parse(
      await readFile(
        join(project.directory, ".l10n/upstream/source-baseline.json"),
        "utf8",
      ),
    ) as { readonly mappings: readonly unknown[] };
    assert.equal(baseline.mappings.length, 0);
  });

  void it("目标消息路径被字符串祖先阻断时只读保留整份中文", async (t) => {
    const project = await createProject(t);
    const targetPath = join(project.directory, "lang/zh.yml");
    const original = [
      "messages: 整份旧中文",
      "list:",
      "  entries: [第一项, 第二项]",
      "",
    ].join("\n");
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
    assert.ok(messages.length > 0);
    assert.ok(messages.every(({ action }) => action === "preserve"));
    const blockedMessages = messages.filter(
      ({ path }) => (path as readonly string[])[0] === "messages",
    );
    assert.equal(blockedMessages.length, 3);
    assert.ok(
      blockedMessages.every(({ reason }) => reason === "target-path-blocked"),
    );
    assert.equal(
      (plan.writes as readonly Record<string, unknown>[]).some(
        ({ kind }) => kind === "target",
      ),
      false,
    );
    assert.equal(await readFile(targetPath, "utf8"), original);

    const statePaths = [
      targetPath,
      join(project.directory, ".l10n/upstream/source-baseline.json"),
      join(project.directory, ".l10n/lock.json"),
    ];
    const beforeChangedPreview = await Promise.all(
      statePaths.map((path) => readFile(path)),
    );
    await writeJar(project.jarFile, {
      source: [
        "messages:",
        "  greeting: New greeting",
        "  welcome: Welcome",
        "  commands:",
        "    registered: Run",
        "    added: New message",
        "list:",
        "  entries: [first, second]",
        "",
      ].join("\n"),
    });
    const changedPreview = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(changedPreview.status, 1);
    const changedResult = readEnvelope(
      changedPreview.stdout || changedPreview.stderr,
    );
    const blockedPreview = changedResult.data?.preview as Record<
      string,
      unknown
    >;
    assert.equal(blockedPreview.ready, false);
    assert.ok(
      (blockedPreview.blockers as readonly Record<string, unknown>[]).some(
        ({ code }) => code === "sync.target-path-blocked",
      ),
    );
    const afterChangedPreview = await Promise.all(
      statePaths.map((path) => readFile(path)),
    );
    for (let index = 0; index < beforeChangedPreview.length; index += 1) {
      assert.deepEqual(afterChangedPreview[index], beforeChangedPreview[index]);
    }

    const blockedApply = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(blockedApply.status, 1);
    assert.equal(
      readEnvelope(blockedApply.stdout || blockedApply.stderr).variant,
      "blocked",
    );
    const afterBlockedApply = await Promise.all(
      statePaths.map((path) => readFile(path)),
    );
    for (let index = 0; index < beforeChangedPreview.length; index += 1) {
      assert.deepEqual(afterBlockedApply[index], beforeChangedPreview[index]);
    }

    await writeJar(project.jarFile, {
      source: ["messages: {}", "list:", "  entries: [first, second]", ""].join(
        "\n",
      ),
    });
    const removedPreview = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--dry-run",
      "--output-format",
      "structured",
    );

    assert.equal(removedPreview.status, 1);
    const removedResult = readEnvelope(
      removedPreview.stdout || removedPreview.stderr,
    );
    const removedBlockedPreview = removedResult.data?.preview as Record<
      string,
      unknown
    >;
    assert.equal(removedBlockedPreview.ready, false);
    assert.ok(
      (
        removedBlockedPreview.blockers as readonly Record<string, unknown>[]
      ).some(({ code }) => code === "sync.target-path-blocked"),
    );
    const afterRemovedPreview = await Promise.all(
      statePaths.map((path) => readFile(path)),
    );
    for (let index = 0; index < beforeChangedPreview.length; index += 1) {
      assert.deepEqual(afterRemovedPreview[index], beforeChangedPreview[index]);
    }
  });

  void it("同步时移出范围的缺失目标不会新建", async (t) => {
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
    await rm(targetPath);
    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        /  mappings:\n    - source: lang\/en\.yml\n      target: lang\/zh\.yml\n      fields:\n        - path: \[messages\]\n          category: chat-string\n        - path: \[list, entries\]\n          category: chat-string-list\n/,
        "  mappings: []\n",
      ),
    );

    const applied = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );

    assert.equal(applied.status, 0, applied.stderr);
    const envelope = readEnvelope(applied.stdout);
    assert.equal(envelope.variant, "applied");
    const plan = envelope.data?.plan as Record<string, unknown>;
    assert.deepEqual(plan.unmanagedTargets, ["lang/zh.yml"]);
    assert.equal(
      (plan.writes as readonly Record<string, unknown>[]).some(
        ({ kind }) => kind === "target",
      ),
      false,
    );
    await assert.rejects(readFile(targetPath));
  });

  void it("完全移出范围的无效旧目标不参与预演解析", async (t) => {
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
    const unmanagedTarget = "messages: [\n";
    await writeFile(targetPath, unmanagedTarget);
    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        /  mappings:\n    - source: lang\/en\.yml\n      target: lang\/zh\.yml\n      fields:\n        - path: \[messages\]\n          category: chat-string\n        - path: \[list, entries\]\n          category: chat-string-list\n/,
        "  mappings: []\n",
      ),
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
    assert.equal(
      (plan.writes as readonly Record<string, unknown>[]).some(
        ({ kind }) => kind === "target",
      ),
      false,
    );
    assert.equal(await readFile(targetPath, "utf8"), unmanagedTarget);
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
    const greeting = (plan.messages as readonly Record<string, unknown>[]).find(
      ({ path }) => JSON.stringify(path) === '["messages","greeting"]',
    );
    assert.equal(greeting?.action, "preserve");
    assert.equal(greeting?.reason, "unchanged");
    assert.deepEqual(greeting?.previousTarget, { text: "旧中文" });
    assert.equal(
      (plan.writes as readonly Record<string, unknown>[]).some(
        ({ kind }) => kind === "target",
      ),
      false,
    );
    assert.deepEqual(await readFile(targetPath), beforePreview);
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
      assert.match(String(transactionIssue.reason), /init 或 sync/);
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

  void it("同步事务中断后只读查询拒绝残缺状态，重试先恢复再提交", async (t) => {
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
      source: [
        "messages:",
        "  greeting: Bonjour",
        "  welcome: Welcome",
        "  commands:",
        "    registered: Run",
        "list:",
        "  entries: [first, second]",
        "",
      ].join("\n"),
    });
    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace("target: lang/zh.yml", "target: lang/zh-moved.yml"),
    );
    const targetPath = join(project.directory, "lang/zh-moved.yml");
    const oldTargetPath = join(project.directory, "lang/zh.yml");
    const baselinePath = join(
      project.directory,
      ".l10n/upstream/source-baseline.json",
    );
    const lockPath = join(project.directory, ".l10n/lock.json");
    const beforeTarget = await readFile(oldTargetPath, "utf8");
    const beforeBaseline = await readFile(baselinePath, "utf8");
    const beforeLock = await readFile(lockPath, "utf8");
    const interrupted = await killCliWhenFileAppears(
      project,
      "sync",
      "lang/zh-moved.yml",
      (contents) => contents.includes("greeting: Bonjour"),
    );
    assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
    assert.equal(interrupted.killedAtFile, true);
    const transactionPath = join(project.directory, ".l10n/transaction.json");
    assert.equal(
      (JSON.parse(await readFile(transactionPath, "utf8")) as { phase: string })
        .phase,
      "prepared",
    );
    assert.match(await readFile(targetPath, "utf8"), /greeting: Bonjour/);

    const beforeReadOnly = await snapshotProjectFiles(project.directory);
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
      assert.ok(
        (report.diagnostics as Array<Record<string, unknown>>).some(
          ({ code }) => code === "transaction.prepared",
        ),
      );
      assert.deepEqual(
        await snapshotProjectFiles(project.directory),
        beforeReadOnly,
      );
    }

    await writeFile(project.jarFile, "not a JAR");
    const failedRetry = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(failedRetry.status, 1);
    assert.match(failedRetry.stdout || failedRetry.stderr, /JAR|压缩/);
    assert.equal(await readFile(oldTargetPath, "utf8"), beforeTarget);
    assert.equal(await readFile(baselinePath, "utf8"), beforeBaseline);
    assert.equal(await readFile(lockPath, "utf8"), beforeLock);
    await assert.rejects(readFile(targetPath));
    await assert.rejects(readFile(transactionPath));

    await writeJar(project.jarFile, {
      source: [
        "messages:",
        "  greeting: Bonjour",
        "  welcome: Welcome",
        "  commands:",
        "    registered: Run",
        "list:",
        "  entries: [first, second]",
        "",
      ].join("\n"),
    });

    const retried = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(retried.status, 0, retried.stderr);
    const envelope = readEnvelope(retried.stdout);
    assert.equal(envelope.variant, "applied");
    const finalTarget = await readFile(targetPath, "utf8");
    assert.match(finalTarget, /greeting: Bonjour/);
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
      readonly mappings: readonly {
        readonly sourceValue: {
          readonly messages: { readonly greeting: string };
        };
      }[];
    };
    assert.equal(
      baseline.mappings[0]?.sourceValue.messages.greeting,
      "Bonjour",
    );
    const status = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(status.status, 0, status.stderr);
    assert.ok(
      !(
        readReport(status.stdout).diagnostics as Array<Record<string, unknown>>
      ).some(({ code }) => code === "transaction.prepared"),
    );
    await assert.rejects(readFile(transactionPath));
  });

  void it("同步恢复遇到并行编辑时保留编辑且不推进原文基线", async (t) => {
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
      source: [
        "messages:",
        "  greeting: Bonjour",
        "  welcome: Welcome",
        "  commands:",
        "    registered: Run",
        "list:",
        "  entries: [first, second]",
        "",
      ].join("\n"),
    });
    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace("target: lang/zh.yml", "target: lang/zh-moved.yml"),
    );
    const targetPath = join(project.directory, "lang/zh-moved.yml");
    const baselinePath = join(
      project.directory,
      ".l10n/upstream/source-baseline.json",
    );
    const lockPath = join(project.directory, ".l10n/lock.json");
    const interrupted = await killCliWhenFileAppears(
      project,
      "sync",
      "lang/zh-moved.yml",
      (contents) => contents.includes("greeting: Bonjour"),
    );
    assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
    assert.equal(interrupted.killedAtFile, true);
    const partialBaseline = await readFile(baselinePath, "utf8");
    const partialLock = await readFile(lockPath, "utf8");

    const parallelEdit = [
      "messages:",
      "  greeting: 并行编辑",
      "  welcome: Welcome",
      "  commands:",
      "    registered: 已注册",
      "list:",
      "  entries: [第一项, 第二项]",
      "",
    ].join("\n");
    await writeFile(targetPath, parallelEdit);
    const retried = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(retried.status, 1);
    assert.match(retried.stdout || retried.stderr, /并行编辑/);
    assert.equal(await readFile(targetPath, "utf8"), parallelEdit);
    assert.equal(await readFile(baselinePath, "utf8"), partialBaseline);
    assert.equal(await readFile(lockPath, "utf8"), partialLock);

    const status = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(status.status, 1);
    assert.ok(
      (
        readReport(status.stdout || status.stderr).diagnostics as Array<
          Record<string, unknown>
        >
      ).some(({ code }) => code === "transaction.prepared"),
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

  void it("同步提交前复核中文、声明、基线、锁和候选 JAR", async (t) => {
    const inputCases = [
      { name: "中文目标", path: "lang/zh.yml", suffix: "\n# 并行编辑\n" },
      {
        name: "声明",
        path: ".l10n/config.yml",
        suffix: "\n# 并行编辑\n",
      },
      {
        name: "原文基线",
        path: ".l10n/upstream/source-baseline.json",
        suffix: " ",
      },
      { name: "同步锁", path: ".l10n/lock.json", suffix: " " },
      { name: "候选 JAR", path: "candidate.jar", suffix: "损坏的并行版本" },
    ] as const;

    for (const input of inputCases) {
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
      const candidateJar = join(project.directory, "candidate.jar");
      await writeJar(candidateJar, {
        source: [
          "messages:",
          "  greeting: Bonjour",
          "  welcome: Welcome",
          "  commands:",
          "    registered: Run",
          "list:",
          "  entries: [first, second]",
          "",
        ].join("\n"),
      });
      const targetPath = join(project.directory, "lang/zh.yml");
      const baselinePath = join(
        project.directory,
        ".l10n/upstream/source-baseline.json",
      );
      const lockPath = join(project.directory, ".l10n/lock.json");
      const beforeTarget = await readFile(targetPath, "utf8");
      const beforeBaseline = await readFile(baselinePath, "utf8");
      const beforeLock = await readFile(lockPath, "utf8");
      const concurrentPath = join(project.directory, input.path);
      const concurrentContent =
        input.path === "candidate.jar"
          ? input.suffix
          : `${await readFile(concurrentPath, "utf8")}${input.suffix}`;

      await assert.rejects(
        applySyncProject(project.directory, candidateJar, {
          beforeApply: async () => writeFile(concurrentPath, concurrentContent),
        }),
        /并行编辑/,
        input.name,
      );
      assert.equal(
        await readFile(concurrentPath, "utf8"),
        concurrentContent,
        input.name,
      );
      if (input.path !== "lang/zh.yml") {
        assert.equal(
          await readFile(targetPath, "utf8"),
          beforeTarget,
          input.name,
        );
      }
      if (input.path !== ".l10n/upstream/source-baseline.json") {
        assert.equal(
          await readFile(baselinePath, "utf8"),
          beforeBaseline,
          input.name,
        );
      }
      if (input.path !== ".l10n/lock.json") {
        assert.equal(await readFile(lockPath, "utf8"), beforeLock, input.name);
      }
    }
  });

  void it("写入目录不可写时同步失败且保持上次完整状态", async (t) => {
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
      source: [
        "messages:",
        "  greeting: Bonjour",
        "  welcome: Welcome",
        "  commands:",
        "    registered: Run",
        "list:",
        "  entries: [first, second]",
        "",
      ].join("\n"),
    });
    const before = await snapshotProjectFiles(project.directory);
    const processUid = process.getuid?.();
    const processGid = process.getgid?.();
    assert.notEqual(processUid, undefined);
    assert.notEqual(processGid, undefined);
    const uid = processUid === 0 ? 65534 : processUid!;
    const gid = processGid === 0 ? 65534 : processGid!;
    if (processUid === 0) {
      await setProjectOwner(project.directory, uid, gid);
    }
    const targetDirectory = join(project.directory, "lang");
    await chmod(targetDirectory, 0o555);

    const failed = runCliAs(
      uid,
      gid,
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );

    await chmod(targetDirectory, 0o755);
    assert.equal(failed.error, undefined);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout || failed.stderr, /EACCES|permission denied/i);
    assert.deepEqual(await snapshotProjectFiles(project.directory), before);
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
        .sameTextToConfirm as readonly Record<string, unknown>[]
    ).find(
      (item) =>
        (item.message as Record<string, unknown>).path !== undefined &&
        JSON.stringify((item.message as Record<string, unknown>).path) ===
          '["messages","greeting"]',
    );
    assert.ok(candidate);
    if (candidate === undefined) throw new Error("缺少同文候选");

    const confirmation = runCli(
      "confirm-same-text",
      "--project",
      project.directory,
      "--candidate",
      String(candidate.candidateId),
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

  void it("按当前诊断 ID 记录精确豁免，邻近诊断仍然报告", async (t) => {
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
      target
        .replace("  welcome: Welcome\n", "")
        .replace("  greeting: 你好\n", ""),
    );
    const firstCheck = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(firstCheck.status, 1, firstCheck.stderr);
    const diagnostics = readReport(firstCheck.stdout || firstCheck.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    const welcome = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "message.missing" &&
        (diagnostic.message as Record<string, unknown> | undefined)?.path &&
        JSON.stringify((diagnostic.message as Record<string, unknown>).path) ===
          JSON.stringify(["messages", "welcome"]),
    );
    const registered = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "message.missing" &&
        JSON.stringify(
          (diagnostic.message as Record<string, unknown> | undefined)?.path,
        ) === JSON.stringify(["messages", "greeting"]),
    );
    assert.ok(welcome);
    assert.ok(registered);
    if (welcome === undefined || registered === undefined)
      throw new Error("缺少预期的消息诊断");

    const added = runCli(
      "exempt",
      "--project",
      project.directory,
      "--diagnostic",
      String(welcome.diagnosticId),
      "--reason",
      "此提示由维护者决定保留为空",
      "--output-format",
      "structured",
    );
    assert.equal(added.status, 0, added.stderr);
    const confirmation = readEnvelope(added.stdout).data?.confirmation as
      | Record<string, unknown>
      | undefined;
    assert.equal(confirmation?.diagnosticId, welcome.diagnosticId);
    assert.equal(confirmation?.contentFingerprint, welcome.contentFingerprint);

    const exceptionPath = join(project.directory, ".l10n/exceptions.yml");
    const exceptionBytes = await readFile(exceptionPath);
    const configPath = join(project.directory, ".l10n/config.yml");
    const originalConfig = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${originalConfig}\nrules:\n  minimessage-syntax:\n    severity: warning\n`,
    );
    await writeFile(
      join(project.directory, "lang/zh.yml"),
      `${await readFile(join(project.directory, "lang/zh.yml"), "utf8")}# comment-only edit\n`,
    );

    const after = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(after.status, 1, after.stderr);
    const afterDiagnostics = readReport(after.stdout || after.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      afterDiagnostics.some(
        (diagnostic) => diagnostic.diagnosticId === welcome.diagnosticId,
      ),
      false,
    );
    assert.equal(
      afterDiagnostics.some(
        (diagnostic) => diagnostic.diagnosticId === registered.diagnosticId,
      ),
      true,
      JSON.stringify(afterDiagnostics),
    );
    assert.deepEqual(await readFile(exceptionPath), exceptionBytes);
    const exceptionFile = parseYaml(exceptionBytes.toString("utf8")) as {
      diagnosticExemptions: readonly Record<string, unknown>[];
    };
    assert.equal(exceptionFile.diagnosticExemptions.length, 1);
    assert.equal(
      exceptionFile.diagnosticExemptions[0]?.diagnosticId,
      welcome.diagnosticId,
    );
    assert.equal(
      exceptionFile.diagnosticExemptions[0]?.reason,
      "此提示由维护者决定保留为空",
    );

    await writeFile(
      configPath,
      `${originalConfig}\nrules:\n  structure:\n    severity: warning\n`,
    );
    const relatedConfigCheck = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(relatedConfigCheck.status, 1);
    const relatedDiagnostics = readReport(
      relatedConfigCheck.stdout || relatedConfigCheck.stderr,
    ).diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      relatedDiagnostics.some(
        (diagnostic) =>
          diagnostic.code === "message.missing" &&
          JSON.stringify(
            (diagnostic.message as Record<string, unknown> | undefined)?.path,
          ) === '["messages","welcome"]',
      ),
      true,
    );
    assert.equal(
      relatedDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.review-required",
      ),
      true,
    );
    assert.deepEqual(await readFile(exceptionPath), exceptionBytes);

    await writeFile(
      configPath,
      `${originalConfig}\nrules:\n  structure:\n    enabled: false\n`,
    );
    const disabledRuleCheck = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(disabledRuleCheck.status, 1);
    const disabledDiagnostics = readReport(
      disabledRuleCheck.stdout || disabledRuleCheck.stderr,
    ).diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      disabledDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
      true,
    );
    assert.deepEqual(await readFile(exceptionPath), exceptionBytes);

    await writeFile(configPath, originalConfig);
    const syncAfterConfirmation = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(syncAfterConfirmation.status, 0, syncAfterConfirmation.stderr);
    const repeatedSync = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(repeatedSync.status, 0, repeatedSync.stderr);
    const afterSync = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const syncDiagnostics = readReport(afterSync.stdout || afterSync.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      syncDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.orphaned",
      ),
      true,
    );
    assert.deepEqual(await readFile(exceptionPath), exceptionBytes);
  });

  void it("合理同文只解除同文待处理原因并保留其他质量诊断", async (t) => {
    const project = await createProject(t);
    const targetPath = join(project.directory, "lang/zh.yml");
    const targetBeforeInit = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      targetBeforeInit.replace("greeting: 你好", "greeting: Hello"),
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

    const beforeSync = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(beforeSync.status, 0, beforeSync.stderr);
    const oldCandidates = readReport(beforeSync.stdout || beforeSync.stderr)
      .sameTextToConfirm as readonly Record<string, unknown>[];
    const oldGreeting = oldCandidates.find(
      (candidate) =>
        JSON.stringify((candidate.message as Record<string, unknown>).path) ===
        '["messages","greeting"]',
    );
    assert.ok(oldGreeting);
    if (oldGreeting === undefined) throw new Error("缺少旧同文候选");
    const oldCandidateId = String(oldGreeting.candidateId);

    const candidateJar = join(project.directory, "candidate.jar");
    await writeJar(candidateJar, {
      source: [
        "messages:",
        "  greeting: Hola",
        "  welcome: Welcome",
        "  commands:",
        "    registered: Run",
        "list:",
        "  entries: [first, second]",
        "",
      ].join("\n"),
    });
    const synced = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      candidateJar,
      "--output-format",
      "structured",
    );
    assert.equal(synced.status, 0, synced.stderr);

    const oldSelection = runCli(
      "confirm-same-text",
      "--project",
      project.directory,
      "--candidate",
      oldCandidateId,
      "--reason",
      "不应沿用旧内容选择",
      "--output-format",
      "structured",
    );
    assert.equal(oldSelection.status, 1);
    await assert.rejects(
      readFile(join(project.directory, ".l10n/exceptions.yml")),
      { code: "ENOENT" },
    );

    await writeFile(
      targetPath,
      (await readFile(targetPath, "utf8")).replace("  welcome: Welcome\n", ""),
    );
    const before = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(before.status, 1, before.stderr);
    const beforeReport = readReport(before.stdout || before.stderr);
    const candidates = beforeReport.sameTextToConfirm as readonly Record<
      string,
      unknown
    >[];
    const greeting = candidates.find(
      (candidate) =>
        (candidate.message as Record<string, unknown>).path &&
        JSON.stringify((candidate.message as Record<string, unknown>).path) ===
          JSON.stringify(["messages", "greeting"]),
    );
    assert.ok(greeting);
    if (greeting === undefined) throw new Error("缺少同文待确认消息");
    const greetingMessage = greeting.message as Record<string, unknown>;
    const greetingId = String(greetingMessage.id);
    const candidateId = String(greeting.candidateId);
    assert.match(candidateId, /^[0-9a-f]{64}$/u);
    assert.notEqual(candidateId, oldCandidateId);

    const beforeRace = await readFile(targetPath, "utf8");
    await assert.rejects(
      confirmSameText(
        project.directory,
        candidateId,
        "写入前内容变化时不得确认旧候选",
        {
          beforeApply: async () => {
            await writeFile(
              targetPath,
              beforeRace.replace("greeting: Hola", "greeting: Changed"),
            );
          },
        },
      ),
      (error: unknown) =>
        error instanceof Error && /写入前同文候选已变化/u.test(error.message),
    );
    await assert.rejects(
      readFile(join(project.directory, ".l10n/exceptions.yml")),
      { code: "ENOENT" },
    );
    await writeFile(targetPath, beforeRace);

    const confirmed = runCli(
      "confirm-same-text",
      "--project",
      project.directory,
      "--candidate",
      candidateId,
      "--reason",
      "品牌名在此处保留英文",
    );
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.match(confirmed.stdout, /已确认同文候选/u);
    assert.match(confirmed.stdout, new RegExp(candidateId));
    assert.match(confirmed.stdout, /品牌名在此处保留英文/u);
    const exceptionPath = join(project.directory, ".l10n/exceptions.yml");
    const exceptionBytes = await readFile(exceptionPath);
    const savedExceptions = parseYaml(exceptionBytes.toString("utf8")) as {
      sameTextConfirmations: readonly Record<string, unknown>[];
    };
    assert.equal(savedExceptions.sameTextConfirmations.length, 1);
    assert.equal(
      (
        savedExceptions.sameTextConfirmations[0]?.message as Record<
          string,
          unknown
        >
      )?.id,
      greetingId,
    );
    assert.equal(
      savedExceptions.sameTextConfirmations[0]?.candidateId,
      candidateId,
    );

    const quotedTarget = (await readFile(targetPath, "utf8")).replace(
      "greeting: Hola",
      "greeting: 'Hola'",
    );
    const commentedTarget = `${quotedTarget}# YAML comment only\n`;
    await writeFile(targetPath, commentedTarget);

    const afterStatus = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(afterStatus.status, 1, afterStatus.stderr);
    const afterReport = readReport(afterStatus.stdout || afterStatus.stderr);
    const summary = afterReport.summary as Record<string, unknown>;
    assert.equal(summary.confirmedSameText, 1, JSON.stringify(afterReport));
    assert.equal(summary.sameTextCandidates, 0);
    assert.equal(summary.pendingTranslations, 0);
    const currentCandidates = afterReport.sameTextToConfirm as readonly Record<
      string,
      unknown
    >[];
    assert.equal(currentCandidates.length, 0);
    assert.equal(
      (afterReport.diagnostics as readonly Record<string, unknown>[]).some(
        (diagnostic) => diagnostic.code === "same-text.unable-to-evaluate",
      ),
      false,
    );
    assert.deepEqual(await readFile(exceptionPath), exceptionBytes);

    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(checked.status, 1);
    const checkedReport = readReport(checked.stdout || checked.stderr);
    const checkDiagnostics = checkedReport.diagnostics as readonly Record<
      string,
      unknown
    >[];
    const checkSummary = checkedReport.summary as Record<string, unknown>;
    assert.equal(checkSummary.confirmedSameText, 1);
    assert.equal(checkSummary.pendingTranslations, 0);
    assert.equal(
      (checkedReport.sameTextToConfirm as readonly unknown[]).length,
      0,
    );
    assert.equal(
      checkDiagnostics.some(
        (diagnostic) => diagnostic.code === "message.missing",
      ),
      true,
    );
    assert.deepEqual(await readFile(exceptionPath), exceptionBytes);

    await writeFile(
      targetPath,
      commentedTarget.replace("greeting: 'Hola'", "greeting: 'Different'"),
    );
    const staleStatus = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(staleStatus.status, 1);
    const staleDiagnostics = readReport(
      staleStatus.stdout || staleStatus.stderr,
    ).diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      staleDiagnostics.some(
        (diagnostic) => diagnostic.code === "same-text.review-required",
      ),
      true,
    );
    assert.deepEqual(await readFile(exceptionPath), exceptionBytes);

    const deletionJar = join(project.directory, "deletion.jar");
    await writeJar(deletionJar, {
      source: [
        "messages:",
        "  welcome: Welcome",
        "  commands:",
        "    registered: Run",
        "list:",
        "  entries: [first, second]",
        "",
      ].join("\n"),
    });
    const deletedSource = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      deletionJar,
      "--output-format",
      "structured",
    );
    assert.equal(deletedSource.status, 0, deletedSource.stderr);
    const afterDeletion = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const deletionDiagnostics = readReport(
      afterDeletion.stdout || afterDeletion.stderr,
    ).diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      deletionDiagnostics.some(
        (diagnostic) => diagnostic.code === "same-text.orphaned",
      ),
      true,
    );
    assert.deepEqual(await readFile(exceptionPath), exceptionBytes);
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
        .sameTextToConfirm as readonly Record<string, unknown>[]
    ).find(
      (candidate) =>
        JSON.stringify((candidate.message as Record<string, unknown>).path) ===
        '["messages","greeting"]',
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
        "confirm-same-text",
        "--project",
        project.directory,
        "--candidate",
        String(sameTextCandidate.candidateId),
        "--reason",
        "未同步时不得确认",
        "--output-format",
        "structured",
      ),
      runCli(
        "exempt",
        "--project",
        project.directory,
        "--diagnostic",
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
});
