import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { strToU8, zipSync } from "fflate";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeCli = join(packageDirectory, "node_modules/.bin/lioni");
const sourcePreparer = join(
  packageDirectory,
  "scripts/prepare-lioni-source.ts",
);

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
      "        - path: [gui, '*', items, '*', name]",
      "          category: gui-string",
      "          scene: gui-item-name",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "Locale/zh-CN.yml"),
    "messages:\n  greet: 你好\n  leave: 再见\n",
  );
  await writeFile(
    join(directory, "Locale/zh-CN_gui.yml"),
    [
      "gui:",
      "  main:",
      "    items:",
      "      confirm:",
      "        material: EMERALD",
      "        slot: 4",
      "        name: 确认",
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

function landsJar(reverseResources = false): Uint8Array {
  const entries = [
    ["plugin.yml", "name: Lands\nversion: 8.9.2\n"],
    [
      "Locale/en-US.yml",
      "messages:\n  greet: Hello\n  leave: Goodbye\n  command: /lands\n",
    ],
    [
      "Locale/en-US_gui.yml",
      "gui:\n  main:\n    items:\n      confirm:\n        name: Confirm\n        action: confirm\n",
    ],
    [
      "Locale/definitions_gui.yml",
      "gui:\n  main:\n    items:\n      confirm:\n        material: DIAMOND\n        slot: 4\n        action: confirm\n        name: Confirm\n",
    ],
    [
      "Locale/unregistered.yml",
      "messages:\n  arbitrary: This must stay out of scope\n",
    ],
  ] as const;
  const resources = reverseResources ? [...entries].reverse() : entries;
  return zipSync(
    Object.fromEntries(
      resources.map(([path, value]) => [path, strToU8(value)]),
    ),
  );
}

interface InspectedFacts {
  readonly version: string;
  readonly source: {
    readonly version: string;
    readonly read: {
      readonly status: string;
      readonly scopes: readonly {
        readonly range: unknown;
        readonly enumeration: string;
        readonly recordCount: number;
      }[];
    };
    readonly units: readonly {
      readonly key: string;
      readonly unit: unknown;
      readonly bodyAvailability: string;
    }[];
  };
  readonly translations: {
    readonly reads: readonly {
      readonly language: string;
      readonly status: string;
      readonly scopes: readonly {
        readonly range: unknown;
        readonly covers: readonly string[];
        readonly enumeration: string;
        readonly translationIndexes: readonly number[];
      }[];
    }[];
    readonly records: readonly {
      readonly identity: {
        readonly namespace: string;
        readonly key: string;
      };
      readonly translation: unknown;
      readonly bodyAvailability: string;
    }[];
  };
  readonly associations: readonly {
    readonly sourceKey: string;
    readonly status: string;
    readonly coverageStatus: string;
  }[];
}

interface InspectEnvelope {
  readonly command: string;
  readonly kind: string;
  readonly variant: string;
  readonly data: InspectedFacts;
}

function inspect(configPath: string): InspectedFacts {
  const result = spawnSync(
    process.execPath,
    [nativeCli, "inspect", configPath, "--output-format", "structured"],
    { cwd: tmpdir(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout) as InspectEnvelope;
  assert.equal(envelope.command, "inspect");
  assert.equal(envelope.kind, "data");
  assert.equal(envelope.variant, "read");
  return envelope.data;
}

function prepareSource(configPath: string, jarPath: string): void {
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
}

void test("原生 inspect 离线读取 Lands 消息、结构及稳定身份", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "lioni-inspect-"));
  const reorderedProject = await mkdtemp(
    join(tmpdir(), "lioni-inspect-order-"),
  );
  t.after(async () => {
    await Promise.all([
      rm(project, { force: true, recursive: true }),
      rm(reorderedProject, { force: true, recursive: true }),
    ]);
  });
  await Promise.all([createProject(project), createProject(reorderedProject)]);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const reorderedConfigPath = join(reorderedProject, ".lioni/lioni.config.ts");
  const jarPath = join(project, "Lands.jar");
  const reorderedJarPath = join(reorderedProject, "Lands.jar");
  await Promise.all([
    writeFile(jarPath, landsJar()),
    writeFile(reorderedJarPath, landsJar(true)),
  ]);
  prepareSource(configPath, jarPath);
  prepareSource(reorderedConfigPath, reorderedJarPath);
  await Promise.all([rm(jarPath), rm(reorderedJarPath)]);

  const facts = inspect(configPath);
  const repeatedFacts = inspect(configPath);
  const reorderedFacts = inspect(reorderedConfigPath);
  assert.equal(facts.source.read.status, "complete");
  assert.equal(facts.translations.reads[0]?.status, "complete");
  assert.equal(facts.source.units.length, 4);
  assert.deepEqual(
    facts.source.units.map(({ key }) => key),
    repeatedFacts.source.units.map(({ key }) => key),
  );
  assert.deepEqual(
    facts.source.units.map(({ key }) => key),
    reorderedFacts.source.units.map(({ key }) => key),
  );
  assert.deepEqual(
    facts.translations.records.map(({ identity }) => identity),
    reorderedFacts.translations.records.map(({ identity }) => identity),
  );

  const greeting = facts.source.units.find(({ key }) =>
    key.includes('"greet"'),
  );
  assert.ok(greeting);
  assert.equal(greeting.key, 'Locale/en-US.yml:["messages","greet"]');
  const associationByKey = new Map(
    facts.associations.map(({ sourceKey, status }) => [sourceKey, status]),
  );
  assert.equal(associationByKey.get(greeting.key), "matched");
  assert.equal(
    [...associationByKey.entries()].find(([key]) =>
      key.includes('"command"'),
    )?.[1],
    "missing",
  );

  const guiUnit = facts.source.units.find(({ key }) =>
    key.includes("Locale/en-US_gui.yml"),
  );
  assert.ok(guiUnit);
  const guiContext = (
    guiUnit.unit as {
      readonly context: {
        readonly category: string;
        readonly scene?: string;
        readonly format?: string;
        readonly fieldPath: readonly string[];
      };
    }
  ).context;
  assert.deepEqual(
    {
      category: guiContext.category,
      scene: guiContext.scene,
      format: guiContext.format,
      fieldPath: guiContext.fieldPath,
    },
    {
      category: "gui-string",
      scene: "gui-item-name",
      format: "legacy-color-minimessage",
      fieldPath: ["gui", "*", "items", "*", "name"],
    },
  );

  const unknownResource = facts.source.read.scopes.find(({ range }) =>
    JSON.stringify(range).includes("Locale/unregistered.yml"),
  );
  const sourceRange = facts.source.read.scopes.find(({ range }) =>
    JSON.stringify(range).includes("Locale/en-US_gui.yml"),
  );
  assert.deepEqual(sourceRange?.range, {
    kind: "lands-resource",
    path: "Locale/en-US_gui.yml",
  });
  assert.equal(unknownResource?.recordCount, 0);
  assert.equal(
    facts.source.units.some(({ unit }) =>
      JSON.stringify(unit).includes("This must stay out of scope"),
    ),
    false,
  );
  assert.equal(
    facts.translations.records.some(({ translation }) =>
      JSON.stringify(translation).includes("This must stay out of scope"),
    ),
    false,
  );

  const guiScope = facts.translations.reads[0]?.scopes.find(({ range }) =>
    JSON.stringify(range).includes("Locale/zh-CN_gui.yml"),
  );
  assert.deepEqual(guiScope?.range, {
    kind: "lands-target-resource",
    sourceFile: "Locale/en-US_gui.yml",
    targetFile: "Locale/zh-CN_gui.yml",
  });
});

void test("原生 inspect 区分目标缺失、结构阻断、正文不可用和资源读取失败", async (t) => {
  const missingProject = await mkdtemp(
    join(tmpdir(), "lioni-inspect-missing-"),
  );
  const blockedProject = await mkdtemp(
    join(tmpdir(), "lioni-inspect-blocked-"),
  );
  const unavailableProject = await mkdtemp(
    join(tmpdir(), "lioni-inspect-unavailable-"),
  );
  const failedProject = await mkdtemp(join(tmpdir(), "lioni-inspect-failed-"));
  t.after(async () => {
    await Promise.all([
      rm(missingProject, { force: true, recursive: true }),
      rm(blockedProject, { force: true, recursive: true }),
      rm(unavailableProject, { force: true, recursive: true }),
      rm(failedProject, { force: true, recursive: true }),
    ]);
  });
  await Promise.all([
    createProject(missingProject),
    createProject(blockedProject),
    createProject(unavailableProject),
    createProject(failedProject),
  ]);

  for (const project of [
    missingProject,
    blockedProject,
    unavailableProject,
    failedProject,
  ]) {
    const configPath = join(project, ".lioni/lioni.config.ts");
    const jarPath = join(project, "Lands.jar");
    await writeFile(jarPath, landsJar());
    prepareSource(configPath, jarPath);
    await rm(jarPath);
  }
  await Promise.all([
    rm(join(missingProject, "Locale/zh-CN.yml")),
    writeFile(
      join(blockedProject, "Locale/zh-CN_gui.yml"),
      'gui: "这里的字段祖先不是映射"\n',
    ),
    writeFile(
      join(unavailableProject, "Locale/zh-CN_gui.yml"),
      "gui:\n  main:\n    items:\n      confirm:\n        name: 4\n",
    ),
    writeFile(join(failedProject, "Locale/zh-CN_gui.yml"), "gui: [\n"),
  ]);

  const missingFacts = inspect(join(missingProject, ".lioni/lioni.config.ts"));
  const missingGreeting = missingFacts.source.units.find(({ key }) =>
    key.includes('"greet"'),
  );
  assert.ok(missingGreeting);
  assert.equal(
    missingFacts.associations.find(
      ({ sourceKey }) => sourceKey === missingGreeting.key,
    )?.status,
    "missing",
  );

  const blockedFacts = inspect(join(blockedProject, ".lioni/lioni.config.ts"));
  const blockedGuiUnit = blockedFacts.source.units.find(({ key }) =>
    key.includes("Locale/en-US_gui.yml"),
  );
  assert.ok(blockedGuiUnit);
  assert.equal(
    blockedFacts.associations.find(
      ({ sourceKey }) => sourceKey === blockedGuiUnit.key,
    )?.status,
    "unknown",
  );
  assert.equal(
    blockedFacts.associations.find(
      ({ sourceKey }) => sourceKey === blockedGuiUnit.key,
    )?.coverageStatus,
    "incomplete",
  );

  const unavailableFacts = inspect(
    join(unavailableProject, ".lioni/lioni.config.ts"),
  );
  const unavailableGuiUnit = unavailableFacts.source.units.find(({ key }) =>
    key.includes("Locale/en-US_gui.yml"),
  );
  assert.ok(unavailableGuiUnit);
  assert.equal(
    unavailableFacts.associations.find(
      ({ sourceKey }) => sourceKey === unavailableGuiUnit.key,
    )?.status,
    "unavailable",
  );
  assert.ok(
    unavailableFacts.translations.records.some(
      ({ identity, bodyAvailability }) =>
        identity.namespace === "Locale/zh-CN_gui.yml" &&
        bodyAvailability === "unavailable",
    ),
  );

  const failedFacts = inspect(join(failedProject, ".lioni/lioni.config.ts"));
  const failedGuiUnit = failedFacts.source.units.find(({ key }) =>
    key.includes("Locale/en-US_gui.yml"),
  );
  assert.ok(failedGuiUnit);
  assert.equal(
    failedFacts.associations.find(
      ({ sourceKey }) => sourceKey === failedGuiUnit.key,
    )?.status,
    "unknown",
  );
  assert.ok(
    failedFacts.translations.reads[0]?.scopes.some(
      ({ range, enumeration }) =>
        JSON.stringify(range).includes("Locale/zh-CN_gui.yml") &&
        enumeration === "failed",
    ),
  );
});
