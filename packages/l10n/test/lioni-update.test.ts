import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ComparisonBaselineStore, FrameworkConfig } from "@lioni/lioni";
import { update } from "@lioni/lioni";
import { createFileComparisonBaselineStore } from "@lioni/lioni/node";
import { strToU8, zipSync } from "fflate";
import { parseDocument } from "yaml";

import { createLandsConfig } from "../lioni.config.ts";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeCli = join(packageDirectory, "node_modules/.bin/lioni");
const sourcePreparer = join(
  packageDirectory,
  "scripts/prepare-lioni-source.ts",
);

type BaselineStoreFor<TConfig> =
  TConfig extends FrameworkConfig<
    infer TUnit,
    infer TTranslation,
    infer TBody,
    infer TUnavailable
  >
    ? ComparisonBaselineStore<TUnit, TTranslation, TBody, TUnavailable>
    : never;

function runLioni(args: readonly string[]): string {
  const result = spawnSync(process.execPath, [nativeCli, ...args], {
    cwd: tmpdir(),
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `${args.join(" ")} 失败：\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

async function prepareSource(
  configPath: string,
  jarPath: string,
  expectedVersion = "8.9.2",
): Promise<void> {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=source",
      sourcePreparer,
      "--jar",
      jarPath,
      "--config",
      configPath,
    ],
    { cwd: tmpdir(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const sourceDirectory = join(dirname(configPath), "source");
  const pointer = JSON.parse(
    await readFile(join(sourceDirectory, "current.json"), "utf8"),
  ) as { readonly snapshotSha256: string };
  const manifest = JSON.parse(
    await readFile(
      join(
        sourceDirectory,
        "snapshots",
        pointer.snapshotSha256,
        "manifest.json",
      ),
      "utf8",
    ),
  ) as { readonly sourceVersion: string };
  assert.equal(manifest.sourceVersion, expectedVersion);
}

async function createProject(directory: string): Promise<void> {
  await mkdir(join(directory, ".l10n"), { recursive: true });
  await mkdir(join(directory, ".lioni"), { recursive: true });
  await mkdir(join(directory, "Locale"), { recursive: true });
  await writeFile(
    join(directory, ".l10n/config.yml"),
    [
      "schemaVersion: 1",
      "source:",
      '  version: "8.9.2"',
      '  translationHistory: "fixture-history"',
      "resources:",
      "  - path: plugin.yml",
      "    purpose: metadata",
      "  - path: Locale/en-US.yml",
      "    purpose: chat-language",
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
  await writeFile(
    join(directory, "Locale/zh-CN.yml"),
    [
      "# 保留文件注释",
      "messages:",
      "  greet: 你好 # 保留字段注释",
      "  leave: 再见",
      "  legacy: 旧译文",
      "custom: 保留用户字段",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(directory, ".lioni/lioni.config.ts"),
    [
      'import { createLandsConfig } from "@lands-l10n/l10n/lioni.config";',
      "",
      "export default createLandsConfig(import.meta.url);",
      "",
    ].join("\n"),
  );
  const scopedPackageDirectory = join(directory, "node_modules/@lands-l10n");
  await mkdir(scopedPackageDirectory, { recursive: true });
  await symlink(packageDirectory, join(scopedPackageDirectory, "l10n"), "dir");
}

function landsJar(messages: string, version = "8.9.2"): Uint8Array {
  return zipSync({
    "plugin.yml": strToU8(`name: Lands\nversion: ${version}\n`),
    "Locale/en-US.yml": strToU8(messages),
  });
}

function landsJarWithUnregisteredResource(
  messages: string,
  notice = "title: New optional notice\n",
): Uint8Array {
  return zipSync({
    "plugin.yml": strToU8("name: Lands\nversion: 8.9.2\n"),
    "Locale/en-US.yml": strToU8(messages),
    "docs/NOTICE.yml": strToU8(notice),
  });
}

function landsJarWithUnregisteredFile(
  messages: string,
  resourcePath: string,
  resource: string,
): Uint8Array {
  return zipSync({
    "plugin.yml": strToU8("name: Lands\nversion: 8.9.2\n"),
    "Locale/en-US.yml": strToU8(messages),
    [resourcePath]: strToU8(resource),
  });
}

async function createLoreProject(directory: string): Promise<void> {
  await createProject(directory);
  await writeFile(
    join(directory, ".l10n/config.yml"),
    [
      "schemaVersion: 1",
      "source:",
      '  version: "8.9.2"',
      '  translationHistory: "fixture-history"',
      "resources:",
      "  - path: plugin.yml",
      "    purpose: metadata",
      "  - path: Locale/en-US.yml",
      "    purpose: chat-language",
      "  - path: Locale/en-US_gui.yml",
      "    purpose: gui-language",
      "  - path: Locale/definitions_gui.yml",
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
      "    - source: Locale/en-US_gui.yml",
      "      target: Locale/zh-CN_gui.yml",
      "      definitionsSource: Locale/definitions_gui.yml",
      "      fields:",
      "        - path: [gui, main, items, confirm, name]",
      "          category: gui-string",
      "          scene: gui-item-name",
      "        - path: [gui, main, items, confirm, help]",
      "          category: gui-string",
      "          scene: gui-general",
      "        - path: [gui, main, items, confirm, lore]",
      "          category: gui-lore",
      "          scene: gui-item-lore",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "Locale/zh-CN_gui.yml"),
    [
      "gui:",
      "  main:",
      "    items:",
      "      confirm:",
      "        material: DIAMOND",
      "        slot: 4",
      '        name: "确认"',
      "        flags:",
      "          managed: true",
      "          customSetting: true",
      '        lore: "旧译文"',
      "custom: 保留用户配置",
      "",
    ].join("\n"),
  );
}

function landsJarWithLore(
  lore: string | readonly string[],
  material = "DIAMOND",
  slot = 4,
  flagsShape: "mapping" | "scalar" | "omitted" = "mapping",
): Uint8Array {
  const loreValue = JSON.stringify(lore);
  const structure = [
    "gui:",
    "  main:",
    "    items:",
    "      confirm:",
    `        material: ${material}`,
    `        slot: ${slot}`,
    ...(flagsShape === "mapping"
      ? ["        flags:", "          managed: true"]
      : flagsShape === "scalar"
        ? ['        flags: "external"']
        : []),
    '        lore: "定义专用结构值"',
    "",
  ];
  return zipSync({
    "plugin.yml": strToU8("name: Lands\nversion: 8.9.2\n"),
    "Locale/en-US.yml": strToU8("messages:\n  greet: Hello\n"),
    "Locale/en-US_gui.yml": strToU8(
      [
        "gui:",
        "  main:",
        "    items:",
        "      confirm:",
        '        name: "Confirm"',
        '        help: "Help text"',
        `        lore: ${loreValue}`,
        "",
      ].join("\n"),
    ),
    "Locale/definitions_gui.yml": strToU8(structure.join("\n")),
  });
}

function landsJarWithCategories(
  material: string,
  enabled: boolean,
): Uint8Array {
  return zipSync({
    "plugin.yml": strToU8("name: Lands\nversion: 8.9.2\n"),
    "categories.yml": strToU8(
      [
        "land:",
        "  categories:",
        "    agriculture:",
        '      name: "Agriculture"',
        "      description:",
        '        - "Grows crops"',
        '        - "Raises animals"',
        `      material: ${material}`,
        "      rules:",
        `        enabled: ${enabled}`,
        "        permission: lands.category.agriculture",
        "",
      ].join("\n"),
    ),
  });
}

function landsJarWithDialog(
  action: string,
  visible: boolean,
  enabled: boolean,
): Uint8Array {
  return zipSync({
    "plugin.yml": strToU8("name: Lands\nversion: 8.9.2\n"),
    "Locale/en-US_dialogs.yml": strToU8(
      [
        "dialogs:",
        "  confirm:",
        '    title: "Confirm"',
        "    buttons:",
        "      accept:",
        '        label: "Accept"',
        `        action: ${action}`,
        `        visible: ${visible}`,
        "        options:",
        `          enabled: ${enabled}`,
        "",
      ].join("\n"),
    ),
  });
}

async function createMixedConfigurationProject(
  directory: string,
): Promise<void> {
  await createProject(directory);
  await writeFile(
    join(directory, ".l10n/config.yml"),
    [
      "schemaVersion: 1",
      "source:",
      '  version: "8.9.2"',
      '  translationHistory: "fixture-history"',
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
      "      target: categories-zh.yml",
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
  await writeFile(
    join(directory, "categories-zh.yml"),
    [
      "land:",
      "  categories:",
      "    agriculture:",
      '      name: "农业"',
      "      description:",
      '        - "种植作物"',
      '        - "饲养动物"',
      "      material: WHEAT",
      "      rules:",
      "        enabled: true",
      "        permission: lands.category.agriculture",
      "        customSetting: true",
      "      customField: keep",
      "customRoot: keep",
      "",
    ].join("\n"),
  );
}

async function createDialogProject(directory: string): Promise<void> {
  await createProject(directory);
  await writeFile(
    join(directory, ".l10n/config.yml"),
    [
      "schemaVersion: 1",
      "source:",
      '  version: "8.9.2"',
      '  translationHistory: "fixture-history"',
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
      '        - path: [dialogs, "*", buttons, "*", label]',
      "          category: dialog-string",
      "          scene: dialog-button-label",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "Locale/zh-CN_dialogs.yml"),
    [
      "dialogs:",
      "  confirm:",
      '    title: "确认"',
      "    buttons:",
      "      accept:",
      '        label: "接受"',
      "        action: confirm",
      "        visible: true",
      "        options:",
      "          enabled: true",
      "          customSetting: keep",
      "customRoot: keep",
      "",
    ].join("\n"),
  );
}

async function prepareBaselineUpdate(
  t: import("node:test").TestContext,
): Promise<{
  readonly configPath: string;
  readonly baselinePath: string;
  readonly projectDirectory: string;
  readonly targetPath: string;
}> {
  const project = await mkdtemp(join(tmpdir(), "lioni-update-failure-"));
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const initialJar = join(project, "Lands-initial.jar");
  await writeFile(
    initialJar,
    landsJar(
      "messages:\n  greet: Hello\n  leave: Goodbye\n  legacy: Parting\n",
    ),
  );
  await prepareSource(configPath, initialJar);
  await rm(initialJar);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  const changedJar = join(project, "Lands-changed.jar");
  await writeFile(
    changedJar,
    landsJar(
      "messages:\n  greet: Hello again\n  leave: Goodbye again\n  legacy: Parting\n",
      "8.9.3",
    ),
  );
  await prepareSource(configPath, changedJar, "8.9.3");
  await rm(changedJar);
  return {
    configPath,
    baselinePath: join(project, ".lioni/lioni.baseline.json"),
    projectDirectory: project,
    targetPath: join(project, "Locale/zh-CN.yml"),
  };
}

void test("原生 update 回填变化与缺失消息并保留未变中文及 YAML 注释", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "lioni-update-"));
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const initialJar = join(project, "Lands-initial.jar");
  const changedJar = join(project, "Lands-changed.jar");
  await writeFile(
    initialJar,
    landsJar(
      "messages:\n  greet: Hello\n  leave: Goodbye\n  legacy: Parting\n",
    ),
  );
  await prepareSource(configPath, initialJar);
  await rm(initialJar);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  await writeFile(
    changedJar,
    landsJar(
      "messages:\n  greet: Hello again\n  leave: Goodbye\n  fresh: New sentence\n  renamed: Parting\n",
      "8.9.3",
    ),
  );
  await prepareSource(configPath, changedJar, "8.9.3");
  await rm(changedJar);

  const targetPath = join(project, "Locale/zh-CN.yml");
  const baselinePath = join(project, ".lioni/lioni.baseline.json");
  const originalTarget = await readFile(targetPath);
  const originalBaseline = await readFile(baselinePath);
  runLioni([
    "update",
    configPath,
    "--dry-run",
    "--output-format",
    "structured",
  ]);
  assert.deepEqual(await readFile(targetPath), originalTarget);
  assert.deepEqual(await readFile(baselinePath), originalBaseline);

  runLioni([
    "update",
    configPath,
    "--record-baseline",
    "--output-format",
    "structured",
  ]);

  const targetText = await readFile(targetPath, "utf8");
  const target = parseDocument(targetText).toJS() as {
    readonly messages: Record<string, unknown>;
    readonly custom: string;
  };
  assert.equal(target.messages.greet, "Hello again");
  assert.equal(target.messages.leave, "再见");
  assert.equal(target.messages.fresh, "New sentence");
  assert.equal(target.messages.renamed, "Parting");
  assert.equal(target.custom, "保留用户字段");
  assert.match(targetText, /# 保留文件注释/u);
  assert.match(targetText, /# 保留字段注释/u);
  assert.notDeepEqual(await readFile(baselinePath), originalBaseline);

  const recordedBaseline = await readFile(baselinePath);
  await writeFile(
    targetPath,
    targetText.replace("leave: 再见", "leave: 人工校订"),
  );
  runLioni(["update", configPath, "--output-format", "structured"]);
  const afterManualEdit = parseDocument(
    await readFile(targetPath, "utf8"),
  ).toJS() as { readonly messages: Record<string, unknown> };
  assert.equal(afterManualEdit.messages.leave, "人工校订");
  assert.deepEqual(await readFile(baselinePath), recordedBaseline);
});

void test("无比较基线时保留已有中文并只填入缺失消息", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "lioni-update-no-baseline-"));
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const jarPath = join(project, "Lands.jar");
  await writeFile(
    jarPath,
    landsJar(
      "messages:\n  greet: Hello\n  leave: Goodbye\n  legacy: Parting\n  fresh: New sentence\n",
    ),
  );
  await prepareSource(configPath, jarPath);
  await rm(jarPath);
  runLioni(["update", configPath, "--output-format", "structured"]);

  const target = parseDocument(
    await readFile(join(project, "Locale/zh-CN.yml"), "utf8"),
  ).toJS() as { readonly messages: Record<string, unknown> };
  assert.equal(target.messages.greet, "你好");
  assert.equal(target.messages.leave, "再见");
  assert.equal(target.messages.legacy, "旧译文");
  assert.equal(target.messages.fresh, "New sentence");
  await assert.rejects(readFile(join(project, ".lioni/lioni.baseline.json")));
});

void test("上游删除已编辑的受管消息并在重复同步后保持幂等", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "lioni-update-message-delete-"));
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const initialJar = join(project, "Lands-initial.jar");
  await writeFile(
    initialJar,
    landsJar(
      "messages:\n  greet: Hello\n  leave: Goodbye\n  legacy: Parting\n",
    ),
  );
  await prepareSource(configPath, initialJar);
  await rm(initialJar);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  const targetPath = join(project, "Locale/zh-CN.yml");
  await writeFile(
    targetPath,
    (await readFile(targetPath, "utf8")).replace(
      "leave: 再见",
      "leave: 人工校订",
    ),
  );
  const changedJar = join(project, "Lands-message-removed.jar");
  await writeFile(
    changedJar,
    landsJar("messages:\n  greet: Hello\n  legacy: Parting\n"),
  );
  await prepareSource(configPath, changedJar);
  await rm(changedJar);

  runLioni([
    "update",
    configPath,
    "--record-baseline",
    "--output-format",
    "structured",
  ]);
  const afterDelete = parseDocument(
    await readFile(targetPath, "utf8"),
  ).toJS() as { readonly messages: Record<string, unknown> };
  assert.equal(Object.hasOwn(afterDelete.messages, "leave"), false);

  runLioni([
    "update",
    configPath,
    "--record-baseline",
    "--output-format",
    "structured",
  ]);
  const afterRepeat = parseDocument(
    await readFile(targetPath, "utf8"),
  ).toJS() as { readonly messages: Record<string, unknown> };
  assert.equal(Object.hasOwn(afterRepeat.messages, "leave"), false);
});

void test("新增范围外普通资源只提示、不扩大翻译范围并可推进基线", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "lioni-update-new-resource-"));
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const initialJar = join(project, "Lands-initial.jar");
  await writeFile(
    initialJar,
    landsJar(
      "messages:\n  greet: Hello\n  leave: Goodbye\n  legacy: Parting\n",
    ),
  );
  await prepareSource(configPath, initialJar);
  await rm(initialJar);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  const targetPath = join(project, "Locale/zh-CN.yml");
  const originalTarget = await readFile(targetPath);
  const baselinePath = join(project, ".lioni/lioni.baseline.json");
  const originalBaseline = await readFile(baselinePath);
  const changedJar = join(project, "Lands-with-ordinary-resource.jar");
  await writeFile(
    changedJar,
    landsJarWithUnregisteredResource(
      "messages:\n  greet: Hello\n  leave: Goodbye\n  legacy: Parting\n",
    ),
  );
  await prepareSource(configPath, changedJar);
  await rm(changedJar);

  const output = runLioni([
    "update",
    configPath,
    "--record-baseline",
    "--output-format",
    "structured",
  ]);
  assert.match(output, /docs\/NOTICE\.yml/u);
  assert.match(output, /不自动加入翻译维护范围/u);
  const envelope = JSON.parse(output) as {
    readonly data: {
      readonly plan: {
        readonly current: {
          readonly source: {
            readonly read: {
              readonly scopes: readonly {
                readonly range: {
                  readonly kind: string;
                  readonly path: string;
                };
                readonly enumeration: string;
              }[];
            };
          };
        };
      };
    };
  };
  const noticeScope = envelope.data.plan.current.source.read.scopes.find(
    ({ range }) => range.path === "docs/NOTICE.yml",
  );
  assert.ok(noticeScope);
  assert.deepEqual(noticeScope.range, {
    kind: "lands-unregistered-resource",
    path: "docs/NOTICE.yml",
  });
  assert.equal(noticeScope.enumeration, "complete");
  assert.deepEqual(await readFile(targetPath), originalTarget);
  assert.notDeepEqual(await readFile(baselinePath), originalBaseline);
  await assert.rejects(readFile(join(project, "docs/NOTICE-zh.yml")));

  const recordedBaseline = await readFile(baselinePath);
  const repeatedJar = join(
    project,
    "Lands-with-changed-unregistered-resource.jar",
  );
  await writeFile(
    repeatedJar,
    landsJarWithUnregisteredResource(
      "messages:\n  greet: Hello\n  leave: Goodbye\n  legacy: Parting\n",
      "title: Updated optional notice\n",
    ),
  );
  await prepareSource(configPath, repeatedJar);
  await rm(repeatedJar);
  const repeatedOutput = runLioni([
    "update",
    configPath,
    "--record-baseline",
    "--output-format",
    "structured",
  ]);
  assert.doesNotMatch(
    repeatedOutput,
    /发现未登记的普通资源 docs\/NOTICE\.yml/u,
  );
  assert.deepEqual(await readFile(baselinePath), recordedBaseline);
  assert.deepEqual(await readFile(targetPath), originalTarget);
});

void test("未登记的新增源语言文件要求明确纳入范围且不推进基线", async (t) => {
  const project = await mkdtemp(
    join(tmpdir(), "lioni-update-new-language-resource-"),
  );
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const initialJar = join(project, "Lands-initial.jar");
  await writeFile(
    initialJar,
    landsJar("messages:\n  greet: Hello\n  leave: Goodbye\n"),
  );
  await prepareSource(configPath, initialJar);
  await rm(initialJar);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  const targetPath = join(project, "Locale/zh-CN.yml");
  const originalTarget = await readFile(targetPath);
  const baselinePath = join(project, ".lioni/lioni.baseline.json");
  const originalBaseline = await readFile(baselinePath);
  for (const [resourcePath, resource] of [
    [
      "Locale/NewModule/en-US.yml",
      "messages:\n  greeting: Hello from the new module\n",
    ],
    [
      "Locale/NewModule/definitions_gui.yml",
      "gui:\n  confirm:\n    material: STONE\n",
    ],
  ] as const) {
    const changedJar = join(
      project,
      `Lands-with-${resourcePath.split("/").at(-1)}`,
    );
    await writeFile(
      changedJar,
      landsJarWithUnregisteredFile(
        "messages:\n  greet: Hello\n  leave: Goodbye\n",
        resourcePath,
        resource,
      ),
    );
    await prepareSource(configPath, changedJar);
    await rm(changedJar);

    const updateResult = spawnSync(
      process.execPath,
      [
        nativeCli,
        "update",
        configPath,
        "--record-baseline",
        "--output-format",
        "structured",
      ],
      { cwd: tmpdir(), encoding: "utf8" },
    );
    assert.equal(
      updateResult.status,
      1,
      updateResult.stderr || updateResult.stdout,
    );
    const envelope = JSON.parse(updateResult.stdout || updateResult.stderr) as {
      readonly data: {
        readonly status: string;
        readonly baseline?: { readonly outcome: string };
        readonly plan?: {
          readonly current: {
            readonly source: {
              readonly read: {
                readonly scopes: readonly {
                  readonly range: {
                    readonly kind: string;
                    readonly path: string;
                  };
                  readonly enumeration: string;
                  readonly error?: string;
                }[];
              };
            };
          };
        };
      };
    };
    assert.equal(envelope.data.status, "failed");
    assert.equal(envelope.data.baseline?.outcome, "notAdvanced");
    const scope = envelope.data.plan?.current.source.read.scopes.find(
      ({ range }) => range.path === resourcePath,
    );
    assert.ok(scope);
    assert.deepEqual(scope.range, {
      kind: "lands-unregistered-resource",
      path: resourcePath,
    });
    assert.equal(scope.enumeration, "partial");
    assert.match(scope.error ?? "", /来源语言或 GUI 结构资源/u);
    assert.deepEqual(await readFile(baselinePath), originalBaseline);
    assert.deepEqual(await readFile(targetPath), originalTarget);
    await assert.rejects(readFile(join(project, "Locale/NewModule/zh-CN.yml")));
    await assert.rejects(
      readFile(join(project, "Locale/NewModule/zh-CN_gui.yml")),
    );
  }
});

void test("整份退出翻译范围的目标文件留给维护者且未读取时不推进基线", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "lioni-update-scope-exit-"));
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const jarPath = join(project, "Lands.jar");
  await writeFile(
    jarPath,
    landsJar(
      "messages:\n  greet: Hello\n  leave: Goodbye\n  legacy: Parting\n",
    ),
  );
  await prepareSource(configPath, jarPath);
  await rm(jarPath);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  const targetPath = join(project, "Locale/zh-CN.yml");
  const originalTarget = Buffer.from(
    (await readFile(targetPath, "utf8")).replace(
      "leave: 再见",
      "leave: 人工保留",
    ),
  );
  await writeFile(targetPath, originalTarget);
  await writeFile(
    join(project, ".l10n/config.yml"),
    [
      "schemaVersion: 1",
      "source:",
      '  version: "8.9.2"',
      '  translationHistory: "fixture-history"',
      "resources:",
      "  - path: plugin.yml",
      "    purpose: metadata",
      "  - path: Locale/en-US.yml",
      "    purpose: chat-language",
      "translationScope:",
      '  sourceLanguage: "en-US"',
      '  targetLanguage: "zh-CN"',
      "  mappings: []",
      "",
    ].join("\n"),
  );

  const baselinePath = join(project, ".lioni/lioni.baseline.json");
  const originalBaseline = await readFile(baselinePath);
  const updateResult = spawnSync(
    process.execPath,
    [
      nativeCli,
      "update",
      configPath,
      "--record-baseline",
      "--output-format",
      "structured",
    ],
    { cwd: tmpdir(), encoding: "utf8" },
  );
  assert.equal(
    updateResult.status,
    1,
    updateResult.stderr || updateResult.stdout,
  );
  const envelope = JSON.parse(updateResult.stdout || updateResult.stderr) as {
    readonly data: {
      readonly status: string;
      readonly baseline?: { readonly outcome: string };
    };
  };
  assert.equal(envelope.data.status, "failed");
  assert.equal(envelope.data.baseline?.outcome, "notAdvanced");
  assert.deepEqual(await readFile(baselinePath), originalBaseline);
  assert.deepEqual(await readFile(targetPath), originalTarget);
});

void test("GUI lore 类型变化整体更新后可推进结构比较基线", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "lioni-update-lore-type-"));
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createLoreProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const initialJar = join(project, "Lands-initial.jar");
  await writeFile(initialJar, landsJarWithLore("Same line"));
  await prepareSource(configPath, initialJar);
  await rm(initialJar);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  const changedJar = join(project, "Lands-changed.jar");
  await writeFile(changedJar, landsJarWithLore(["Same line"]));
  await prepareSource(configPath, changedJar);
  await rm(changedJar);
  const baselinePath = join(project, ".lioni/lioni.baseline.json");
  const originalBaseline = await readFile(baselinePath);
  runLioni([
    "update",
    configPath,
    "--record-baseline",
    "--output-format",
    "structured",
  ]);
  assert.notDeepEqual(await readFile(baselinePath), originalBaseline);

  const target = parseDocument(
    await readFile(join(project, "Locale/zh-CN_gui.yml"), "utf8"),
  ).toJS() as {
    readonly gui: {
      readonly main: {
        readonly items: {
          readonly confirm: { readonly lore: unknown };
        };
      };
    };
    readonly custom: string;
  };
  assert.deepEqual(target.gui.main.items.confirm.lore, ["Same line"]);
  assert.equal(target.custom, "保留用户配置");
});

void test("GUI 定义结构变化由原生 update 写回并保留译文与自定义字段", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "lioni-update-gui-structure-"));
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createLoreProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const initialJar = join(project, "Lands-initial.jar");
  await writeFile(initialJar, landsJarWithLore("Same line"));
  await prepareSource(configPath, initialJar);
  await rm(initialJar);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  const changedJar = join(project, "Lands-structure-changed.jar");
  await writeFile(changedJar, landsJarWithLore("Same line", "EMERALD", 4));
  await prepareSource(configPath, changedJar);
  await rm(changedJar);
  runLioni([
    "update",
    configPath,
    "--record-baseline",
    "--output-format",
    "structured",
  ]);

  const target = parseDocument(
    await readFile(join(project, "Locale/zh-CN_gui.yml"), "utf8"),
  ).toJS() as {
    readonly gui: {
      readonly main: {
        readonly items: {
          readonly confirm: {
            readonly material: unknown;
            readonly slot: unknown;
            readonly name: unknown;
            readonly help: unknown;
            readonly lore: unknown;
          };
        };
      };
    };
    readonly custom: string;
  };
  assert.equal(target.gui.main.items.confirm.material, "EMERALD");
  assert.equal(target.gui.main.items.confirm.slot, 4);
  assert.equal(target.gui.main.items.confirm.name, "确认");
  assert.equal(target.gui.main.items.confirm.help, "Help text");
  assert.equal(target.gui.main.items.confirm.lore, "旧译文");
  assert.equal(target.custom, "保留用户配置");
});

void test("GUI definitions 来源缺失时保留结构并阻止比较基线推进", async (t) => {
  const project = await mkdtemp(
    join(tmpdir(), "lioni-update-gui-definitions-missing-"),
  );
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createLoreProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const initialJar = join(project, "Lands-initial.jar");
  await writeFile(initialJar, landsJarWithLore("Same line"));
  await prepareSource(configPath, initialJar);
  await rm(initialJar);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  const targetPath = join(project, "Locale/zh-CN_gui.yml");
  const originalTarget = await readFile(targetPath);
  const baselinePath = join(project, ".lioni/lioni.baseline.json");
  const originalBaseline = await readFile(baselinePath);
  const changedJar = join(project, "Lands-missing-definitions.jar");
  await writeFile(
    changedJar,
    zipSync({
      "plugin.yml": strToU8("name: Lands\nversion: 8.9.2\n"),
      "Locale/en-US.yml": strToU8("messages:\n  greet: Hello\n"),
      "Locale/en-US_gui.yml": strToU8(
        [
          "gui:",
          "  main:",
          "    items:",
          "      confirm:",
          '        name: "Confirm"',
          '        help: "Help text"',
          '        lore: "Same line"',
          "",
        ].join("\n"),
      ),
    }),
  );
  await prepareSource(configPath, changedJar);
  await rm(changedJar);

  const updateResult = spawnSync(
    process.execPath,
    [
      nativeCli,
      "update",
      configPath,
      "--record-baseline",
      "--output-format",
      "structured",
    ],
    { cwd: tmpdir(), encoding: "utf8" },
  );
  assert.equal(
    updateResult.status,
    1,
    updateResult.stderr || updateResult.stdout,
  );
  const envelope = JSON.parse(updateResult.stdout || updateResult.stderr) as {
    readonly data: {
      readonly status: string;
      readonly baseline?: { readonly outcome: string };
    };
  };
  assert.equal(envelope.data.status, "failed");
  assert.equal(envelope.data.baseline?.outcome, "notAdvanced");
  assert.deepEqual(await readFile(baselinePath), originalBaseline);
  const target = parseDocument(await readFile(targetPath, "utf8")).toJS() as {
    readonly gui: {
      readonly main: {
        readonly items: {
          readonly confirm: {
            readonly material: string;
            readonly slot: number;
            readonly name: string;
            readonly lore: string;
          };
        };
      };
    };
  };
  assert.equal(target.gui.main.items.confirm.material, "DIAMOND");
  assert.equal(target.gui.main.items.confirm.slot, 4);
  assert.equal(target.gui.main.items.confirm.name, "确认");
  assert.equal(target.gui.main.items.confirm.lore, "旧译文");
  assert.notDeepEqual(await readFile(targetPath), originalTarget);
});

void test("移除结构字段时只删受管键并保留结构对象中的自定义键", async (t) => {
  const project = await mkdtemp(
    join(tmpdir(), "lioni-update-structure-delete-"),
  );
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createLoreProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const initialJar = join(project, "Lands-initial.jar");
  await writeFile(initialJar, landsJarWithLore("Same line"));
  await prepareSource(configPath, initialJar);
  await rm(initialJar);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  const changedJar = join(project, "Lands-structure-removed.jar");
  await writeFile(
    changedJar,
    landsJarWithLore("Same line", "DIAMOND", 4, "omitted"),
  );
  await prepareSource(configPath, changedJar);
  await rm(changedJar);
  runLioni([
    "update",
    configPath,
    "--record-baseline",
    "--output-format",
    "structured",
  ]);

  const target = parseDocument(
    await readFile(join(project, "Locale/zh-CN_gui.yml"), "utf8"),
  ).toJS() as {
    readonly gui: {
      readonly main: {
        readonly items: {
          readonly confirm: {
            readonly flags: Record<string, unknown>;
          };
        };
      };
    };
  };
  assert.deepEqual(target.gui.main.items.confirm.flags, {
    customSetting: true,
  });
});

void test("混合配置按声明路径保留译文并更新结构字段与用户自定义键", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "lioni-update-mixed-config-"));
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createMixedConfigurationProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const initialJar = join(project, "Lands-initial.jar");
  await writeFile(initialJar, landsJarWithCategories("WHEAT", true));
  await prepareSource(configPath, initialJar);
  await rm(initialJar);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  const changedJar = join(project, "Lands-configuration-changed.jar");
  await writeFile(changedJar, landsJarWithCategories("CARROT", false));
  await prepareSource(configPath, changedJar);
  await rm(changedJar);
  runLioni([
    "update",
    configPath,
    "--record-baseline",
    "--output-format",
    "structured",
  ]);

  const target = parseDocument(
    await readFile(join(project, "categories-zh.yml"), "utf8"),
  ).toJS() as {
    readonly land: {
      readonly categories: {
        readonly agriculture: {
          readonly name: string;
          readonly description: readonly string[];
          readonly material: string;
          readonly rules: Record<string, unknown>;
          readonly customField: string;
        };
      };
    };
    readonly customRoot: string;
  };
  assert.equal(target.land.categories.agriculture.name, "农业");
  assert.deepEqual(target.land.categories.agriculture.description, [
    "种植作物",
    "饲养动物",
  ]);
  assert.equal(target.land.categories.agriculture.material, "CARROT");
  assert.deepEqual(target.land.categories.agriculture.rules, {
    enabled: false,
    permission: "lands.category.agriculture",
    customSetting: true,
  });
  assert.equal(target.land.categories.agriculture.customField, "keep");
  assert.equal(target.customRoot, "keep");
});

void test("对话文件的结构字段与译文通过同一更新链合并", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "lioni-update-dialog-"));
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createDialogProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const initialJar = join(project, "Lands-initial.jar");
  await writeFile(initialJar, landsJarWithDialog("confirm", true, true));
  await prepareSource(configPath, initialJar);
  await rm(initialJar);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  const changedJar = join(project, "Lands-dialog-structure-changed.jar");
  await writeFile(changedJar, landsJarWithDialog("submit", false, false));
  await prepareSource(configPath, changedJar);
  await rm(changedJar);
  runLioni([
    "update",
    configPath,
    "--record-baseline",
    "--output-format",
    "structured",
  ]);

  const target = parseDocument(
    await readFile(join(project, "Locale/zh-CN_dialogs.yml"), "utf8"),
  ).toJS() as {
    readonly dialogs: {
      readonly confirm: {
        readonly title: string;
        readonly buttons: {
          readonly accept: {
            readonly label: string;
            readonly action: string;
            readonly visible: boolean;
            readonly options: {
              readonly enabled: boolean;
              readonly customSetting: string;
            };
          };
        };
      };
    };
    readonly customRoot: string;
  };
  assert.equal(target.dialogs.confirm.title, "确认");
  assert.equal(target.dialogs.confirm.buttons.accept.label, "接受");
  assert.equal(target.dialogs.confirm.buttons.accept.action, "submit");
  assert.equal(target.dialogs.confirm.buttons.accept.visible, false);
  assert.deepEqual(target.dialogs.confirm.buttons.accept.options, {
    enabled: false,
    customSetting: "keep",
  });
  assert.equal(target.customRoot, "keep");
});

void test("结构字段类型变化只在目标仍等于历史来源时安全替换", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "lioni-update-structure-type-"));
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createLoreProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const initialJar = join(project, "Lands-initial.jar");
  await writeFile(initialJar, landsJarWithLore("Same line"));
  await prepareSource(configPath, initialJar);
  await rm(initialJar);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  const baselinePath = join(project, ".lioni/lioni.baseline.json");
  const originalBaseline = await readFile(baselinePath);
  const changedJar = join(project, "Lands-structure-type-changed.jar");
  await writeFile(
    changedJar,
    landsJarWithLore("Same line", "DIAMOND", 4, "scalar"),
  );
  await prepareSource(configPath, changedJar);
  await rm(changedJar);

  const updateResult = spawnSync(
    process.execPath,
    [
      nativeCli,
      "update",
      configPath,
      "--record-baseline",
      "--output-format",
      "structured",
    ],
    { cwd: tmpdir(), encoding: "utf8" },
  );
  assert.equal(
    updateResult.status,
    1,
    updateResult.stderr || updateResult.stdout,
  );
  const envelope = JSON.parse(updateResult.stdout || updateResult.stderr) as {
    readonly data: {
      readonly status: string;
      readonly plan: {
        readonly items: readonly {
          readonly action: string;
          readonly reason: string;
        }[];
      };
      readonly baseline?: { readonly outcome: string };
    };
  };
  assert.equal(envelope.data.status, "failed");
  assert.ok(
    envelope.data.plan.items.some(
      ({ action, reason }) =>
        action === "review" && reason.includes("目标类型变化"),
    ),
  );
  assert.equal(envelope.data.baseline?.outcome, "notAdvanced");
  assert.deepEqual(await readFile(baselinePath), originalBaseline);

  const target = parseDocument(
    await readFile(join(project, "Locale/zh-CN_gui.yml"), "utf8"),
  ).toJS() as {
    readonly gui: {
      readonly main: {
        readonly items: {
          readonly confirm: { readonly flags: Record<string, unknown> };
        };
      };
    };
  };
  assert.deepEqual(target.gui.main.items.confirm.flags, {
    managed: true,
    customSetting: true,
  });
});

void test("writeBatch 部分失败后逐项真实回读且不推进比较基线", async (t) => {
  const project = await prepareBaselineUpdate(t);
  const originalTarget = await readFile(project.targetPath);
  const originalBaseline = await readFile(project.baselinePath);
  const config = createLandsConfig(pathToFileURL(project.configPath));
  const adapter = config.translationWriteback;
  assert.ok(adapter?.writeBatch);
  const writeBatch = adapter.writeBatch;
  const interruptedConfig: typeof config = {
    ...config,
    translationWriteback: {
      ...adapter,
      writeBatch: async ({ requests }) => {
        await writeBatch({ requests: requests.slice(0, 1) });
        throw new Error("测试中断批次");
      },
    },
  };

  const result = await update(
    interruptedConfig,
    createFileComparisonBaselineStore(project.baselinePath),
    { recordBaseline: true },
  );

  assert.equal(result.status, "failed");
  assert.ok(result.results.some(({ status }) => status === "written"));
  assert.ok(
    result.results.some(
      ({ status }) => status === "writeFailed" || status === "writeUnconfirmed",
    ),
  );
  assert.equal(result.baseline?.outcome, "notAdvanced");
  assert.notDeepEqual(await readFile(project.targetPath), originalTarget);
  assert.deepEqual(await readFile(project.baselinePath), originalBaseline);
});

void test("writeBatch 未写入时报告 writeUnconfirmed 并保留译文基线", async (t) => {
  const project = await prepareBaselineUpdate(t);
  const originalTarget = await readFile(project.targetPath);
  const originalBaseline = await readFile(project.baselinePath);
  const config = createLandsConfig(pathToFileURL(project.configPath));
  const adapter = config.translationWriteback;
  assert.ok(adapter?.writeBatch);
  const unconfirmedConfig: typeof config = {
    ...config,
    translationWriteback: {
      ...adapter,
      writeBatch: async () => {},
    },
  };

  const result = await update(
    unconfirmedConfig,
    createFileComparisonBaselineStore(project.baselinePath),
    { recordBaseline: true },
  );

  assert.equal(result.status, "failed");
  assert.ok(
    result.results
      .filter(({ status }) => status !== "retained")
      .every(({ status }) => status === "writeUnconfirmed"),
    JSON.stringify(
      result.results.map(({ status, reason }) => ({ status, reason })),
    ),
  );
  assert.equal(result.baseline?.outcome, "notAdvanced");
  assert.deepEqual(await readFile(project.targetPath), originalTarget);
  assert.deepEqual(await readFile(project.baselinePath), originalBaseline);
});

void test("记录比较基线时部分语言选择在读取和写入前拒绝", async (t) => {
  const project = await prepareBaselineUpdate(t);
  const originalTarget = await readFile(project.targetPath);
  const originalBaseline = await readFile(project.baselinePath);
  const config = createLandsConfig(pathToFileURL(project.configPath));
  const translationAdapter = config.translations;
  assert.ok(translationAdapter);
  let sourceReads = 0;
  const sourceReader = config.source.read.bind(config.source);
  const twoLanguageConfig: typeof config = {
    ...config,
    source: {
      ...config.source,
      read: async () => {
        sourceReads += 1;
        return sourceReader();
      },
    },
    translations: {
      ...translationAdapter,
      languages: ["zh-CN", "zh-TW"],
    },
  };
  const fileStore = createFileComparisonBaselineStore(
    project.baselinePath,
  ) as unknown as BaselineStoreFor<typeof config>;

  await assert.rejects(
    update(twoLanguageConfig, fileStore, {
      languages: ["zh-CN"],
      recordBaseline: true,
    }),
    /记录比较基线要求本次更新覆盖全部配置语言/u,
  );

  assert.equal(sourceReads, 0);
  assert.deepEqual(await readFile(project.targetPath), originalTarget);
  assert.deepEqual(await readFile(project.baselinePath), originalBaseline);
});

void test("原文正文不完整时保留可用译文并不推进比较基线", async (t) => {
  const project = await prepareBaselineUpdate(t);
  const invalidJar = join(project.projectDirectory, "Lands-invalid.jar");
  await writeFile(
    invalidJar,
    landsJar(
      "messages:\n  greet: 5\n  leave: Goodbye again\n  legacy: Parting\n",
      "8.9.3",
    ),
  );
  await prepareSource(project.configPath, invalidJar, "8.9.3");
  await rm(invalidJar);
  const originalBaseline = await readFile(project.baselinePath);
  const config = createLandsConfig(pathToFileURL(project.configPath));
  const fileStore = createFileComparisonBaselineStore(
    project.baselinePath,
  ) as unknown as BaselineStoreFor<typeof config>;

  const result = await update(config, fileStore, { recordBaseline: true });

  assert.equal(result.status, "failed");
  assert.equal(result.baseline?.outcome, "notAdvanced");
  assert.match(result.baseline?.message ?? "", /原文读取不完整/u);
  const target = parseDocument(
    await readFile(project.targetPath, "utf8"),
  ).toJS() as {
    readonly messages: Record<string, unknown>;
  };
  assert.equal(target.messages.greet, "你好");
  assert.equal(target.messages.leave, "Goodbye again");
  assert.deepEqual(await readFile(project.baselinePath), originalBaseline);
});

void test("比较基线保存失败时保留已写入译文且明确不推进基线", async (t) => {
  const project = await prepareBaselineUpdate(t);
  const originalBaseline = await readFile(project.baselinePath);
  const config = createLandsConfig(pathToFileURL(project.configPath));
  const fileStore = createFileComparisonBaselineStore(
    project.baselinePath,
  ) as unknown as BaselineStoreFor<typeof config>;
  const failingStore: BaselineStoreFor<typeof config> = {
    load: () => fileStore.load(),
    save: async () => {
      throw new Error("测试拒绝保存比较基线");
    },
  };

  const result = await update(config, failingStore, { recordBaseline: true });

  assert.equal(result.status, "failed");
  assert.ok(
    result.results
      .filter(({ status }) => status !== "retained")
      .every(({ status }) => status === "written"),
  );
  assert.equal(result.baseline?.outcome, "failed");
  const target = parseDocument(
    await readFile(project.targetPath, "utf8"),
  ).toJS() as { readonly messages: Record<string, unknown> };
  assert.equal(target.messages.greet, "Hello again");
  assert.equal(target.messages.leave, "Goodbye again");
  assert.deepEqual(await readFile(project.baselinePath), originalBaseline);
});

void test("执行期间来源变化时保留已写结果但不推进比较基线", async (t) => {
  const project = await prepareBaselineUpdate(t);
  const originalBaseline = await readFile(project.baselinePath);
  const laterJar = join(project.projectDirectory, "Lands-later.jar");
  await writeFile(
    laterJar,
    landsJar(
      "messages:\n  greet: Later source\n  leave: Goodbye again\n  legacy: Parting\n",
      "8.9.4",
    ),
  );
  const config = createLandsConfig(pathToFileURL(project.configPath));
  const adapter = config.translationWriteback;
  assert.ok(adapter?.writeBatch);
  const writeBatch = adapter.writeBatch;
  const sourceChangingConfig: typeof config = {
    ...config,
    translationWriteback: {
      ...adapter,
      writeBatch: async (input) => {
        await writeBatch(input);
        await prepareSource(project.configPath, laterJar, "8.9.4");
      },
    },
  };
  const fileStore = createFileComparisonBaselineStore(
    project.baselinePath,
  ) as unknown as BaselineStoreFor<typeof config>;

  const result = await update(sourceChangingConfig, fileStore, {
    recordBaseline: true,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.baseline?.outcome, "notAdvanced");
  assert.match(result.baseline?.message ?? "", /原文与本次更新依据不一致/u);
  const target = parseDocument(
    await readFile(project.targetPath, "utf8"),
  ).toJS() as { readonly messages: Record<string, unknown> };
  assert.equal(target.messages.greet, "Hello again");
  assert.equal(target.messages.leave, "Goodbye again");
  assert.deepEqual(await readFile(project.baselinePath), originalBaseline);
});
