import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { createFormatProject, createGuiProject } from "../cli-fixtures.ts";

const packageDirectory = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const nativeCli = join(packageDirectory, "node_modules/.bin/lioni");
const sourcePreparer = join(
  packageDirectory,
  "scripts/prepare-lioni-source.ts",
);

interface NativeDiagnostic {
  readonly severity: string;
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
  readonly evidence?: readonly {
    readonly role: string;
    readonly value?: unknown;
  }[];
  readonly handling: { readonly status: string };
}

interface NativeCheck {
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

interface NativeReport {
  readonly checks: readonly NativeCheck[];
  readonly diagnostics: readonly NativeDiagnostic[];
}

interface NativeEnvelope {
  readonly data?: NativeReport;
  readonly report?: NativeReport;
}

async function prepareNativeProject(
  t: TestContext,
  project: { readonly directory: string; readonly jarFile: string },
) {
  const configPath = join(project.directory, ".lioni/lioni.config.ts");
  await mkdir(join(project.directory, ".lioni"), { recursive: true });
  await writeFile(
    configPath,
    [
      'import { createLandsConfig } from "@lands-l10n/l10n/lioni.config";',
      "",
      "export default createLandsConfig(import.meta.url);",
      "",
    ].join("\n"),
  );
  const termbaseDirectory = join(project.directory, ".lioni/terms");
  await mkdir(termbaseDirectory, { recursive: true });
  await writeFile(
    join(termbaseDirectory, "concepts.yaml"),
    [
      "concepts:",
      "  test-term:",
      "    note: 原生配置加载所需的最小测试术语。",
      "    sourceRefs:",
      "      - path: README.md",
      "        commit: b8f6985a4ad2af1b76b05f0f79b718a2234623ad",
      "        section: 测试夹具",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(termbaseDirectory, "en-US.yaml"),
    [
      "concepts:",
      "  test-term:",
      "    expressions:",
      "      - id: en-US-test-term",
      "        text: test term",
      "        usage: allowed",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(termbaseDirectory, "zh-CN.yaml"),
    [
      "concepts:",
      "  test-term:",
      "    expressions:",
      "      - id: zh-CN-test-term",
      "        text: 测试术语",
      "        usage: allowed",
      "",
    ].join("\n"),
  );
  const scopedPackageDirectory = join(
    project.directory,
    "node_modules/@lands-l10n",
  );
  await mkdir(scopedPackageDirectory, { recursive: true });
  await symlink(packageDirectory, join(scopedPackageDirectory, "l10n"), "dir");

  const prepared = spawnSync(
    process.execPath,
    [
      "--conditions=source",
      sourcePreparer,
      "--jar",
      project.jarFile,
      "--config",
      configPath,
    ],
    { cwd: project.directory, encoding: "utf8" },
  );
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  await rm(project.jarFile);
  t.after(async () => rm(project.directory, { force: true, recursive: true }));
  return { configPath, directory: project.directory };
}

function runQa(configPath: string, env?: NodeJS.ProcessEnv) {
  const result = spawnSync(
    process.execPath,
    [nativeCli, "qa", configPath, "--output-format", "structured"],
    {
      cwd: packageDirectory,
      encoding: "utf8",
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    },
  );
  const output = result.stdout.trim() || result.stderr.trim();
  const envelope = JSON.parse(output) as NativeEnvelope;
  const report = envelope.data ?? envelope.report;
  assert.ok(report, output);
  return { envelope, report, result };
}

function checkResult(report: NativeReport, checkId: string): NativeCheck {
  assert.ok(Array.isArray(report.checks), JSON.stringify(report, null, 2));
  const check = report.checks.find((entry) => entry.checkId === checkId);
  assert.ok(check, `原生 QA 缺少 ${checkId} 检查项`);
  return check;
}

async function writeGuiTranslation(
  project: { readonly directory: string },
  name: string,
) {
  await mkdir(join(project.directory, "Locale"), { recursive: true });
  await writeFile(
    join(project.directory, "Locale/zh-CN_gui.yml"),
    [
      "physical:",
      "  selection:",
      "    material: GOLDEN_HOE",
      `    name: ${JSON.stringify(name)}`,
      '    lore: ["说明"]',
      "",
    ].join("\n"),
  );
}

void describe("地图与旧格式原生 QA", () => {
  void it("允许地图正文与可译属性翻译，并独立接受行为属性错误", async (t) => {
    const sourceTitle = "Owned by %own<green>er% level %level%";
    const sourceMapDescription =
      '<div class="land"><a href="/lands"><span title="Land">Land <v:land></span></a></div>';
    const targetMapDescription =
      '<div class="land"><a href="/lands"><span title="领地">领地 <v:land></span></a></div>';
    const project = await createFormatProject(t, {
      mapDescription: sourceMapDescription,
      targetMapDescription,
      legacyTitle: sourceTitle,
      targetLegacyTitle: "属于%own<green>er% 等级%level% %person%",
    });
    const nativeProject = await prepareNativeProject(t, project);
    const valid = runQa(nativeProject.configPath);
    const map = checkResult(valid.report, "map-html");
    const legacy = checkResult(valid.report, "legacy-variable");

    assert.equal(
      valid.result.status,
      0,
      JSON.stringify(
        valid.report.checks
          .filter(
            (entry) =>
              (entry.status !== "complete" &&
                entry.status !== "not-applicable") ||
              entry.diagnostics.length > 0,
          )
          .map(({ checkId, status, issues, diagnostics }) => ({
            checkId,
            status,
            issues,
            diagnostics: diagnostics.map(({ object }) => object.code),
          })),
        null,
        2,
      ),
    );
    assert.equal(map.status, "complete");
    assert.equal(map.diagnostics.length, 0);
    assert.equal(legacy.status, "complete");
    assert.equal(legacy.diagnostics.length, 0);
    assert.equal(
      map.executions.find(({ sourceKey }) => sourceKey.includes("unrelated"))
        ?.status,
      "not-applicable",
    );

    const targetPath = join(nativeProject.directory, "Locale/zh-CN.yml");
    const targetText = await readFile(targetPath, "utf8");
    const changedMapDescription = targetMapDescription.replace(
      'href="/lands"',
      'href="/changed"',
    );
    await writeFile(
      targetPath,
      targetText
        .replace('href=\\"/lands\\"', 'href=\\"/changed\\"')
        .replace(
          "属于%own<green>er% 等级%level% %person%",
          "属于<green> 等级%level% %person% %player%",
        ),
    );
    const invalid = runQa(nativeProject.configPath);
    const invalidMap = checkResult(invalid.report, "map-html");
    const invalidLegacy = checkResult(invalid.report, "legacy-variable");
    const behavior = invalidMap.diagnostics.find(
      ({ object }) => object.code === "map-html.behavior-attribute-mismatch",
    );
    const missing = invalidLegacy.diagnostics.find(
      ({ object }) => object.code === "legacy-variable.missing",
    );
    const added = invalidLegacy.diagnostics.find(
      ({ object }) => object.code === "legacy-variable.added",
    );

    assert.notEqual(invalid.result.status, 0, invalid.result.stdout);
    assert.ok(behavior, JSON.stringify(invalidMap, null, 2));
    assert.deepEqual(behavior.location.range.path, [
      "general",
      "integration",
      "dynmap",
      "land",
      "description",
    ]);
    const actualAttribute = behavior.evidence?.find(
      ({ role }) => role === "actual",
    )?.value as
      | {
          readonly position?: { readonly start: number; readonly end: number };
        }
      | undefined;
    assert.ok(actualAttribute?.position);
    assert.equal(
      changedMapDescription.slice(
        actualAttribute.position.start,
        actualAttribute.position.end,
      ),
      'href="/changed"',
    );
    assert.ok(missing, JSON.stringify(invalidLegacy, null, 2));
    const expected = missing.evidence?.find(({ role }) => role === "expected")
      ?.value as
      | {
          readonly positions?: readonly {
            readonly start: number;
            readonly end: number;
          }[];
        }
      | undefined;
    const legacyPosition = expected?.positions?.[0];
    assert.ok(legacyPosition);
    assert.equal(
      sourceTitle.slice(legacyPosition.start, legacyPosition.end),
      "%own<green>er%",
    );
    assert.ok(added, JSON.stringify(invalidLegacy, null, 2));

    const reportPath = join(nativeProject.directory, "qa-report.json");
    await writeFile(reportPath, JSON.stringify(invalid.envelope));
    const execution = invalidMap.executions.find(
      ({ sourceKey }) => sourceKey === behavior.object.key,
    );
    assert.ok(execution);
    const accepted = spawnSync(
      process.execPath,
      [
        nativeCli,
        "exceptions",
        "upsert",
        nativeProject.configPath,
        reportPath,
        "--check-id",
        "map-html",
        "--execution-id",
        String(execution.executionId),
        "--id",
        "map-behavior-change",
        "--reason",
        "此例保留了维护者确认的地图链接调整。",
        "--output-format",
        "structured",
      ],
      { cwd: packageDirectory, encoding: "utf8" },
    );
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);

    const afterAcceptance = runQa(nativeProject.configPath);
    const acceptedMap = checkResult(afterAcceptance.report, "map-html");
    const stillActiveLegacy = checkResult(
      afterAcceptance.report,
      "legacy-variable",
    );
    assert.equal(
      acceptedMap.diagnostics.find(
        ({ object }) => object.code === "map-html.behavior-attribute-mismatch",
      )?.handling.status,
      "excepted",
    );
    assert.equal(
      stillActiveLegacy.diagnostics.find(
        ({ object }) => object.code === "legacy-variable.missing",
      )?.handling.status,
      "active",
    );
  });

  void it("按 Lands 版本报告地图属性占位符、旧颜色限制与未支持版本", async (t) => {
    const mapProject = await createFormatProject(t, {
      sourceVersion: "8.0.1",
      mapDescription: '<div style="color: <v:land_color>;"><v:land></div>',
      targetMapDescription:
        '<div style="color: <v:land_color>;"><v:land></div>',
    });
    const nativeMapProject = await prepareNativeProject(t, mapProject);
    const mapReport = runQa(nativeMapProject.configPath);
    const mapLimits = checkResult(mapReport.report, "map-html-source-limits");
    assert.equal(mapReport.result.status, 0, mapReport.result.stderr);
    assert.ok(
      mapLimits.diagnostics.some(
        ({ object }) =>
          object.code === "map-html.source-attribute-variable-literal",
      ),
      JSON.stringify(mapLimits, null, 2),
    );
    assert.ok(
      mapLimits.diagnostics.every(
        ({ handling }) => handling.status === "active",
      ),
    );
    assert.ok(
      mapLimits.diagnostics.every(({ severity }) => severity === "warning"),
    );

    const newerMapProject = await createFormatProject(t, {
      sourceVersion: "8.9.2",
      mapDescription: '<div style="color: <v:land_color>;"><v:land></div>',
      targetMapDescription:
        '<div style="color: <v:land_color>;"><v:land></div>',
    });
    const newerNativeMapProject = await prepareNativeProject(
      t,
      newerMapProject,
    );
    const newerMapReport = runQa(newerNativeMapProject.configPath);
    const newerMapLimits = checkResult(
      newerMapReport.report,
      "map-html-source-limits",
    );
    const landColorLimit = newerMapLimits.diagnostics.find(
      ({ object }) =>
        object.code === "map-html.source-attribute-variable-literal",
    );
    const landColorEvidence = landColorLimit?.evidence?.find(
      ({ role }) => role === "actual",
    )?.value as { readonly resolverSuppliesVariable?: boolean } | undefined;
    assert.equal(newerMapLimits.status, "complete");
    assert.equal(landColorLimit?.severity, "warning");
    assert.equal(landColorEvidence?.resolverSuppliesVariable, true);

    for (const [sourceVersion, sourceName, targetName] of [
      ["8.0.1", "&aStone", "&a石头"],
      ["8.9.2", "§aStone", "§a石头"],
    ] as const) {
      const supportedProject = await createGuiProject(t, {
        name: sourceName,
        lore: ["说明"],
        sourceVersion,
      });
      await writeGuiTranslation(supportedProject, targetName);
      const nativeSupportedProject = await prepareNativeProject(
        t,
        supportedProject,
      );
      const supportedReport = runQa(nativeSupportedProject.configPath);
      const supportedFormat = checkResult(
        supportedReport.report,
        "legacy-format",
      );
      assert.equal(supportedReport.result.status, 0);
      assert.equal(supportedFormat.status, "complete");
      assert.equal(supportedFormat.diagnostics.length, 0);
    }

    const guiProject = await createGuiProject(t, {
      name: "§aStone",
      lore: ["说明"],
      sourceVersion: "8.0.1",
    });
    await writeGuiTranslation(guiProject, "§a石头");
    const nativeGuiProject = await prepareNativeProject(t, guiProject);
    const colorReport = runQa(nativeGuiProject.configPath);
    const legacyFormat = checkResult(colorReport.report, "legacy-format");
    const unsupportedColor = legacyFormat.diagnostics.find(
      ({ object }) =>
        object.code === "legacy-format.code-unsupported" &&
        object.origin === "target",
    );
    assert.notEqual(colorReport.result.status, 0, colorReport.result.stdout);
    assert.ok(unsupportedColor, JSON.stringify(legacyFormat, null, 2));
    assert.equal(unsupportedColor.severity, "error");
    assert.deepEqual(unsupportedColor.location.range.path, [
      "physical",
      "selection",
      "name",
    ]);

    const unknownProject = await createGuiProject(t, {
      name: "&aStone",
      lore: ["说明"],
      sourceVersion: "8.9.3",
    });
    await writeGuiTranslation(unknownProject, "&a石头");
    const nativeUnknownProject = await prepareNativeProject(t, unknownProject);
    const unknownReport = runQa(nativeUnknownProject.configPath);
    const unknownFormat = checkResult(unknownReport.report, "legacy-format");
    assert.notEqual(
      unknownReport.result.status,
      0,
      unknownReport.result.stdout,
    );
    assert.equal(unknownFormat.status, "incomplete");
    assert.ok(
      unknownFormat.diagnostics.some(
        ({ object }) =>
          object.code === "legacy-format.source-version-unsupported",
      ),
      JSON.stringify(unknownFormat, null, 2),
    );
    assert.ok(
      unknownFormat.diagnostics.every(
        ({ object, severity }) =>
          object.code !== "legacy-format.source-version-unsupported" ||
          severity === "warning",
      ),
    );
  });

  void it("原译同文仍检查地图和旧颜色格式，地图版本不明时保留不完整状态", async (t) => {
    const knownVariables = [
      "owner",
      "world",
      "x",
      "z",
      "level",
      "nation",
      "chunks",
      "chunks_max",
      "members",
      "members_max",
      "balance",
      "upkeep",
      "upkeep_next",
      "created_at",
      "taxes_next",
    ];
    const playerVariables = [
      "balance_player",
      "chunk_cost",
      "taxes",
      "player_chunks_used",
      "player_chunks",
    ];
    const variableTemplate = `<div>${[...knownVariables, ...playerVariables]
      .map((name) => `<v:${name}>`)
      .join(" ")}</div>`;
    const sameTextProject = await createFormatProject(t, {
      mapDescription: variableTemplate,
      targetMapDescription: variableTemplate,
    });
    const nativeSameTextProject = await prepareNativeProject(
      t,
      sameTextProject,
    );
    const sameTextReport = runQa(nativeSameTextProject.configPath);
    const sameTextMap = checkResult(sameTextReport.report, "map-html");
    assert.ok(
      sameTextMap.diagnostics.some(
        ({ object }) => object.code === "map-html.variable-unknown",
      ),
      JSON.stringify(sameTextMap, null, 2),
    );
    const unknownVariables = sameTextMap.diagnostics.flatMap((diagnostic) => {
      if (diagnostic.object.code !== "map-html.variable-unknown") return [];
      const actual = diagnostic.evidence?.find(({ role }) => role === "actual")
        ?.value as { readonly variable?: string } | undefined;
      return actual?.variable === undefined ? [] : [actual.variable];
    });
    assert.deepEqual(unknownVariables.sort(), playerVariables.sort());

    const unknownMapProject = await createFormatProject(t, {
      sourceVersion: "8.9.3",
      mapDescription: "<div><v:land></div>",
      targetMapDescription: "<div><v:land></div>",
    });
    const nativeUnknownMapProject = await prepareNativeProject(
      t,
      unknownMapProject,
    );
    const unknownMapReport = runQa(nativeUnknownMapProject.configPath);
    const unknownMapLimits = checkResult(
      unknownMapReport.report,
      "map-html-source-limits",
    );
    assert.equal(unknownMapLimits.status, "incomplete");
    assert.ok(
      unknownMapLimits.diagnostics.some(
        ({ object }) => object.code === "map-html.source-version-unsupported",
      ),
      JSON.stringify(unknownMapLimits, null, 2),
    );

    const sameColorProject = await createGuiProject(t, {
      name: "§aStone",
      lore: ["说明"],
      sourceVersion: "8.0.1",
    });
    await writeGuiTranslation(sameColorProject, "§aStone");
    const nativeSameColorProject = await prepareNativeProject(
      t,
      sameColorProject,
    );
    const sameColorReport = runQa(nativeSameColorProject.configPath);
    const sameColorCheck = checkResult(sameColorReport.report, "legacy-format");
    assert.ok(
      sameColorCheck.diagnostics.some(
        ({ object }) => object.code === "legacy-format.code-unsupported",
      ),
      JSON.stringify(sameColorCheck, null, 2),
    );
  });

  void it("受保护地图元素结构变化仍由地图检查报告", async (t) => {
    const project = await createFormatProject(t, {
      mapDescription: "<div><span>Land</span></div>",
      targetMapDescription: "<div><strong>领地</strong></div>",
    });
    const nativeProject = await prepareNativeProject(t, project);
    const result = runQa(nativeProject.configPath);
    const map = checkResult(result.report, "map-html");

    assert.notEqual(result.result.status, 0, result.result.stdout);
    assert.ok(
      map.diagnostics.some(
        ({ object }) => object.code === "map-html.structure-mismatch",
      ),
      JSON.stringify(map, null, 2),
    );

    const invalidProject = await createFormatProject(t, {
      mapDescription: "<div><span>Land</span></div>",
      targetMapDescription: "<div><span>领地</div>",
    });
    const invalidNativeProject = await prepareNativeProject(t, invalidProject);
    const invalid = runQa(invalidNativeProject.configPath);
    const invalidMap = checkResult(invalid.report, "map-html");
    assert.ok(
      invalidMap.diagnostics.some(
        ({ object }) => object.code === "map-html.structure-invalid",
      ),
      JSON.stringify(invalidMap, null, 2),
    );
  });

  void it("HTML fallback 正文和可译属性可修改而行为属性保持不变", async (t) => {
    const source =
      "<div><lang_or:lands.key:'<a href=/keep title=Land>Land</a>'></div>";
    const translated =
      "<div><lang_or:lands.key:'<a href=/keep title=城镇>城镇</a>'></div>";
    const project = await createFormatProject(t, {
      sourceVersion: "8.9.2",
      mapDescription: source,
      targetMapDescription: translated,
    });
    const nativeProject = await prepareNativeProject(t, project);
    const valid = runQa(nativeProject.configPath);
    const validMap = checkResult(valid.report, "map-html");
    assert.equal(validMap.status, "complete");
    assert.equal(validMap.diagnostics.length, 0);

    const targetPath = join(nativeProject.directory, "Locale/zh-CN.yml");
    const targetText = await readFile(targetPath, "utf8");
    await writeFile(targetPath, targetText.replace("href=/keep", "href=/drop"));
    const invalid = runQa(nativeProject.configPath);
    const invalidMap = checkResult(invalid.report, "map-html");
    assert.ok(
      invalidMap.diagnostics.some(
        ({ object }) => object.code === "map-html.behavior-attribute-mismatch",
      ),
      JSON.stringify(invalidMap, null, 2),
    );
  });

  void it("只在实际 Nations 资源字段启用地图 HTML 检查", async (t) => {
    const project = await createFormatProject(t, {
      nationsMapDescription:
        '<div class="nation"><a href="/keep">Nation</a></div>',
      targetNationsMapDescription:
        '<div class="nation"><a href="/changed">联邦</a></div>',
      rootNationsMapDescription:
        '<div class="root"><a href="/root">Nation</a></div>',
      targetRootNationsMapDescription:
        '<div class="root"><a href="/changed">联邦</a></div>',
    });
    const nativeProject = await prepareNativeProject(t, project);
    const result = runQa(nativeProject.configPath);
    const map = checkResult(result.report, "map-html");
    const nationFinding = map.diagnostics.find(
      ({ object, location }) =>
        object.code === "map-html.behavior-attribute-mismatch" &&
        location.range.file === "Locale/Nations/zh-CN.yml",
    );
    const rootExecution = map.executions.find(({ sourceKey }) =>
      sourceKey.includes('["integration","dynmap","nation","description"]'),
    );

    assert.ok(nationFinding, JSON.stringify(map, null, 2));
    assert.deepEqual(nationFinding.location.range.path, [
      "general",
      "integration",
      "dynmap",
      "nation",
      "description",
    ]);
    assert.equal(rootExecution?.status, "not-applicable");
  });

  void it("普通聊天不套用地图检查，官方解析缺失时地图和旧变量结果不完整", async (t) => {
    const chatProject = await createFormatProject(t, {
      unrelatedText: '<div class="note"><a href="/old">Text</a></div>',
      targetUnrelatedText:
        '<div class="note"><a href="/changed">文本</a></div>',
    });
    const nativeChatProject = await prepareNativeProject(t, chatProject);
    const chatReport = runQa(nativeChatProject.configPath);
    const mapCheck = checkResult(chatReport.report, "map-html");
    const legacyCheck = checkResult(chatReport.report, "legacy-variable");
    const chatExecution = mapCheck.executions.find(({ sourceKey }) =>
      sourceKey.includes("unrelated"),
    );
    const legacyExecution = legacyCheck.executions.find(({ sourceKey }) =>
      sourceKey.includes("unrelated"),
    );
    assert.equal(chatExecution?.status, "not-applicable");
    assert.equal(legacyExecution?.status, "not-applicable");
    assert.equal(
      mapCheck.diagnostics.some(({ location }) =>
        location.range.path.includes("unrelated"),
      ),
      false,
    );

    const dynamicMapProject = await createFormatProject(t, {
      mapDescription: "<div><score:'Alex':'points'></div>",
      targetMapDescription: "<div><score:'Alex':'points'></div>",
    });
    const nativeDynamicMapProject = await prepareNativeProject(
      t,
      dynamicMapProject,
    );
    const dynamicMapReport = runQa(nativeDynamicMapProject.configPath);
    const dynamicMap = checkResult(dynamicMapReport.report, "map-html");
    assert.equal(dynamicMap.status, "incomplete");
    assert.ok(
      dynamicMap.issues.some(
        ({ code }) => code === "minimessage.parser-warning",
      ),
      JSON.stringify(dynamicMap, null, 2),
    );

    const project = await createFormatProject(t, {
      legacyTitle: "Owned by %owner%",
      targetLegacyTitle: "属于%owner%",
    });
    const nativeProject = await prepareNativeProject(t, project);
    const unavailable = runQa(nativeProject.configPath, {
      JAVA_COMMAND: "/lands-l10n-missing-java",
    });
    const map = checkResult(unavailable.report, "map-html");
    const legacy = checkResult(unavailable.report, "legacy-variable");
    assert.equal(map.status, "incomplete");
    assert.ok(map.issues.length > 0);
    assert.equal(legacy.status, "incomplete");
    assert.ok(legacy.issues.length > 0);

    const colorProject = await createGuiProject(t, {
      name: "&aStone",
      lore: ["说明"],
      sourceVersion: "8.0.1",
    });
    await writeGuiTranslation(colorProject, "&a石头");
    const nativeColorProject = await prepareNativeProject(t, colorProject);
    const unavailableColor = runQa(nativeColorProject.configPath, {
      JAVA_COMMAND: "/lands-l10n-missing-java",
    });
    const color = checkResult(unavailableColor.report, "legacy-format");
    assert.equal(color.status, "incomplete");
    assert.ok(color.issues.length > 0);
  });

  void it("正文配对不唯一时地图与旧变量检查保留不完整状态", async (t) => {
    const sourceMapDescription =
      '<div>Land <hover:show_text:"a">A</hover><hover:show_text:"b">B</hover></div>';
    const targetMapDescription =
      '<div>领地 <hover:show_text:"译文">甲</hover></div>';
    const sourceLegacyTitle =
      'Owned by %owner% <hover:show_text:"a">A</hover><hover:show_text:"b">B</hover>';
    const targetLegacyTitle = '属于%owner% <hover:show_text:"译文">甲</hover>';
    const project = await createFormatProject(t, {
      mapDescription: sourceMapDescription,
      targetMapDescription,
      legacyTitle: sourceLegacyTitle,
      targetLegacyTitle,
    });
    const nativeProject = await prepareNativeProject(t, project);
    const result = runQa(nativeProject.configPath);
    const map = checkResult(result.report, "map-html");
    const legacy = checkResult(result.report, "legacy-variable");

    assert.equal(map.status, "incomplete");
    assert.ok(
      map.issues.some(
        ({ code }) => code === "minimessage.text-pair-not-unique",
      ),
      JSON.stringify(map, null, 2),
    );
    assert.equal(legacy.status, "incomplete");
    assert.ok(
      legacy.issues.some(
        ({ code }) => code === "minimessage.text-pair-not-unique",
      ),
      JSON.stringify(legacy, null, 2),
    );
  });

  void it("旧变量检查沿用官方 fallback 正文和原文位置", async (t) => {
    const source = "Owned by <lang_or:lands.key:'%owner%'>";
    const project = await createFormatProject(t, {
      legacyTitle: source,
      targetLegacyTitle: "属于<lang_or:lands.key:'%owner%'>",
    });
    const nativeProject = await prepareNativeProject(t, project);
    const valid = runQa(nativeProject.configPath);
    const validLegacy = checkResult(valid.report, "legacy-variable");
    assert.equal(validLegacy.status, "complete");
    assert.equal(validLegacy.diagnostics.length, 0);

    const targetPath = join(nativeProject.directory, "Locale/zh-CN.yml");
    const targetText = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      targetText.replace(
        "属于<lang_or:lands.key:'%owner%'>",
        "属于<lang_or:lands.key:'某人'>",
      ),
    );
    const invalid = runQa(nativeProject.configPath);
    const invalidLegacy = checkResult(invalid.report, "legacy-variable");
    const missing = invalidLegacy.diagnostics.find(
      ({ object }) => object.code === "legacy-variable.missing",
    );
    const expected = missing?.evidence?.find(({ role }) => role === "expected")
      ?.value as
      | {
          readonly positions?: readonly {
            readonly start: number;
            readonly end: number;
          }[];
        }
      | undefined;

    assert.ok(missing, JSON.stringify(invalidLegacy, null, 2));
    const position = expected?.positions?.[0];
    assert.ok(position);
    assert.equal(source.slice(position.start, position.end), "%owner%");
  });
});
