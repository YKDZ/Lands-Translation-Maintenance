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
): Uint8Array {
  const loreValue = JSON.stringify(lore);
  return zipSync({
    "plugin.yml": strToU8("name: Lands\nversion: 8.9.2\n"),
    "Locale/en-US.yml": strToU8("messages:\n  greet: Hello\n"),
    "Locale/en-US_gui.yml": strToU8(
      `gui:\n  main:\n    items:\n      confirm:\n        lore: ${loreValue}\n`,
    ),
    "Locale/definitions_gui.yml": strToU8(
      [
        "gui:",
        "  main:",
        "    items:",
        "      confirm:",
        `        material: ${material}`,
        `        slot: ${slot}`,
        '        lore: "定义专用结构值"',
        "",
      ].join("\n"),
    ),
  });
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

void test("GUI lore 严格更新整体字段，但结构映射仍待处理", async (t) => {
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
          readonly after?: { readonly content: unknown };
        }[];
      };
      readonly baseline?: { readonly outcome: string };
    };
  };
  assert.equal(envelope.data.status, "failed");
  const fieldUpdate = envelope.data.plan.items.find(
    ({ action }) => action === "write",
  );
  assert.ok(fieldUpdate);
  assert.deepEqual(fieldUpdate.after?.content, ["Same line"]);
  assert.equal(envelope.data.baseline?.outcome, "notAdvanced");
  assert.deepEqual(await readFile(baselinePath), originalBaseline);

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

void test("GUI 定义结构变化尚未支持时不把消息全保留当作完整更新", async (t) => {
  const project = await mkdtemp(
    join(tmpdir(), "lioni-update-structure-pending-"),
  );
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
  const changedJar = join(project, "Lands-structure-changed.jar");
  await writeFile(changedJar, landsJarWithLore("Same line", "EMERALD", 8));
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
    readonly kind: string;
    readonly variant: string;
    readonly data: {
      readonly status: string;
      readonly plan: {
        readonly items: readonly {
          readonly action: string;
          readonly sourceKey?: string;
          readonly request?: unknown;
          readonly language: string;
          readonly changes: { readonly translations: readonly unknown[] };
          readonly reason: string;
        }[];
      };
      readonly baseline?: { readonly outcome: string };
    };
  };
  assert.equal(envelope.kind, "failure");
  assert.equal(envelope.variant, "applyFailed");
  assert.equal(envelope.data.status, "failed");
  const pendingStructure = envelope.data.plan.items.find(
    ({ action }) => action === "review",
  );
  assert.ok(pendingStructure);
  assert.equal(pendingStructure.sourceKey, undefined);
  assert.equal(pendingStructure.request, undefined);
  assert.deepEqual(pendingStructure.changes.translations, []);
  assert.match(pendingStructure.reason, /结构映射/u);
  assert.equal(envelope.data.baseline?.outcome, "notAdvanced");
  assert.deepEqual(await readFile(baselinePath), originalBaseline);
  const target = parseDocument(
    await readFile(join(project, "Locale/zh-CN_gui.yml"), "utf8"),
  ).toJS() as {
    readonly gui: {
      readonly main: {
        readonly items: {
          readonly confirm: {
            readonly material: unknown;
            readonly slot: unknown;
          };
        };
      };
    };
  };
  assert.equal(target.gui.main.items.confirm.material, "DIAMOND");
  assert.equal(target.gui.main.items.confirm.slot, 4);
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
