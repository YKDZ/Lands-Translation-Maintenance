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
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readFacts } from "@lioni/lioni";
import { strToU8, zipSync } from "fflate";

import { createLandsConfig } from "../../lioni.config.ts";
import { miniMessageFactsInput } from "../../src/minimessage-quality.ts";

const packageDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const nativeCli = join(packageDirectory, "node_modules/.bin/lioni");
const sourcePreparer = join(
  packageDirectory,
  "scripts/prepare-lioni-source.ts",
);

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface NativeDiagnostic {
  readonly checkId: string;
  readonly executionId: number;
  readonly object: {
    readonly key: string;
    readonly code?: string;
    readonly origin?: string;
  };
  readonly location: {
    readonly range: {
      readonly file: string;
      readonly path: readonly (string | number)[];
      readonly start?: number;
      readonly end?: number;
    };
  };
  readonly severity: "error" | "warning" | "info";
  readonly evidence: readonly {
    readonly role: string;
    readonly value: unknown;
  }[];
  readonly handling: { readonly status: string };
}

interface QualityCheckResult {
  readonly checkId: string;
  readonly status: string;
  readonly diagnostics: readonly NativeDiagnostic[];
  readonly issues: readonly {
    readonly code: string;
    readonly message: string;
    readonly object?: { readonly key?: string };
    readonly location?: { readonly range: Readonly<Record<string, unknown>> };
  }[];
  readonly executions: readonly {
    readonly executionId: number;
    readonly sourceKey: string;
    readonly status: string;
  }[];
}

interface QualityReport {
  readonly status: string;
  readonly candidates: readonly {
    readonly sourceKey: string;
    readonly language: string;
    readonly content: unknown;
  }[];
  readonly factCoverage: {
    readonly associations: readonly {
      readonly sourceKey: string;
      readonly status: string;
      readonly candidateSelected: boolean;
    }[];
  };
  readonly checks: readonly QualityCheckResult[];
  readonly diagnostics: readonly NativeDiagnostic[];
  readonly exceptionApplicability: readonly {
    readonly checkId: string;
    readonly sourceKey: string;
    readonly status: string;
  }[];
}

interface NativeEnvelope {
  readonly command: string;
  readonly kind: string;
  readonly data?: QualityReport;
  readonly report?: QualityReport;
}

interface QualityProjectOptions {
  readonly sourceLore?: readonly string[];
  readonly targetLore?: readonly string[];
  readonly sourceVersion?: string;
  readonly structureMaterial?: string;
  readonly targetStructureMaterial?: string;
  readonly omitTargetMaterial?: boolean;
  readonly omitTargetAction?: boolean;
  readonly omitTargetName?: boolean;
  readonly targetCustomField?: boolean;
  readonly nestedStructure?: boolean;
  readonly chat?: { readonly source: string; readonly target: string };
}

function landsJar(
  theme: string,
  sourceName: string,
  sourceLore: readonly string[],
  sourceVersion: string,
  chat: QualityProjectOptions["chat"],
  structureMaterial = "EMERALD",
  nestedStructure = false,
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "Locale/en-US_gui.yml": strToU8(
      [
        "gui:",
        "  main:",
        "    items:",
        "      confirm:",
        `        name: ${JSON.stringify(sourceName)}`,
        `        lore: ${JSON.stringify(sourceLore)}`,
        "",
      ].join("\n"),
    ),
    "Locale/definitions_gui.yml": strToU8(
      [
        "gui:",
        "  main:",
        "    items:",
        "      confirm:",
        `        material: ${JSON.stringify(structureMaterial)}`,
        "        slot: 1",
        '        name: "<red>Confirm</red>"',
        `        lore: ${JSON.stringify(sourceLore)}`,
        "        action: confirm",
        "        customSettings: {}",
        ...(nestedStructure
          ? [
              "        structureSettings:",
              "          nested:",
              "            enabled: true",
            ]
          : []),
        "",
      ].join("\n"),
    ),
    "plugin.yml": strToU8(`name: Lands\nversion: ${sourceVersion}\n`),
    "Locale/theme.yml": strToU8(theme),
  };
  if (chat !== undefined) {
    files["Locale/en-US_messages.yml"] = strToU8(
      `messages:\n  greeting: ${JSON.stringify(chat.source)}\n`,
    );
  }
  return zipSync(files);
}

async function createQualityProject(
  t: TestContext,
  theme = 'theme:\n  tokens:\n    known: "<red>"\n',
  sourceName = "<red>Confirm</red>",
  targetName = "<red>确认</red>",
  options: QualityProjectOptions = {},
): Promise<{ readonly directory: string; readonly configPath: string }> {
  const sourceVersion = options.sourceVersion ?? "8.9.2";
  const sourceLore = options.sourceLore ?? [
    "<red>First line",
    "Second line</red>",
  ];
  const targetLore = options.targetLore ?? ["<red>第一行", "第二行</red>"];
  const resources = [
    "  - path: plugin.yml",
    "    purpose: metadata",
    "  - path: Locale/en-US_gui.yml",
    "    purpose: gui-language",
    "  - path: Locale/definitions_gui.yml",
    "    purpose: configuration",
    "  - path: Locale/theme.yml",
    "    purpose: configuration",
    ...(options.chat === undefined
      ? []
      : ["  - path: Locale/en-US_messages.yml", "    purpose: chat-language"]),
  ];
  const mappings = [
    "    - source: Locale/en-US_gui.yml",
    "      target: Locale/zh-CN_gui.yml",
    "      definitionsSource: Locale/definitions_gui.yml",
    "      fields:",
    "        - path: [gui, main, items, confirm, name]",
    "          category: gui-string",
    "          scene: gui-general",
    "        - path: [gui, main, items, confirm, lore]",
    "          category: gui-lore",
    "          scene: gui-item-lore",
    ...(options.chat === undefined
      ? []
      : [
          "    - source: Locale/en-US_messages.yml",
          "      target: Locale/zh-CN_messages.yml",
          "      fields:",
          "        - path: [messages, greeting]",
          "          category: chat-string",
        ]),
  ];
  const directory = await mkdtemp(join(tmpdir(), "lioni-quality-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await Promise.all([
    mkdir(join(directory, ".lioni"), { recursive: true }),
    mkdir(join(directory, ".lioni/terms"), { recursive: true }),
    mkdir(join(directory, "Locale"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(directory, ".lioni/terms/concepts.yaml"),
      [
        "concepts:",
        "  fixture-word:",
        "    note: 用于 QA 测试夹具。",
        "    sourceRefs:",
        "      - path: test fixture",
        '        commit: "fixture"',
        "        section: terms",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(directory, ".lioni/terms/en-US.yaml"),
      [
        "concepts:",
        "  fixture-word:",
        "    expressions:",
        "      - id: en-US-fixture-word",
        "        text: fixture phrase",
        "        usage: allowed",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(directory, ".lioni/terms/zh-CN.yaml"),
      [
        "concepts:",
        "  fixture-word:",
        "    expressions:",
        "      - id: zh-CN-夹具短语",
        "        text: 夹具短语",
        "        usage: allowed",
        "",
      ].join("\n"),
    ),
  ]);
  await writeFile(
    join(directory, ".lioni/project.yml"),
    [
      "format: lands-l10n-project/v1",
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
  await writeFile(
    join(directory, "Locale/zh-CN_gui.yml"),
    [
      "gui:",
      "  main:",
      "    items:",
      "      confirm:",
      ...(options.omitTargetMaterial
        ? []
        : [
            `        material: ${JSON.stringify(options.targetStructureMaterial ?? options.structureMaterial ?? "EMERALD")}`,
          ]),
      "        slot: 1",
      ...(options.omitTargetAction ? [] : ["        action: confirm"]),
      ...(options.targetCustomField ? ["        customSetting: true"] : []),
      "        customSettings:",
      "          pluginValue: true",
      ...(options.nestedStructure
        ? [
            "        structureSettings:",
            "          nested:",
            "            enabled: false",
          ]
        : []),
      ...(options.omitTargetName
        ? []
        : [`        name: ${JSON.stringify(targetName)}`]),
      `        lore: ${JSON.stringify(targetLore)}`,
      "",
    ].join("\n"),
  );
  if (options.chat !== undefined) {
    await writeFile(
      join(directory, "Locale/zh-CN_messages.yml"),
      `messages:\n  greeting: ${JSON.stringify(options.chat.target)}\n`,
    );
  }
  const configPath = join(directory, ".lioni/lioni.config.ts");
  await writeFile(
    configPath,
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

  const jarPath = join(directory, "Lands.jar");
  await writeFile(
    jarPath,
    landsJar(
      theme,
      sourceName,
      sourceLore,
      sourceVersion,
      options.chat,
      options.structureMaterial,
      options.nestedStructure,
    ),
  );
  const prepared = spawnSync(
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
  assert.equal(prepared.status, 0, prepared.stderr);
  await rm(jarPath);
  return { directory, configPath };
}

function runLioni(
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): CommandResult {
  const result = spawnSync(
    process.execPath,
    [nativeCli, ...args, "--output-format", "structured"],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function qualityReport(result: CommandResult): {
  readonly envelope: NativeEnvelope;
  readonly report: QualityReport;
} {
  const output = result.stdout.trim() || result.stderr.trim();
  const envelope = JSON.parse(output) as NativeEnvelope;
  assert.equal(envelope.command, "qa", output);
  const report = envelope.data ?? envelope.report;
  assert.ok(report, output);
  return { envelope, report };
}

function checkResult(
  report: QualityReport,
  checkId: string,
): QualityCheckResult {
  assert.ok(Array.isArray(report.checks), JSON.stringify(report, null, 2));
  const result = report.checks.find((check) => check.checkId === checkId);
  assert.ok(result, `QA 缺少 ${checkId} 检查项`);
  return result;
}

void test("原生漏译 QA 按正文、列表项和 hover 位置报告同文与空译文", async (t) => {
  const project = await createQualityProject(
    t,
    undefined,
    "<red>Confirm</red>",
    "<red>Confirm</red>",
    {
      sourceLore: ["First line", "Second line"],
      targetLore: ["第一行", "Second line"],
      targetCustomField: true,
    },
  );
  const run = runLioni(["qa", project.configPath]);
  const report = qualityReport(run).report;
  assert.equal(
    run.status,
    0,
    JSON.stringify(
      report.checks.map(({ checkId, status, diagnostics, issues }) => ({
        checkId,
        status,
        diagnostics: diagnostics.map(({ severity, object }) => ({
          severity,
          code: object.code,
        })),
        issues: issues.map(({ code, message, object, location }) => ({
          code,
          message,
          key: object?.key,
          location: location?.range,
        })),
      })),
      null,
      2,
    ),
  );
  const omissions = checkResult(report, "translation-omissions");
  const structures = checkResult(report, "lands-structure-consistency");
  assert.equal(structures.status, "complete");
  assert.equal(structures.diagnostics.length, 0);
  const sameText = omissions.diagnostics.filter(
    ({ object }) => object.code === "translation.same-text",
  );
  const emptyText = omissions.diagnostics.filter(
    ({ object }) => object.code === "translation.empty-text",
  );

  assert.equal(sameText.length, 2, JSON.stringify(omissions, null, 2));
  assert.equal(emptyText.length, 0, JSON.stringify(omissions, null, 2));
  assert.ok(
    [...sameText, ...emptyText].every(
      ({ severity, handling }) =>
        severity === "warning" && handling.status === "active",
    ),
    JSON.stringify(omissions.diagnostics, null, 2),
  );
  assert.ok(
    sameText.some(
      ({ location }) =>
        location.range.file === "Locale/zh-CN_gui.yml" &&
        JSON.stringify(location.range.path) ===
          JSON.stringify(["gui", "main", "items", "confirm", "lore", 1]) &&
        location.range.start !== undefined &&
        location.range.end !== undefined,
    ),
    JSON.stringify(sameText, null, 2),
  );

  const targetPath = join(project.directory, "Locale/zh-CN_gui.yml");
  await writeFile(
    targetPath,
    [
      "gui:",
      "  main:",
      "    items:",
      "      confirm:",
      '        material: "EMERALD"',
      "        slot: 1",
      "        action: confirm",
      "        customSetting: true",
      "        customSettings:",
      "          pluginValue: true",
      '        name: "<red>Confirm</red>"',
      '        lore: ["<t:missing>第一行", "Second line"]',
      "",
    ].join("\n"),
  );
  const malformedRun = runLioni(["qa", project.configPath]);
  const malformed = qualityReport(malformedRun);
  const malformedOmissions = checkResult(
    malformed.report,
    "translation-omissions",
  );
  const loreSameText = malformedOmissions.diagnostics.find(
    ({ object, location }) =>
      object.code === "translation.same-text" &&
      location.range.path.at(-2) === "lore",
  );
  assert.ok(loreSameText, JSON.stringify(malformedOmissions, null, 2));
  const omissionExecution = malformedOmissions.executions.find(
    ({ sourceKey }) => sourceKey === loreSameText.object.key,
  );
  assert.ok(omissionExecution, JSON.stringify(malformedOmissions, null, 2));
  const reportPath = join(project.directory, "qa-report.json");
  await writeFile(reportPath, JSON.stringify(malformed.envelope));
  const upserted = runLioni([
    "exceptions",
    "upsert",
    project.configPath,
    reportPath,
    "--check-id",
    "translation-omissions",
    "--execution-id",
    String(omissionExecution.executionId),
    "--id",
    "accepted-lore-same-text",
    "--reason",
    "此处由 Lands 的文本预处理保留",
  ]);
  assert.equal(upserted.status, 0, upserted.stderr || upserted.stdout);

  const acceptedRun = runLioni(["qa", project.configPath]);
  const accepted = qualityReport(acceptedRun).report;
  const acceptedSameText = checkResult(
    accepted,
    "translation-omissions",
  ).diagnostics.find(
    ({ object }) =>
      object.key === loreSameText.object.key &&
      object.code === "translation.same-text",
  );
  const activeFormat = checkResult(
    accepted,
    "minimessage-theme",
  ).diagnostics.find(
    ({ object }) => object.code === "minimessage.theme-unknown",
  );
  assert.equal(acceptedRun.status === 0, false);
  assert.equal(acceptedSameText?.handling.status, "excepted");
  assert.equal(activeFormat?.handling.status, "active");

  const changedTarget = (await readFile(targetPath, "utf8")).replace(
    "Second line",
    "译文第二行",
  );
  await writeFile(targetPath, changedTarget);
  const changed = qualityReport(runLioni(["qa", project.configPath]));
  assert.equal(
    changed.report.exceptionApplicability.find(
      ({ checkId }) => checkId === "translation-omissions",
    )?.status,
    "basis-changed",
  );
  await writeFile(
    targetPath,
    changedTarget.replace("译文第二行", "Second line"),
  );
  const restored = qualityReport(runLioni(["qa", project.configPath]));
  assert.equal(
    restored.report.exceptionApplicability.find(
      ({ checkId }) => checkId === "translation-omissions",
    )?.status,
    "applicable",
  );

  const nonText = await createQualityProject(
    t,
    undefined,
    "<red><v:player></red>",
    "<red><v:player></red>",
    {
      sourceLore: ["  ", "<red><v:player></red>", "<red><bold></bold></red>"],
      targetLore: ["  ", "<red><v:player></red>", "<red><bold></bold></red>"],
    },
  );
  const nonTextRun = runLioni(["qa", nonText.configPath]);
  assert.equal(nonTextRun.status, 0, nonTextRun.stdout || nonTextRun.stderr);
  assert.deepEqual(
    checkResult(qualityReport(nonTextRun).report, "translation-omissions")
      .diagnostics,
    [],
  );
});

void test("hover 同文与空译文沿用原生警告且不使 QA 单独失败", async (t) => {
  const project = await createQualityProject(
    t,
    undefined,
    "<red>Confirm<hover:show_text:'More information'>Info</hover></red>",
    "<red>确认<hover:show_text:'More information'>说明</hover></red>",
    { chat: { source: "Welcome to Lands", target: "" } },
  );
  const run = runLioni(["qa", project.configPath]);
  const report = qualityReport(run).report;
  assert.equal(
    run.status,
    0,
    JSON.stringify(
      report.checks.map(({ checkId, status, diagnostics, issues }) => ({
        checkId,
        status,
        diagnostics: diagnostics.map(({ severity, object }) => ({
          severity,
          code: object.code,
        })),
        issues: issues.map(({ code, message }) => ({ code, message })),
      })),
      null,
      2,
    ),
  );
  const omissions = checkResult(report, "translation-omissions");
  const hover = omissions.diagnostics.find(
    ({ object, location }) =>
      object.code === "translation.same-text" &&
      JSON.stringify(location.range.path) ===
        JSON.stringify(["gui", "main", "items", "confirm", "name"]),
  );
  const empty = omissions.diagnostics.find(
    ({ object }) => object.code === "translation.empty-text",
  );
  assert.ok(hover, JSON.stringify(omissions.diagnostics, null, 2));
  assert.ok(empty, JSON.stringify(omissions.diagnostics, null, 2));
  assert.ok(hover.location.range.start !== undefined);
  assert.deepEqual(empty.location.range.path, ["messages", "greeting"]);
  assert.equal(hover.severity, "warning");
  assert.equal(empty.severity, "warning");
});

void test("结构一致性 QA 只读检查受管值并允许自定义字段", async (t) => {
  const project = await createQualityProject(
    t,
    undefined,
    undefined,
    undefined,
    { targetStructureMaterial: "DIAMOND", targetCustomField: true },
  );
  const targetPath = join(project.directory, "Locale/zh-CN_gui.yml");
  const before = await readFile(targetPath);
  const result = runLioni(["qa", project.configPath]);
  const report = qualityReport(result).report;
  const structures = checkResult(report, "lands-structure-consistency");
  const mismatch = structures.diagnostics.find(
    ({ object }) => object.code === "lands.structure-mismatch",
  );

  assert.notEqual(result.status, 0);
  assert.ok(mismatch, JSON.stringify(structures, null, 2));
  assert.equal(mismatch.severity, "error");
  assert.deepEqual(mismatch.location.range.path, [
    "gui",
    "main",
    "items",
    "confirm",
    "material",
  ]);
  assert.deepEqual(await readFile(targetPath), before);
});

void test("结构一致性按源字段单位核对嵌套结构对象", async (t) => {
  const project = await createQualityProject(
    t,
    undefined,
    undefined,
    undefined,
    { nestedStructure: true },
  );
  const result = runLioni(["qa", project.configPath]);
  const report = qualityReport(result).report;
  const sourceKey =
    'structure:Locale/definitions_gui.yml:["gui","main","items","confirm","structureSettings"]';
  const association = report.factCoverage.associations.find(
    ({ sourceKey: key }) => key === sourceKey,
  );
  assert.equal(
    association?.status,
    "matched",
    JSON.stringify(
      {
        status: report.status,
        candidates: report.candidates,
        factCoverage: report.factCoverage,
        diagnostics: report.diagnostics,
        checks: report.checks.map(({ checkId, status, issues }) => ({
          checkId,
          status,
          issues,
        })),
      },
      null,
      2,
    ),
  );
  assert.equal(association?.candidateSelected, true);
  const structures = checkResult(report, "lands-structure-consistency");
  const mismatch = structures.diagnostics.find(
    ({ object }) => object.code === "lands.structure-mismatch",
  );

  assert.equal(
    structures.status,
    "complete",
    JSON.stringify(structures, null, 2),
  );
  assert.ok(mismatch, JSON.stringify(structures, null, 2));
  assert.deepEqual(mismatch.location.range.path, [
    "gui",
    "main",
    "items",
    "confirm",
    "structureSettings",
  ]);
  assert.deepEqual(
    mismatch.evidence.map(({ role, value }) => ({ role, value })),
    [
      {
        role: "expected",
        value: { nested: { enabled: true } },
      },
      {
        role: "actual",
        value: { nested: { enabled: false } },
      },
    ],
  );
});

void test("结构和正文缺失由漏译 QA 各报告一次且 QA 不写入目标", async (t) => {
  const project = await createQualityProject(
    t,
    undefined,
    undefined,
    undefined,
    {
      omitTargetMaterial: true,
      omitTargetAction: true,
      omitTargetName: true,
    },
  );
  const targetPath = join(project.directory, "Locale/zh-CN_gui.yml");
  const before = await readFile(targetPath);
  const result = runLioni(["qa", project.configPath]);
  const report = qualityReport(result).report;
  const omissions = checkResult(report, "translation-omissions");
  const missing = omissions.diagnostics.filter(
    ({ object }) => object.code === "translation.missing",
  );
  const structures = checkResult(report, "lands-structure-consistency");

  assert.notEqual(result.status, 0);
  assert.equal(missing.length, 3, JSON.stringify(omissions, null, 2));
  for (const diagnostic of missing) {
    const sourceKey = diagnostic.object.key;
    const candidate = report.candidates.find(
      ({ sourceKey: candidateSourceKey }) => candidateSourceKey === sourceKey,
    );
    const association = report.factCoverage.associations.find(
      ({ sourceKey: associationSourceKey }) =>
        associationSourceKey === sourceKey,
    );
    const field = diagnostic.location.range.path.at(-1);
    assert.equal(association?.status, "missing");
    assert.equal(association?.candidateSelected, true);
    assert.equal(
      candidate?.content,
      field === "material"
        ? "EMERALD"
        : field === "action"
          ? "confirm"
          : "<red>Confirm</red>",
    );
  }
  assert.equal(
    structures.diagnostics.some(
      ({ object }) => object.code === "translation.missing",
    ),
    false,
  );
  assert.deepEqual(await readFile(targetPath), before);
});

void test("目标读取缺口或正文不可用会使原生漏译 QA 不完整", async (t) => {
  const project = await createQualityProject(t);
  const targetPath = join(project.directory, "Locale/zh-CN_gui.yml");
  await writeFile(targetPath, "gui: [\n");
  const unreadable = qualityReport(runLioni(["qa", project.configPath]));
  const unreadableOmissions = checkResult(
    unreadable.report,
    "translation-omissions",
  );
  assert.notEqual(unreadable.report.status, "complete");
  assert.equal(unreadableOmissions.diagnostics.length, 0);

  await writeFile(
    targetPath,
    [
      "gui:",
      "  main:",
      "    items:",
      "      confirm:",
      '        material: "EMERALD"',
      "        slot: 1",
      "        action: confirm",
      "        customSettings:",
      "          pluginValue: true",
      "        name: {unavailable: true}",
      '        lore: ["第一行", "第二行"]',
      "",
    ].join("\n"),
  );
  const unavailable = qualityReport(runLioni(["qa", project.configPath]));
  const unavailableOmissions = checkResult(
    unavailable.report,
    "translation-omissions",
  );
  assert.notEqual(unavailable.report.status, "complete");
  assert.equal(
    unavailableOmissions.diagnostics.some(
      ({ object }) => object.code === "translation.missing",
    ),
    false,
  );
  assert.ok(
    unavailableOmissions.issues.some(
      ({ code }) => code === "translation.body-unavailable",
    ),
    JSON.stringify(unavailableOmissions.issues, null, 2),
  );
});

void test("原生 QA 用官方解析器报告语法与主题并独立应用原生例外", async (t) => {
  const project = await createQualityProject(t);
  const valid = qualityReport(runLioni(["qa", project.configPath]));
  assert.equal(
    checkResult(valid.report, "minimessage-syntax").status,
    "complete",
  );
  assert.equal(
    checkResult(valid.report, "minimessage-theme").status,
    "complete",
  );
  assert.equal(
    checkResult(valid.report, "minimessage-syntax").diagnostics.length,
    0,
  );

  const targetPath = join(project.directory, "Locale/zh-CN_gui.yml");
  const invalidTarget = [
    "gui:",
    "  main:",
    "    items:",
    "      confirm:",
    '        material: "EMERALD"',
    "        slot: 1",
    "        action: confirm",
    "        customSettings:",
    "          pluginValue: true",
    '        name: "你好 §c世界"',
    '        lore: ["<red>第一行", "<t:missing>第二行</red>"]',
    "",
  ].join("\n");
  await writeFile(targetPath, invalidTarget);
  const failed = runLioni(["qa", project.configPath]);
  assert.notEqual(failed.status, 0, failed.stdout || failed.stderr);
  const failedResult = qualityReport(failed);
  const syntax = checkResult(failedResult.report, "minimessage-syntax");
  const syntaxFinding = syntax.diagnostics.find(
    ({ object }) => object.code === "minimessage.syntax-invalid",
  );
  assert.ok(syntaxFinding, JSON.stringify(syntax, null, 2));
  assert.equal(syntaxFinding.object.origin, "target");
  assert.deepEqual(syntaxFinding.location.range.path, [
    "gui",
    "main",
    "items",
    "confirm",
    "name",
  ]);
  assert.deepEqual(
    {
      start: syntaxFinding.location.range.start,
      end: syntaxFinding.location.range.end,
    },
    { start: 3, end: 5 },
  );

  const theme = checkResult(failedResult.report, "minimessage-theme");
  const themeFinding = theme.diagnostics.find(
    ({ object }) => object.code === "minimessage.theme-unknown",
  );
  assert.ok(themeFinding, JSON.stringify(theme, null, 2));
  assert.equal(themeFinding.object.origin, "target");
  assert.deepEqual(themeFinding.location.range.path, [
    "gui",
    "main",
    "items",
    "confirm",
    "lore",
    1,
  ]);
  assert.deepEqual(
    {
      start: themeFinding.location.range.start,
      end: themeFinding.location.range.end,
    },
    { start: 0, end: 11 },
  );

  const reportPath = join(project.directory, "qa-report.json");
  await writeFile(reportPath, JSON.stringify(failedResult.envelope));
  const syntaxExecution = syntax.executions.find(
    ({ sourceKey }) => sourceKey === syntaxFinding.object.key,
  );
  assert.ok(syntaxExecution);
  const upserted = runLioni([
    "exceptions",
    "upsert",
    project.configPath,
    reportPath,
    "--check-id",
    "minimessage-syntax",
    "--execution-id",
    String(syntaxExecution.executionId),
    "--id",
    "syntax-invalid-name",
    "--reason",
    "此处由 Lands 的文本预处理保留",
  ]);
  assert.equal(upserted.status, 0, upserted.stderr || upserted.stdout);

  const accepted = qualityReport(runLioni(["qa", project.configPath]));
  const acceptedSyntax = checkResult(accepted.report, "minimessage-syntax");
  assert.equal(
    acceptedSyntax.diagnostics.find(
      ({ object }) => object.code === "minimessage.syntax-invalid",
    )?.handling.status,
    "excepted",
    JSON.stringify(acceptedSyntax.diagnostics, null, 2),
  );
  assert.equal(
    checkResult(accepted.report, "minimessage-theme").diagnostics.find(
      ({ object }) => object.code === "minimessage.theme-unknown",
    )?.handling.status,
    "active",
  );

  await writeFile(targetPath, invalidTarget.replace("§c", "§a"));
  const changed = qualityReport(runLioni(["qa", project.configPath]));
  assert.equal(
    changed.report.exceptionApplicability.find(
      ({ checkId }) => checkId === "minimessage-syntax",
    )?.status,
    "basis-changed",
  );

  await writeFile(targetPath, invalidTarget);
  const restored = qualityReport(runLioni(["qa", project.configPath]));
  assert.equal(
    restored.report.exceptionApplicability.find(
      ({ checkId }) => checkId === "minimessage-syntax",
    )?.status,
    "applicable",
  );

  await rm(targetPath);
  const unverified = qualityReport(runLioni(["qa", project.configPath]));
  const missing = checkResult(
    unverified.report,
    "translation-omissions",
  ).diagnostics.find(({ object }) => object.code === "translation.missing");
  assert.ok(missing);
  assert.equal(missing.severity, "error");
  assert.equal(missing.handling.status, "active");
  assert.ok(
    unverified.report.exceptionApplicability.some(
      ({ checkId, status }) =>
        checkId === "minimessage-syntax" && status === "basis-changed",
    ),
    JSON.stringify(unverified.report.exceptionApplicability, null, 2),
  );
});

void test("主题 YAML 不可读与 Java 不可用都保留为原生不完整结果", async (t) => {
  const project = await createQualityProject(t, "theme: [\n");
  const malformedTheme = qualityReport(runLioni(["qa", project.configPath]));
  const theme = checkResult(malformedTheme.report, "minimessage-theme");
  assert.equal(theme.status, "complete");
  const yamlFindings = theme.diagnostics.filter(
    ({ object }) => object.code === "yaml-invalid",
  );
  assert.equal(yamlFindings.length, 1, JSON.stringify(theme, null, 2));
  assert.equal(yamlFindings[0]?.location.range.file, "Locale/theme.yml");

  const reportPath = join(project.directory, "qa-report.json");
  await writeFile(reportPath, JSON.stringify(malformedTheme.envelope));
  const themeExecution = theme.executions.find(
    ({ executionId }) => executionId === yamlFindings[0]?.executionId,
  );
  assert.ok(themeExecution);
  const acceptedTheme = runLioni([
    "exceptions",
    "upsert",
    project.configPath,
    reportPath,
    "--check-id",
    "minimessage-theme",
    "--execution-id",
    String(themeExecution.executionId),
    "--id",
    "malformed-theme",
    "--reason",
    "测试主题格式的原生例外接受路径",
  ]);
  assert.equal(
    acceptedTheme.status,
    0,
    acceptedTheme.stderr || acceptedTheme.stdout,
  );
  const acceptedReport = qualityReport(runLioni(["qa", project.configPath]));
  assert.equal(
    checkResult(acceptedReport.report, "minimessage-theme").diagnostics.find(
      ({ object }) => object.code === "yaml-invalid",
    )?.handling.status,
    "excepted",
  );

  const targetPath = join(project.directory, "Locale/zh-CN_gui.yml");
  const target = await readFile(targetPath, "utf8");
  await writeFile(
    targetPath,
    target
      .split("\n")
      .filter((line) => !line.includes("lore:"))
      .join("\n"),
  );
  const missingEarlierCandidate = qualityReport(
    runLioni(["qa", project.configPath]),
  );
  const remainingTheme = checkResult(
    missingEarlierCandidate.report,
    "minimessage-theme",
  );
  assert.equal(remainingTheme.status, "complete");
  assert.equal(
    remainingTheme.diagnostics.find(
      ({ object }) => object.code === "yaml-invalid",
    )?.handling.status,
    "active",
    JSON.stringify(remainingTheme.diagnostics, null, 2),
  );

  const noJava = qualityReport(
    runLioni(["qa", project.configPath], { JAVA_COMMAND: "/missing/java" }),
  );
  assert.equal(
    checkResult(noJava.report, "minimessage-syntax").status,
    "incomplete",
  );
  assert.ok(checkResult(noJava.report, "minimessage-syntax").issues.length > 0);
});

void test("官方 Java 语法结果保留来源和主题的实际位置", async (t) => {
  const sourceProject = await createQualityProject(
    t,
    undefined,
    "<red>Source §c error</red>",
  );
  const sourceReport = qualityReport(
    runLioni(["qa", sourceProject.configPath]),
  );
  const sourceFinding = checkResult(
    sourceReport.report,
    "minimessage-syntax",
  ).diagnostics.find(
    ({ object }) =>
      object.code === "minimessage.syntax-invalid" &&
      object.origin === "source",
  );
  assert.ok(sourceFinding, JSON.stringify(sourceReport.report, null, 2));
  assert.equal(sourceFinding.location.range.file, "Locale/en-US_gui.yml");
  assert.deepEqual(sourceFinding.location.range.path, [
    "gui",
    "main",
    "items",
    "confirm",
    "name",
  ]);
  assert.ok(
    sourceFinding.location.range.start !== undefined &&
      sourceFinding.location.range.end !== undefined,
  );

  const themeProject = await createQualityProject(
    t,
    'theme:\n  tokens:\n    invalid: "<unknown>"\n',
  );
  const themeReport = qualityReport(runLioni(["qa", themeProject.configPath]));
  const themeFinding = checkResult(
    themeReport.report,
    "minimessage-theme",
  ).diagnostics.find(
    ({ object }) => object.code === "minimessage.theme-definition-invalid",
  );
  assert.ok(themeFinding, JSON.stringify(themeReport.report, null, 2));
  assert.equal(themeFinding.location.range.file, "Locale/theme.yml");
  assert.deepEqual(themeFinding.location.range.path, [
    "theme",
    "tokens",
    "invalid",
  ]);
});

void test("未识别的扩展标签有原生诊断并保留不完整限制", async (t) => {
  const project = await createQualityProject(
    t,
    undefined,
    "<verbose>有日志权限</verbose> <future:extension>未知标签</future>",
  );
  const report = qualityReport(runLioni(["qa", project.configPath]));
  const syntax = checkResult(report.report, "minimessage-syntax");
  const unknownTag = syntax.diagnostics.find(
    ({ object }) =>
      object.code === "minimessage.tag-unknown" && object.origin === "source",
  );
  assert.ok(unknownTag, JSON.stringify(syntax, null, 2));
  assert.equal(unknownTag.object.origin, "source");
  assert.equal(unknownTag.location.range.file, "Locale/en-US_gui.yml");
  assert.ok(
    syntax.issues.some(
      (issue) => issue.code === "minimessage.extension-unrecognized",
    ),
    JSON.stringify(syntax.issues, null, 2),
  );
  assert.equal(syntax.status, "incomplete");
});

void test("变量、click 行为和交互分布是独立的原生检查", async (t) => {
  const reordered = await createQualityProject(
    t,
    undefined,
    '<click:run_command:"/lands claim <v:player>">Claim</click> <click:run_command:"/lands info <v:land>">Land</click>',
    '<click:run_command:"/lands info <v:land>">土地</click> <click:run_command:"/lands claim <v:player>">认领</click>',
  );
  const reorderedReport = qualityReport(runLioni(["qa", reordered.configPath]));
  for (const checkId of [
    "minimessage-variable-correspondence",
    "minimessage-click-behavior",
    "minimessage-interaction-distribution",
  ]) {
    const check = checkResult(reorderedReport.report, checkId);
    assert.equal(check.status, "complete", JSON.stringify(check, null, 2));
    assert.deepEqual(check.diagnostics, []);
  }

  const changed = await createQualityProject(
    t,
    undefined,
    '<click:run_command:"/lands claim <v:player>">Claim</click>',
    '<click:suggest_command:"/lands claim <v:land>">认领</click>',
  );
  const changedRun = runLioni(["qa", changed.configPath]);
  assert.notEqual(changedRun.status, 0, changedRun.stdout || changedRun.stderr);
  const changedReport = qualityReport(changedRun);
  const variables = checkResult(
    changedReport.report,
    "minimessage-variable-correspondence",
  );
  const clickBehavior = checkResult(
    changedReport.report,
    "minimessage-click-behavior",
  );
  const variableCodes = new Set(
    variables.diagnostics.map(({ object }) => object.code),
  );
  assert.ok(
    variableCodes.has("minimessage.variable-missing") &&
      variableCodes.has("minimessage.variable-added"),
    JSON.stringify(variables, null, 2),
  );
  assert.ok(
    clickBehavior.diagnostics.some(
      ({ object }) => object.code === "minimessage.click-action-mismatch",
    ),
    JSON.stringify(clickBehavior, null, 2),
  );

  const reportPath = join(changed.directory, "qa-report.json");
  await writeFile(reportPath, JSON.stringify(changedReport.envelope));
  const clickExecution = clickBehavior.executions.find(
    ({ sourceKey }) => sourceKey === clickBehavior.diagnostics[0]?.object.key,
  );
  assert.ok(clickExecution);
  const accepted = runLioni([
    "exceptions",
    "upsert",
    changed.configPath,
    reportPath,
    "--check-id",
    "minimessage-click-behavior",
    "--execution-id",
    String(clickExecution.executionId),
    "--id",
    "accepted-click-action",
    "--reason",
    "此按钮动作由服务器按配置切换。",
  ]);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);

  const afterException = qualityReport(runLioni(["qa", changed.configPath]));
  const remainingVariables = checkResult(
    afterException.report,
    "minimessage-variable-correspondence",
  );
  assert.ok(
    remainingVariables.diagnostics.some(
      ({ handling }) => handling.status === "active",
    ),
    JSON.stringify(remainingVariables, null, 2),
  );
  assert.ok(
    checkResult(
      afterException.report,
      "minimessage-click-behavior",
    ).diagnostics.some(({ handling }) => handling.status === "excepted"),
    JSON.stringify(afterException.report, null, 2),
  );
});

void test("同一消息的多个同类交互按完整对象分布比较", async (t) => {
  const project = await createQualityProject(
    t,
    undefined,
    "<click:run_command:\"/lands info\"><v:owner> Owner <hover:show_text:'Owner <v:owner>'>Owner</hover></click> <click:run_command:\"/lands info\"><v:land> Land <hover:show_text:'Land <v:land>'>Land</hover></click>",
    "<click:run_command:\"/lands info\"><v:owner> <v:land> 所有者 <hover:show_text:'Owner <v:owner> <v:land>'>所有者</hover></click> <click:run_command:\"/lands info\">土地 <hover:show_text:'Land'>土地</hover></click>",
  );
  const run = runLioni(["qa", project.configPath]);
  assert.notEqual(run.status, 0, run.stdout || run.stderr);
  const report = qualityReport(run);
  const interaction = checkResult(
    report.report,
    "minimessage-interaction-distribution",
  );
  assert.ok(
    interaction.diagnostics.some(
      ({ object }) =>
        object.code ===
        "minimessage.variable-interaction-distribution-mismatch",
    ),
    JSON.stringify(interaction, null, 2),
  );
  assert.ok(
    interaction.diagnostics.every(
      ({ location }) =>
        location.range.file === "Locale/zh-CN_gui.yml" &&
        JSON.stringify(location.range.path) ===
          JSON.stringify(["gui", "main", "items", "confirm", "name"]),
    ),
    JSON.stringify(interaction, null, 2),
  );
});

void test("正文与 hover 可翻译并在各自范围调整变量语序", async (t) => {
  const project = await createQualityProject(
    t,
    undefined,
    "Hello <v:player>, owner of <v:land> <hover:show_text:'<v:land> belongs to <v:player>'>details</hover>",
    "<v:land> 属于 <v:player>，<hover:show_text:'<v:player> 的 <v:land>'>说明</hover>",
  );
  const report = qualityReport(runLioni(["qa", project.configPath]));
  for (const checkId of [
    "minimessage-variable-correspondence",
    "minimessage-interaction-distribution",
  ]) {
    const check = checkResult(report.report, checkId);
    assert.equal(check.status, "complete", JSON.stringify(check, null, 2));
    assert.deepEqual(check.diagnostics, []);
  }

  const typo = await createQualityProject(
    t,
    undefined,
    "Hello <v:player>!",
    "你好，<v:playr>。",
  );
  const typoReport = qualityReport(runLioni(["qa", typo.configPath]));
  const variables = checkResult(
    typoReport.report,
    "minimessage-variable-correspondence",
  );
  assert.ok(
    variables.diagnostics.some(
      ({ object }) => object.code === "minimessage.variable-name-mismatch",
    ),
    JSON.stringify(variables, null, 2),
  );
});

void test("click 命令名、参数和其他动作参数均受保护", async (t) => {
  const project = await createQualityProject(
    t,
    undefined,
    '<click:run_command:"/lands claim <v:player>">Claim</click> <click:suggest_command:"/lands info <v:land>">Info</click> <click:open_url:"https://example.test">Open</click>',
    '<click:run_command:"/lands unclaim <v:player>">认领</click> <click:suggest_command:"/warp info <v:land>">信息</click> <click:open_url:"https://other.test">打开</click>',
  );
  const run = runLioni(["qa", project.configPath]);
  assert.notEqual(run.status, 0, run.stdout || run.stderr);
  const report = qualityReport(run);
  const click = checkResult(report.report, "minimessage-click-behavior");
  const codes = new Set(click.diagnostics.map(({ object }) => object.code));
  assert.ok(
    codes.has("minimessage.click-command-arguments-mismatch"),
    JSON.stringify(click, null, 2),
  );
  assert.ok(
    codes.has("minimessage.click-command-name-mismatch"),
    JSON.stringify(click, null, 2),
  );
  assert.ok(
    codes.has("minimessage.click-value-mismatch"),
    JSON.stringify(click, null, 2),
  );
  assert.ok(
    click.diagnostics.every(
      ({ location }) =>
        location.range.file === "Locale/zh-CN_gui.yml" &&
        JSON.stringify(location.range.path) ===
          JSON.stringify(["gui", "main", "items", "confirm", "name"]) &&
        location.range.start !== undefined &&
        location.range.end !== undefined,
    ),
    JSON.stringify(click, null, 2),
  );
});

void test("交互对象归属或官方语义未确认时检查报告不完整", async (t) => {
  const project = await createQualityProject(
    t,
    undefined,
    "<click:show_dialog:example>Open dialog</click>",
    "<click:show_dialog:example>打开对话框</click>",
  );
  const report = qualityReport(runLioni(["qa", project.configPath]));
  const click = checkResult(report.report, "minimessage-click-behavior");
  assert.equal(click.status, "incomplete", JSON.stringify(click, null, 2));
  assert.ok(
    click.issues.some(
      ({ code }) => code === "minimessage.behavior-coverage-unavailable",
    ),
    JSON.stringify(click.issues, null, 2),
  );
});

void test("标签对应、嵌套与 Lands 控制各自形成原生检查结论", async (t) => {
  const aliases = await createQualityProject(
    t,
    undefined,
    "<red>Confirm</red>",
    "<c:#f55>确认</c>",
  );
  const aliasReport = qualityReport(runLioni(["qa", aliases.configPath]));
  assert.equal(
    checkResult(aliasReport.report, "minimessage-tag-correspondence").status,
    "complete",
  );
  assert.equal(
    checkResult(aliasReport.report, "minimessage-nesting").status,
    "complete",
  );
  assert.equal(
    checkResult(aliasReport.report, "minimessage-lands-controls").status,
    "complete",
  );

  const changed = await createQualityProject(
    t,
    undefined,
    "<red>Confirm</red>",
    "<blue>确认</blue>",
  );
  const changedRun = runLioni(["qa", changed.configPath]);
  assert.notEqual(changedRun.status, 0, changedRun.stdout || changedRun.stderr);
  const changedReport = qualityReport(changedRun);
  const correspondence = checkResult(
    changedReport.report,
    "minimessage-tag-correspondence",
  );
  assert.ok(
    correspondence.diagnostics.some(
      ({ object, location }) =>
        object.code === "minimessage.tag-mismatch" &&
        object.origin === "target" &&
        JSON.stringify(location.range.path) ===
          JSON.stringify(["gui", "main", "items", "confirm", "name"]),
    ),
    JSON.stringify(correspondence, null, 2),
  );

  const mismatchedClose = await createQualityProject(
    t,
    undefined,
    "<red>Confirm</red>",
    "<red>确认</blue>",
  );
  const nestingRun = runLioni(["qa", mismatchedClose.configPath]);
  assert.notEqual(nestingRun.status, 0, nestingRun.stdout || nestingRun.stderr);
  const nestingReport = qualityReport(nestingRun);
  const nesting = checkResult(nestingReport.report, "minimessage-nesting");
  assert.ok(
    nesting.diagnostics.some(
      ({ object, location }) =>
        object.code === "minimessage.tag-nesting-invalid" &&
        object.origin === "target" &&
        JSON.stringify(location.range.path) ===
          JSON.stringify(["gui", "main", "items", "confirm", "name"]),
    ),
    JSON.stringify(nesting, null, 2),
  );

  const misplacedControl = await createQualityProject(
    t,
    undefined,
    "<noprefix><red>Confirm</red>",
    "<noprefix><red>确认</red>",
  );
  const controlRun = runLioni(["qa", misplacedControl.configPath]);
  assert.notEqual(controlRun.status, 0, controlRun.stdout || controlRun.stderr);
  const controlReport = qualityReport(controlRun);
  const controls = checkResult(
    controlReport.report,
    "minimessage-lands-controls",
  );
  assert.ok(
    controls.diagnostics.some(
      ({ object, location }) =>
        object.code === "minimessage.lands-control-invalid" &&
        object.origin === "source" &&
        JSON.stringify(location.range.path) ===
          JSON.stringify(["gui", "main", "items", "confirm", "name"]),
    ),
    JSON.stringify(controls, null, 2),
  );
});

void test("样式别名与整体换序通过，孤立来源标签和译文省略分别报告", async (t) => {
  const reordered = await createQualityProject(
    t,
    undefined,
    "<red><bold>Confirm</bold></red>",
    "<b><c:#f55>确认</c></b>",
  );
  const reorderedReport = qualityReport(runLioni(["qa", reordered.configPath]));
  assert.equal(
    checkResult(reorderedReport.report, "minimessage-tag-correspondence")
      .status,
    "complete",
  );

  const orphan = await createQualityProject(
    t,
    undefined,
    "<red>Confirm</red></t>",
    "<red>确认</red>",
  );
  const orphanRun = runLioni(["qa", orphan.configPath]);
  assert.notEqual(orphanRun.status, 0, orphanRun.stdout || orphanRun.stderr);
  const orphanReport = qualityReport(orphanRun);
  const nesting = checkResult(orphanReport.report, "minimessage-nesting");
  assert.ok(
    nesting.diagnostics.some(
      ({ object, location }) =>
        object.code === "minimessage.tag-nesting-invalid" &&
        object.origin === "source" &&
        location.range.file === "Locale/en-US_gui.yml" &&
        JSON.stringify(location.range.path) ===
          JSON.stringify(["gui", "main", "items", "confirm", "name"]),
    ),
    JSON.stringify(nesting, null, 2),
  );
  const correspondence = checkResult(
    orphanReport.report,
    "minimessage-tag-correspondence",
  );
  assert.ok(
    correspondence.diagnostics.some(
      ({ object, location }) =>
        object.code === "minimessage.tag-mismatch" &&
        object.origin === "target" &&
        location.range.file === "Locale/zh-CN_gui.yml",
    ),
    JSON.stringify(correspondence, null, 2),
  );

  const sourceNestingFinding = nesting.diagnostics.find(
    ({ object }) =>
      object.code === "minimessage.tag-nesting-invalid" &&
      object.origin === "source",
  );
  assert.ok(sourceNestingFinding);
  const reportPath = join(orphan.directory, "qa-report.json");
  await writeFile(reportPath, JSON.stringify(orphanReport.envelope));
  const acceptedNesting = runLioni([
    "exceptions",
    "upsert",
    orphan.configPath,
    reportPath,
    "--check-id",
    "minimessage-nesting",
    "--execution-id",
    String(sourceNestingFinding.executionId),
    "--id",
    "source-orphan-close",
    "--reason",
    "该上游来源保留历史孤立关闭标签",
  ]);
  assert.equal(
    acceptedNesting.status,
    0,
    acceptedNesting.stderr || acceptedNesting.stdout,
  );
  const acceptedReport = qualityReport(runLioni(["qa", orphan.configPath]));
  assert.equal(
    checkResult(acceptedReport.report, "minimessage-nesting").diagnostics.find(
      ({ object }) =>
        object.code === "minimessage.tag-nesting-invalid" &&
        object.origin === "source",
    )?.handling.status,
    "excepted",
  );
  assert.equal(
    checkResult(
      acceptedReport.report,
      "minimessage-tag-correspondence",
    ).diagnostics.find(
      ({ object }) => object.code === "minimessage.tag-mismatch",
    )?.handling.status,
    "active",
  );
});

void test("聊天前缀与条件块按 Lands 上下文接受并阻止跨条件移动", async (t) => {
  const source =
    "<verbose><red>Hello</red></verbose> <ingame><blue>Player</blue></ingame>";
  const reordered = await createQualityProject(
    t,
    undefined,
    undefined,
    undefined,
    {
      chat: {
        source,
        target:
          "<ingame><c:#55f>玩家</c></ingame> <verbose><c:#f55>你好</c></verbose>",
      },
    },
  );
  const reorderedReport = qualityReport(runLioni(["qa", reordered.configPath]));
  assert.equal(
    checkResult(reorderedReport.report, "minimessage-tag-correspondence")
      .status,
    "complete",
  );
  assert.equal(
    checkResult(reorderedReport.report, "minimessage-lands-controls").status,
    "complete",
  );

  const moved = await createQualityProject(t, undefined, undefined, undefined, {
    chat: {
      source,
      target:
        "<verbose><blue>你好</blue></verbose> <ingame><red>玩家</red></ingame>",
    },
  });
  const movedRun = runLioni(["qa", moved.configPath]);
  assert.notEqual(movedRun.status, 0, movedRun.stdout || movedRun.stderr);
  const movedReport = qualityReport(movedRun);
  const correspondence = checkResult(
    movedReport.report,
    "minimessage-tag-correspondence",
  );
  assert.ok(
    correspondence.diagnostics.some(
      ({ object }) => object.code === "minimessage.tag-mismatch",
    ),
    JSON.stringify(correspondence, null, 2),
  );

  const prefixed = await createQualityProject(
    t,
    undefined,
    undefined,
    undefined,
    {
      chat: {
        source:
          "<title:5:40:2><red>Title</red><subtitle><blue>Sub</blue><actionbar><bold>Act</bold>",
        target:
          "<title><c:#f55>标题</c><subtitle><c:#55f>副标题</c><actionbar><b>操作栏</b>",
      },
    },
  );
  const prefixReport = qualityReport(runLioni(["qa", prefixed.configPath]));
  assert.equal(
    checkResult(prefixReport.report, "minimessage-lands-controls").status,
    "complete",
  );

  const misplaced = await createQualityProject(
    t,
    undefined,
    undefined,
    undefined,
    {
      chat: {
        source: "<noprefix><red>Welcome</red>",
        target: "<red><noprefix>欢迎</red>",
      },
    },
  );
  const misplacedRun = runLioni(["qa", misplaced.configPath]);
  assert.notEqual(
    misplacedRun.status,
    0,
    misplacedRun.stdout || misplacedRun.stderr,
  );
  const misplacedReport = qualityReport(misplacedRun);
  const controls = checkResult(
    misplacedReport.report,
    "minimessage-lands-controls",
  );
  assert.ok(
    controls.diagnostics.some(
      ({ object }) => object.code === "minimessage.lands-control-invalid",
    ),
    JSON.stringify(controls, null, 2),
  );
});

void test("GUI lore 保留 action、label、desc、indent、空行与重复行上下文", async (t) => {
  const sourceLore = [
    "<action:claim><label><red>Claim</red></label><desc><gray>Details</gray></desc></action>",
    "<indent>Next",
    "",
    "Same",
    "Same",
  ];
  const targetLore = [
    "<action:claim><label><c:#f55>占领</c></label><desc><gray>详情</gray></desc></action>",
    "<indent>下一项",
    "",
    "相同",
    "相同",
  ];
  const preserved = await createQualityProject(
    t,
    undefined,
    undefined,
    undefined,
    { sourceLore, targetLore },
  );
  const preservedReport = qualityReport(runLioni(["qa", preserved.configPath]));
  assert.equal(
    checkResult(preservedReport.report, "minimessage-tag-correspondence")
      .status,
    "complete",
  );
  assert.equal(
    checkResult(preservedReport.report, "minimessage-lands-controls").status,
    "complete",
  );

  const moved = await createQualityProject(t, undefined, undefined, undefined, {
    sourceLore: [
      "<action:claim><label><red>Claim</red></label></action>",
      "<action:bank><label><bold>Bank</bold></label></action>",
    ],
    targetLore: [
      "<action:claim><label><b>银行</b></label></action>",
      "<action:bank><label><c:#f55>占领</c></label></action>",
    ],
  });
  const movedRun = runLioni(["qa", moved.configPath]);
  assert.notEqual(movedRun.status, 0, movedRun.stdout || movedRun.stderr);
  const movedReport = qualityReport(movedRun);
  const correspondence = checkResult(
    movedReport.report,
    "minimessage-tag-correspondence",
  );
  assert.ok(
    correspondence.diagnostics.some(
      ({ object }) => object.code === "minimessage.tag-mismatch",
    ),
    JSON.stringify(correspondence, null, 2),
  );
  assert.equal(
    checkResult(movedReport.report, "minimessage-lands-controls").status,
    "complete",
  );

  const oldVersionDesc = await createQualityProject(
    t,
    undefined,
    undefined,
    undefined,
    {
      sourceVersion: "8.0.1",
      sourceLore: ["<action:claim><desc>Details</desc></action>"],
      targetLore: ["<action:claim><desc>详情</desc></action>"],
    },
  );
  const oldVersionReport = qualityReport(
    runLioni(["qa", oldVersionDesc.configPath]),
  );
  const oldVersionControls = checkResult(
    oldVersionReport.report,
    "minimessage-lands-controls",
  );
  assert.ok(
    oldVersionControls.issues.some(
      ({ code }) => code === "minimessage.lands-desc-version-unverified",
    ),
    JSON.stringify(oldVersionControls, null, 2),
  );

  const unknownVersionAction = await createQualityProject(
    t,
    undefined,
    undefined,
    undefined,
    {
      sourceVersion: "9.0.0",
      sourceLore: ["<action:claim><label>Claim</label></action>"],
      targetLore: ["<action:claim><label>占领</label></action>"],
    },
  );
  const unknownVersionReport = qualityReport(
    runLioni(["qa", unknownVersionAction.configPath]),
  );
  const unknownVersionControls = checkResult(
    unknownVersionReport.report,
    "minimessage-lands-controls",
  );
  assert.ok(
    unknownVersionControls.issues.some(
      ({ code }) => code === "minimessage.lands-controls-version-unverified",
    ),
    JSON.stringify(unknownVersionControls, null, 2),
  );
});

void test("官方 MiniMessage 别名与颜色写法通过原生语法检查", async (t) => {
  const project = await createQualityProject(
    t,
    undefined,
    "<c:red><grey><#00ff88><!bold>正文",
  );
  const report = qualityReport(runLioni(["qa", project.configPath]));
  const syntax = checkResult(report.report, "minimessage-syntax");
  assert.equal(syntax.status, "complete");
  assert.deepEqual(syntax.diagnostics, []);
});

void test("标记为结构的字符串不进入 MiniMessage 正文检查", async (t) => {
  const project = await createQualityProject(
    t,
    undefined,
    undefined,
    undefined,
    { structureMaterial: "<red>Structure §c error</red>" },
  );
  const facts = await readFacts(
    createLandsConfig(pathToFileURL(project.configPath)),
  );
  const structure = facts.source.units.find(
    ({ unit }) =>
      unit.context.role === "structure" &&
      unit.context.path.at(-1) === "material",
  );
  assert.ok(structure);
  assert.equal(structure.unit.source, "<red>Structure §c error</red>");

  const factInputs = miniMessageFactsInput(facts, []);
  assert.equal(
    factInputs.messages.some(({ path }) => path.at(-1) === "material"),
    false,
  );

  const report = qualityReport(runLioni(["qa", project.configPath]));
  const syntax = checkResult(report.report, "minimessage-syntax");
  assert.equal(syntax.status, "complete", JSON.stringify(syntax, null, 2));
  assert.deepEqual(syntax.diagnostics, []);
});
