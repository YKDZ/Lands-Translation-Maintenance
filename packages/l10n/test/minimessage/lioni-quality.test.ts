import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { strToU8, zipSync } from "fflate";

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
  readonly handling: { readonly status: string };
}

interface QualityCheckResult {
  readonly checkId: string;
  readonly status: string;
  readonly diagnostics: readonly NativeDiagnostic[];
  readonly issues: readonly { readonly code: string }[];
  readonly executions: readonly {
    readonly executionId: number;
    readonly sourceKey: string;
    readonly status: string;
  }[];
}

interface QualityReport {
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

function landsJar(theme: string, sourceName: string): Uint8Array {
  return zipSync({
    "plugin.yml": strToU8("name: Lands\nversion: 8.9.2\n"),
    "Locale/en-US_gui.yml": strToU8(
      [
        "gui:",
        "  main:",
        "    items:",
        "      confirm:",
        `        name: ${JSON.stringify(sourceName)}`,
        '        lore: ["<red>First line", "Second line</red>"]',
        "",
      ].join("\n"),
    ),
    "Locale/definitions_gui.yml": strToU8(
      [
        "gui:",
        "  main:",
        "    items:",
        "      confirm:",
        "        material: EMERALD",
        "        slot: 1",
        '        name: "<red>Confirm</red>"',
        '        lore: ["<red>First line", "Second line</red>"]',
        "        action: confirm",
        "",
      ].join("\n"),
    ),
    "Locale/theme.yml": strToU8(theme),
  });
}

async function createQualityProject(
  t: TestContext,
  theme = 'theme:\n  tokens:\n    known: "<red>"\n',
  sourceName = "<red>Confirm</red>",
): Promise<{ readonly directory: string; readonly configPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "lioni-quality-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await Promise.all([
    mkdir(join(directory, ".l10n"), { recursive: true }),
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
    join(directory, ".l10n/config.yml"),
    [
      "schemaVersion: 1",
      "source:",
      '  version: "8.9.2"',
      '  translationHistory: "fixture-history"',
      "resources:",
      "  - path: plugin.yml",
      "    purpose: metadata",
      "  - path: Locale/en-US_gui.yml",
      "    purpose: gui-language",
      "  - path: Locale/definitions_gui.yml",
      "    purpose: configuration",
      "  - path: Locale/theme.yml",
      "    purpose: configuration",
      "translationScope:",
      '  sourceLanguage: "en-US"',
      '  targetLanguage: "zh-CN"',
      "  mappings:",
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
      '        name: "<red>确认</red>"',
      '        lore: ["<red>第一行", "第二行</red>"]',
      "",
    ].join("\n"),
  );
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
  await writeFile(jarPath, landsJar(theme, sourceName));
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
  assert.ok(
    unverified.report.exceptionApplicability.some(
      ({ checkId, status }) =>
        checkId === "minimessage-syntax" && status === "not-verified",
    ),
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
