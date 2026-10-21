import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  readReport,
  runCli,
  runCliWithoutJava,
  snapshotProjectFiles,
} from "../cli-fixtures.ts";

const fixtureDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/offline-check",
);

void describe("无 JAR 保存项目检查旅程", () => {
  void it("区分 Node 状态、官方解析、范围外资源与未完成覆盖", async (t) => {
    const temporaryDirectory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "lands-l10n-offline-check-"),
    );
    t.after(async () =>
      rm(temporaryDirectory, { force: true, recursive: true }),
    );
    const projectDirectory = join(temporaryDirectory, "project");
    await cp(fixtureDirectory, projectDirectory, { recursive: true });

    const initialFiles = await snapshotProjectFiles(projectDirectory);
    const statusWithoutJava = runCliWithoutJava(
      "status",
      "--project",
      projectDirectory,
      "--output-format",
      "structured",
    );
    assert.equal(statusWithoutJava.status, 0, statusWithoutJava.stderr);
    const statusReport = readReport(statusWithoutJava.stdout);
    assert.equal(statusReport.operation, "status");
    assert.equal(statusReport.coverage, undefined);
    assert.deepEqual(statusReport.summary, {
      resourceFiles: 6,
      messages: 8,
      pendingTranslations: 1,
      sameTextCandidates: 1,
      confirmedSameText: 0,
      modifiedTranslations: 0,
      missingTranslations: 0,
    });
    assert.deepEqual(statusReport.knownOutOfScopeVisibleTexts, [
      {
        file: "config.yml",
        path: ["camp", "default-name"],
        value: "{player}'s Camp",
      },
      {
        file: "web.yml",
        path: ["map", "general", "layer"],
        value: "Lands",
      },
    ]);
    assert.deepEqual(
      await snapshotProjectFiles(projectDirectory),
      initialFiles,
    );

    const checkWithoutJava = runCliWithoutJava(
      "check",
      "--project",
      projectDirectory,
      "--output-format",
      "structured",
    );
    assert.equal(checkWithoutJava.status, 1, checkWithoutJava.stderr);
    const missingJavaReport = readReport(
      checkWithoutJava.stderr || checkWithoutJava.stdout,
    );
    const missingJavaCoverage = missingJavaReport.coverage as {
      readonly complete: boolean;
      readonly unavailableCapabilities: readonly string[];
    };
    assert.equal(missingJavaCoverage.complete, false);
    assert.ok(
      missingJavaCoverage.unavailableCapabilities.some((capability) =>
        capability.includes("Java"),
      ),
    );
    assert.ok(
      (
        missingJavaReport.diagnostics as readonly Record<string, unknown>[]
      ).some(
        (diagnostic) =>
          diagnostic.code === "minimessage.variable-coverage-unavailable",
      ),
    );
    assert.deepEqual(
      await snapshotProjectFiles(projectDirectory),
      initialFiles,
    );

    const checked = runCli(
      "check",
      "--project",
      projectDirectory,
      "--output-format",
      "structured",
    );
    assert.equal(checked.status, 1, checked.stderr);
    const report = readReport(checked.stderr || checked.stdout);
    assert.equal(report.state, "incomplete");
    assert.deepEqual(report.diagnostics, []);
    const coverage = report.coverage as {
      readonly complete: boolean;
      readonly enabledRuleIds: readonly string[];
      readonly unavailableCapabilities: readonly string[];
    };
    assert.equal(coverage.complete, false);
    assert.ok(coverage.enabledRuleIds.includes("minimessage-syntax"));
    assert.ok(
      !coverage.unavailableCapabilities.some((capability) =>
        capability.includes("Bedrock"),
      ),
    );
    assert.deepEqual(
      await snapshotProjectFiles(projectDirectory),
      initialFiles,
    );

    const targetPath = join(projectDirectory, "Locale/zh-CN.yml");
    const initialTarget = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      initialTarget
        .replace("<green>欢迎，%player%</green>", "<blue>欢迎，%player%</blue>")
        .replace("draft: Review this policy", "draft: 请审阅此政策"),
    );
    const editedFiles = await snapshotProjectFiles(projectDirectory);

    const editedStatus = runCliWithoutJava(
      "status",
      "--project",
      projectDirectory,
      "--output-format",
      "structured",
    );
    assert.equal(editedStatus.status, 0, editedStatus.stderr);
    const editedStatusReport = readReport(editedStatus.stdout);
    assert.equal(editedStatusReport.state, "ready");
    assert.deepEqual(editedStatusReport.summary, {
      resourceFiles: 6,
      messages: 8,
      pendingTranslations: 0,
      sameTextCandidates: 1,
      confirmedSameText: 0,
      modifiedTranslations: 1,
      missingTranslations: 0,
    });
    assert.deepEqual(await snapshotProjectFiles(projectDirectory), editedFiles);

    const editedCheck = runCli(
      "check",
      "--project",
      projectDirectory,
      "--output-format",
      "structured",
    );
    assert.equal(editedCheck.status, 1, editedCheck.stderr);
    const editedReport = readReport(editedCheck.stderr || editedCheck.stdout);
    const tagDiagnostics = (
      editedReport.diagnostics as readonly Record<string, unknown>[]
    ).filter(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-tags" &&
        diagnostic.code === "minimessage.tag-mismatch",
    );
    assert.equal(tagDiagnostics.length, 2);

    const editedTextCheck = runCli("check", "--project", projectDirectory);
    assert.equal(editedTextCheck.status, editedCheck.status);
    const textOutput = editedTextCheck.stderr || editedTextCheck.stdout;
    assert.match(textOutput, /已修改 1 条/u);
    assert.match(textOutput, /检查覆盖不完整/u);
    for (const diagnostic of tagDiagnostics) {
      assert.ok(textOutput.includes(String(diagnostic.code)));
    }
    assert.deepEqual(await snapshotProjectFiles(projectDirectory), editedFiles);
  });
});
