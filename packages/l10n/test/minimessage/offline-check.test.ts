import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { readReport, snapshotProjectFiles } from "../cli-fixtures.ts";

const packageDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fixtureDirectory = resolve(
  packageDirectory,
  "test/fixtures/offline-check",
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
    const artifactDirectory = join(temporaryDirectory, "package");
    await cp(fixtureDirectory, projectDirectory, { recursive: true });

    const deployed = spawnSync(
      "pnpm",
      ["--filter", "@lands-l10n/l10n", "deploy", "--prod", artifactDirectory],
      { cwd: packageDirectory, encoding: "utf8" },
    );
    assert.equal(
      deployed.status,
      0,
      deployed.stderr || deployed.stdout || deployed.error?.message,
    );
    const cliFile = join(artifactDirectory, "dist/cli.js");
    const runArtifactCli = (...args: string[]) =>
      spawnSync(process.execPath, [cliFile, ...args], {
        cwd: temporaryDirectory,
        encoding: "utf8",
      });
    const runArtifactCliWithoutJava = (...args: string[]) =>
      spawnSync(process.execPath, [cliFile, ...args], {
        cwd: temporaryDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          JAVA_COMMAND: "java",
          PATH: "/lands-l10n-missing-java",
        },
      });

    let initialFiles = await snapshotProjectFiles(projectDirectory);
    const statusWithoutJava = runArtifactCliWithoutJava(
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
    assert.deepEqual(statusReport.knownExcludedResources, [
      {
        path: "bedrock/lang/en_us.json",
        purpose: "bedrock-excluded",
      },
    ]);
    const sameTextCandidate = (
      statusReport.sameTextToConfirm as readonly Record<string, unknown>[]
    ).find(
      (candidate) =>
        JSON.stringify((candidate.message as Record<string, unknown>).path) ===
        '["messages","same_brand"]',
    );
    assert.ok(sameTextCandidate);
    if (sameTextCandidate === undefined)
      throw new Error("缺少待确认的同文候选");
    const candidateId = String(sameTextCandidate.candidateId);
    const confirmed = runArtifactCliWithoutJava(
      "confirm-same-text",
      "--project",
      projectDirectory,
      "--candidate",
      candidateId,
      "--reason",
      "品牌名按约定保留英文",
      "--output-format",
      "structured",
    );
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.match(confirmed.stdout, new RegExp(candidateId));
    initialFiles = await snapshotProjectFiles(projectDirectory);
    assert.deepEqual(
      await snapshotProjectFiles(projectDirectory),
      initialFiles,
    );

    const checkWithoutJava = runArtifactCliWithoutJava(
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
    assert.equal(
      (missingJavaReport.summary as { readonly confirmedSameText: number })
        .confirmedSameText,
      1,
    );
    const remainingSameTextCandidates =
      missingJavaReport.sameTextToConfirm as readonly Record<string, unknown>[];
    assert.equal(remainingSameTextCandidates.length, 1);
    const remainingSeed = remainingSameTextCandidates[0];
    assert.ok(remainingSeed);
    if (remainingSeed === undefined) throw new Error("英文待翻译项未保留");
    assert.equal(remainingSeed.pendingReason, "translation-seed");
    assert.deepEqual((remainingSeed.message as Record<string, unknown>).path, [
      "messages",
      "draft",
    ]);
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

    for (const dependencyPath of [
      join(artifactDirectory, "target/minimessage/lands-l10n-minimessage.jar"),
      join(
        artifactDirectory,
        "target/minimessage/deps/adventure-text-minimessage-4.26.1.jar",
      ),
    ]) {
      const temporarilyUnavailablePath = `${dependencyPath}.unavailable`;
      await rename(dependencyPath, temporarilyUnavailablePath);
      try {
        const incompleteCheck = runArtifactCli(
          "check",
          "--project",
          projectDirectory,
          "--output-format",
          "structured",
        );
        assert.equal(incompleteCheck.status, 1, incompleteCheck.stderr);
        const incompleteReport = readReport(
          incompleteCheck.stderr || incompleteCheck.stdout,
        );
        assert.notEqual(incompleteReport.state, "ready");
        assert.equal(
          (incompleteReport.coverage as { readonly complete: boolean })
            .complete,
          false,
        );
        assert.ok(
          (
            incompleteReport.diagnostics as readonly Record<string, unknown>[]
          ).some(
            (diagnostic) =>
              diagnostic.code === "minimessage.variable-coverage-unavailable",
          ),
        );
        assert.deepEqual(
          await snapshotProjectFiles(projectDirectory),
          initialFiles,
        );
      } finally {
        await rename(temporarilyUnavailablePath, dependencyPath);
      }
    }

    const checked = runArtifactCli(
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
    assert.deepEqual(report.knownExcludedResources, [
      {
        path: "bedrock/lang/en_us.json",
        purpose: "bedrock-excluded",
      },
    ]);
    assert.equal(
      (report.summary as { readonly confirmedSameText: number })
        .confirmedSameText,
      1,
    );
    assert.equal(
      (report.sameTextToConfirm as readonly Record<string, unknown>[])[0]
        ?.pendingReason,
      "translation-seed",
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
        .replace("draft: Review this policy", "draft: 请审阅此政策")
        .replace('duplicate_b: "启用国家"', 'duplicate_b: "关闭国家"'),
    );
    const editedFiles = await snapshotProjectFiles(projectDirectory);

    const editedStatus = runArtifactCliWithoutJava(
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
      sameTextCandidates: 0,
      confirmedSameText: 1,
      modifiedTranslations: 1,
      missingTranslations: 0,
    });
    assert.deepEqual(await snapshotProjectFiles(projectDirectory), editedFiles);

    const editedCheck = runArtifactCli(
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
    const consistencyDiagnostics = (
      editedReport.diagnostics as readonly Record<string, unknown>[]
    ).filter(
      (diagnostic) =>
        diagnostic.ruleId === "translation-consistency" &&
        diagnostic.code === "translation-consistency.same-source",
    );
    assert.equal(consistencyDiagnostics.length, 1);
    assert.match(
      JSON.stringify(consistencyDiagnostics[0]?.actual),
      /duplicate_a/u,
    );
    assert.match(
      JSON.stringify(consistencyDiagnostics[0]?.actual),
      /duplicate_b/u,
    );

    const exemptedDiagnosticId = String(tagDiagnostics[0]?.diagnosticId);
    const exempted = runArtifactCli(
      "exempt",
      "--project",
      projectDirectory,
      "--diagnostic",
      exemptedDiagnosticId,
      "--reason",
      "此消息的样式差异已按界面约定审核",
      "--output-format",
      "structured",
    );
    assert.equal(exempted.status, 0, exempted.stderr);
    const exemptedFiles = await snapshotProjectFiles(projectDirectory);

    const afterExemption = runArtifactCli(
      "check",
      "--project",
      projectDirectory,
      "--output-format",
      "structured",
    );
    assert.equal(afterExemption.status, 1, afterExemption.stderr);
    const afterExemptionReport = readReport(
      afterExemption.stderr || afterExemption.stdout,
    );
    const afterExemptionDiagnostics =
      afterExemptionReport.diagnostics as readonly Record<string, unknown>[];
    const remainingTagDiagnostics = afterExemptionDiagnostics.filter(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-tags" &&
        diagnostic.code === "minimessage.tag-mismatch",
    );
    assert.equal(remainingTagDiagnostics.length, 1);
    assert.ok(
      !afterExemptionDiagnostics.some(
        (diagnostic) => diagnostic.diagnosticId === exemptedDiagnosticId,
      ),
    );
    assert.equal(
      (afterExemptionReport.summary as { readonly confirmedSameText: number })
        .confirmedSameText,
      1,
    );
    assert.deepEqual(
      await snapshotProjectFiles(projectDirectory),
      exemptedFiles,
    );

    const unavailableExemption = runArtifactCliWithoutJava(
      "check",
      "--project",
      projectDirectory,
      "--output-format",
      "structured",
    );
    assert.equal(unavailableExemption.status, 1, unavailableExemption.stderr);
    const unavailableExemptionReport = readReport(
      unavailableExemption.stderr || unavailableExemption.stdout,
    );
    const unavailableExemptionDiagnostics =
      unavailableExemptionReport.diagnostics as readonly Record<
        string,
        unknown
      >[];
    assert.ok(
      unavailableExemptionDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
    );
    assert.ok(
      !unavailableExemptionDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.orphaned",
      ),
    );
    assert.equal(
      (unavailableExemptionReport.coverage as { readonly complete: boolean })
        .complete,
      false,
    );
    assert.deepEqual(
      await snapshotProjectFiles(projectDirectory),
      exemptedFiles,
    );

    const targetWithInvalidatedRecords = (await readFile(targetPath, "utf8"))
      .replace("<blue>", "<red>")
      .replace("</blue>", "</red>")
      .replace('same_brand: "Lands"', 'same_brand: "Lands 新"');
    await writeFile(targetPath, targetWithInvalidatedRecords);
    const invalidatedFiles = await snapshotProjectFiles(projectDirectory);
    const invalidatedCheck = runArtifactCli(
      "check",
      "--project",
      projectDirectory,
      "--output-format",
      "structured",
    );
    assert.equal(invalidatedCheck.status, 1, invalidatedCheck.stderr);
    const invalidatedReport = readReport(
      invalidatedCheck.stderr || invalidatedCheck.stdout,
    );
    const invalidatedDiagnostics =
      invalidatedReport.diagnostics as readonly Record<string, unknown>[];
    assert.ok(
      invalidatedDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.review-required",
      ),
    );
    assert.ok(
      invalidatedDiagnostics.some(
        (diagnostic) => diagnostic.code === "same-text.review-required",
      ),
    );
    assert.equal(
      (invalidatedReport.summary as { readonly confirmedSameText: number })
        .confirmedSameText,
      0,
    );
    assert.equal(
      invalidatedDiagnostics.filter(
        (diagnostic) =>
          diagnostic.ruleId === "minimessage-tags" &&
          diagnostic.code === "minimessage.tag-mismatch",
      ).length,
      2,
    );
    assert.deepEqual(
      await snapshotProjectFiles(projectDirectory),
      invalidatedFiles,
    );

    const targetWithInvalidSyntax = targetWithInvalidatedRecords.replace(
      "<red>欢迎，%player%</red>",
      "<red>欢迎，%player% §c世界</red>",
    );
    await writeFile(targetPath, targetWithInvalidSyntax);
    const finalFiles = await snapshotProjectFiles(projectDirectory);
    const finalCheck = runArtifactCli(
      "check",
      "--project",
      projectDirectory,
      "--output-format",
      "structured",
    );
    assert.equal(finalCheck.status, 1, finalCheck.stderr);
    const finalReport = readReport(finalCheck.stderr || finalCheck.stdout);
    const finalDiagnostics = finalReport.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.ok(
      finalDiagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "minimessage-syntax" &&
          diagnostic.code === "minimessage.syntax-invalid" &&
          diagnostic.origin === "target",
      ),
    );
    assert.ok(
      finalDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
    );

    const finalTextCheck = runArtifactCli(
      "check",
      "--project",
      projectDirectory,
    );
    assert.equal(finalTextCheck.status, finalCheck.status);
    const textOutput = finalTextCheck.stderr || finalTextCheck.stdout;
    assert.match(textOutput, /已修改 1 条/u);
    assert.match(textOutput, /检查覆盖不完整/u);
    assert.match(textOutput, /Bedrock/u);
    assert.match(textOutput, /bedrock\/lang\/en_us\.json/u);
    assert.match(textOutput, /不解析/u);
    const finalCoverage = finalReport.coverage as {
      readonly unavailableCapabilities: readonly string[];
    };
    for (const capability of finalCoverage.unavailableCapabilities) {
      const escapedCapability = capability
        .replaceAll("\r", "\\r")
        .replaceAll("\n", "\\n")
        .replaceAll("\0", "\\0");
      assert.ok(textOutput.includes(`尚未覆盖：${escapedCapability}`));
    }
    assert.ok(textOutput.includes("minimessage.syntax-invalid"));
    assert.ok(textOutput.includes("exception.unable-to-evaluate"));
    for (const diagnostic of finalDiagnostics) {
      assert.ok(textOutput.includes(String(diagnostic.code)));
    }
    assert.deepEqual(await snapshotProjectFiles(projectDirectory), finalFiles);
  });
});
