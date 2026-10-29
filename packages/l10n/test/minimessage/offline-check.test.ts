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
      statusReport.exceptionCandidates as readonly Record<string, unknown>[]
    )
      .filter((candidate) => candidate.ruleId === "translation-review")
      .find(
        (candidate) =>
          JSON.stringify(
            (candidate.message as Record<string, unknown>).path,
          ) === '["messages","same_brand"]',
      );
    assert.ok(sameTextCandidate);
    if (sameTextCandidate === undefined)
      throw new Error("缺少待确认的同文候选");
    const candidateId = String(sameTextCandidate.id);
    const confirmed = runArtifactCliWithoutJava(
      "exempt",
      "--project",
      projectDirectory,
      "--id",
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
    const remainingSameTextCandidates = (
      missingJavaReport.exceptionCandidates as readonly Record<
        string,
        unknown
      >[]
    ).filter((candidate) => candidate.ruleId === "translation-review");
    assert.equal(remainingSameTextCandidates.length, 1);
    const remainingSeed = remainingSameTextCandidates[0];
    assert.ok(remainingSeed);
    if (remainingSeed === undefined) throw new Error("英文待翻译项未保留");
    assert.equal(
      (remainingSeed.actual as Record<string, unknown>).pendingReason,
      "translation-seed",
    );
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
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    const report = readReport(checked.stderr || checked.stdout);
    assert.equal(report.state, "ready");
    assert.deepEqual(report.diagnostics, []);
    const coverage = report.coverage as {
      readonly complete: boolean;
      readonly enabledRuleIds: readonly string[];
      readonly unavailableCapabilities: readonly string[];
    };
    assert.equal(coverage.complete, true);
    for (const ruleId of [
      "structure",
      "minimessage-tags",
      "minimessage-variables",
      "map-html",
      "terminology",
      "translation-consistency",
      "translation-style",
    ]) {
      assert.ok(coverage.enabledRuleIds.includes(ruleId), ruleId);
    }
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
      (
        (report.exceptionCandidates as readonly Record<string, unknown>[]).find(
          (candidate) => candidate.ruleId === "translation-review",
        )?.actual as Record<string, unknown> | undefined
      )?.pendingReason,
      "translation-seed",
    );
    assert.deepEqual(
      await snapshotProjectFiles(projectDirectory),
      initialFiles,
    );

    const completeTextCheck = runArtifactCli(
      "check",
      "--project",
      projectDirectory,
    );
    assert.equal(completeTextCheck.status, checked.status);
    const completeTextOutput =
      completeTextCheck.stderr || completeTextCheck.stdout;
    assert.match(completeTextOutput, /检查覆盖完整/u);
    assert.match(completeTextOutput, /已知排除资源（已登记，本次不解析）/u);
    assert.match(completeTextOutput, /Bedrock：bedrock\/lang\/en_us\.json/u);
    assert.deepEqual(
      await snapshotProjectFiles(projectDirectory),
      initialFiles,
    );

    const targetPath = join(projectDirectory, "Locale/zh-CN.yml");
    const initialTarget = await readFile(targetPath, "utf8");

    const qualityProject = join(temporaryDirectory, "terminology-style");
    await cp(fixtureDirectory, qualityProject, { recursive: true });
    const qualityTargetPath = join(qualityProject, "Locale/zh-CN.yml");
    const validQualityTarget = await readFile(qualityTargetPath, "utf8");
    await writeFile(
      qualityTargetPath,
      validQualityTarget
        .replace(
          "<green>欢迎,%player%</green>",
          "<green>您欢迎，%player%</green>",
        )
        .replace('duplicate_a: "启用联邦"', 'duplicate_a: "启用国家"')
        .replace('duplicate_b: "启用联邦"', 'duplicate_b: "启用国家"'),
    );
    const invalidQualityFiles = await snapshotProjectFiles(qualityProject);
    const invalidQualityCheck = runArtifactCli(
      "check",
      "--project",
      qualityProject,
      "--output-format",
      "structured",
    );
    assert.equal(invalidQualityCheck.status, 1, invalidQualityCheck.stderr);
    const invalidQualityReport = readReport(
      invalidQualityCheck.stderr || invalidQualityCheck.stdout,
    );
    assert.equal(invalidQualityReport.state, "issues");
    const invalidQualityCoverage = invalidQualityReport.coverage as {
      readonly complete: boolean;
    };
    assert.equal(invalidQualityCoverage.complete, true);
    const invalidQualityDiagnostics =
      invalidQualityReport.diagnostics as readonly Record<string, unknown>[];
    assert.ok(
      invalidQualityDiagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "terminology" &&
          diagnostic.code === "terminology.translation-missing",
      ),
      JSON.stringify(invalidQualityDiagnostics),
    );
    assert.ok(
      invalidQualityDiagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "translation-style" &&
          diagnostic.code === "translation-style.honorific",
      ),
      JSON.stringify(invalidQualityDiagnostics),
    );
    assert.ok(
      invalidQualityDiagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "translation-style" &&
          diagnostic.code === "translation-style.punctuation",
      ),
      JSON.stringify(invalidQualityDiagnostics),
    );
    assert.deepEqual(
      await snapshotProjectFiles(qualityProject),
      invalidQualityFiles,
    );

    const qualityConfigPath = join(qualityProject, ".l10n/config.yml");
    const qualityConfig = await readFile(qualityConfigPath, "utf8");
    await writeFile(
      qualityConfigPath,
      `${qualityConfig}rules:\n  terminology:\n    severity: warning\n  translation-style:\n    severity: warning\n`,
    );
    const warningPolicyFiles = await snapshotProjectFiles(qualityProject);
    const warningPolicyCheck = runArtifactCli(
      "check",
      "--project",
      qualityProject,
      "--output-format",
      "structured",
    );
    assert.equal(warningPolicyCheck.status, 0, warningPolicyCheck.stderr);
    const warningPolicyReport = readReport(
      warningPolicyCheck.stderr || warningPolicyCheck.stdout,
    );
    assert.equal(warningPolicyReport.state, "ready");
    assert.equal(
      (warningPolicyReport.coverage as { readonly complete: boolean }).complete,
      true,
    );
    const warningPolicyDiagnostics =
      warningPolicyReport.diagnostics as readonly Record<string, unknown>[];
    assert.ok(warningPolicyDiagnostics.length > 0);
    assert.ok(
      warningPolicyDiagnostics.every(
        (diagnostic) => diagnostic.severity === "warning",
      ),
      JSON.stringify(warningPolicyDiagnostics),
    );
    assert.deepEqual(
      await snapshotProjectFiles(qualityProject),
      warningPolicyFiles,
    );

    await writeFile(
      qualityConfigPath,
      `${qualityConfig}rules:\n  terminology:\n    severity: warning\n    parameters:\n      translations:\n        nation: 国家\n  translation-style:\n    severity: warning\n`,
    );
    const termParameterFiles = await snapshotProjectFiles(qualityProject);
    const termParameterCheck = runArtifactCli(
      "check",
      "--project",
      qualityProject,
      "--output-format",
      "structured",
    );
    assert.equal(termParameterCheck.status, 0, termParameterCheck.stderr);
    const termParameterReport = readReport(
      termParameterCheck.stderr || termParameterCheck.stdout,
    );
    assert.equal(termParameterReport.state, "ready");
    assert.equal(
      (termParameterReport.coverage as { readonly complete: boolean }).complete,
      true,
    );
    const termParameterDiagnostics =
      termParameterReport.diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      termParameterDiagnostics.some(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      false,
      JSON.stringify(termParameterDiagnostics),
    );
    assert.ok(
      termParameterDiagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "translation-style" &&
          diagnostic.code === "translation-style.honorific",
      ),
    );
    assert.deepEqual(
      await snapshotProjectFiles(qualityProject),
      termParameterFiles,
    );

    await writeFile(
      targetPath,
      initialTarget
        .replace("<green>欢迎,%player%</green>", "<blue>欢迎,%player%</blue>")
        .replace(
          "<click:run_command:/lands claim><green>占领<v:land></green></click>",
          "<click:run_command:/lands claim><green>占领</green></click>",
        )
        .replace("draft: Review this policy", "draft: 请审阅此政策")
        .replace('duplicate_b: "启用联邦"', 'duplicate_b: "关闭联邦"'),
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

    const targetWithMissingMessage = (await readFile(targetPath, "utf8"))
      .replace("  draft: 请审阅此政策\n", "")
      .replace(
        '<div class="land" title="城镇">',
        '<div class="town" title="城镇">',
      );
    await writeFile(targetPath, targetWithMissingMessage);
    const checkInputFiles = await snapshotProjectFiles(projectDirectory);

    const editedCheck = runArtifactCli(
      "check",
      "--project",
      projectDirectory,
      "--output-format",
      "structured",
    );
    assert.equal(editedCheck.status, 1, editedCheck.stderr);
    const editedReport = readReport(editedCheck.stderr || editedCheck.stdout);
    const editedDiagnostics = editedReport.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.ok(
      editedDiagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "structure" &&
          diagnostic.code === "message.missing" &&
          JSON.stringify(
            (diagnostic.message as Record<string, unknown>).path,
          ) === '["messages","draft"]',
      ),
      JSON.stringify(editedDiagnostics),
    );
    assert.ok(
      editedDiagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "map-html" &&
          diagnostic.code === "map-html.behavior-attribute-mismatch",
      ),
      JSON.stringify(editedDiagnostics),
    );
    assert.deepEqual(
      await snapshotProjectFiles(projectDirectory),
      checkInputFiles,
    );
    const tagDiagnostics = (
      editedReport.diagnostics as readonly Record<string, unknown>[]
    ).filter(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-tags" &&
        diagnostic.code === "minimessage.tag-mismatch",
    );
    const greetingTagDiagnostics = tagDiagnostics.filter(
      (diagnostic) =>
        JSON.stringify((diagnostic.message as Record<string, unknown>).path) ===
        '["messages","greeting"]',
    );
    assert.equal(greetingTagDiagnostics.length, 2);
    assert.ok(
      (editedReport.diagnostics as readonly Record<string, unknown>[]).some(
        (diagnostic) =>
          diagnostic.ruleId === "minimessage-variables" &&
          diagnostic.code === "minimessage.variable-missing",
      ),
      JSON.stringify(editedReport.diagnostics),
    );
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

    const exemptedDiagnosticId = String(
      greetingTagDiagnostics[0]?.diagnosticId,
    );
    const exempted = runArtifactCli(
      "exempt",
      "--project",
      projectDirectory,
      "--id",
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
    assert.equal(remainingTagDiagnostics.length, 2);
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
      .replace('same_brand: "Lands plugin"', 'same_brand: "Lands plugin 新"');
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
        (diagnostic) =>
          diagnostic.code === "exception.orphaned" &&
          JSON.stringify(
            (diagnostic.location as Record<string, unknown>).path,
          ) === '["messages","same_brand"]',
      ),
    );
    assert.ok(
      invalidatedDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.review-required",
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
      3,
    );
    assert.deepEqual(
      await snapshotProjectFiles(projectDirectory),
      invalidatedFiles,
    );

    const targetWithInvalidSyntax = targetWithInvalidatedRecords.replace(
      "<red>欢迎,%player%</red>",
      "<red>欢迎,%player% §c世界</red>",
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
    assert.match(textOutput, /已修改 0 条/u);
    assert.match(textOutput, /缺失 1 条/u);
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
    assert.ok(textOutput.includes("exception.unable-to-evaluate"));
    for (const diagnostic of finalDiagnostics) {
      assert.ok(textOutput.includes(String(diagnostic.code)));
    }
    assert.deepEqual(await snapshotProjectFiles(projectDirectory), finalFiles);

    const declarationProject = join(temporaryDirectory, "changed-declaration");
    await cp(fixtureDirectory, declarationProject, { recursive: true });
    const declarationPath = join(declarationProject, ".l10n/config.yml");
    const originalDeclaration = await readFile(declarationPath, "utf8");
    await writeFile(
      declarationPath,
      originalDeclaration.replace(
        "  - path: bedrock/lang/en_us.json\n    purpose: bedrock-excluded\n",
        "  - path: bedrock/lang/en_us.json\n    purpose: bedrock-excluded\n  - path: Locale/unavailable-candidate.yml\n    purpose: chat-language\n",
      ),
    );
    const changedDeclarationFiles =
      await snapshotProjectFiles(declarationProject);
    const changedDeclarationStatus = runArtifactCliWithoutJava(
      "status",
      "--project",
      declarationProject,
      "--output-format",
      "structured",
    );
    assert.equal(changedDeclarationStatus.status, 1);
    const changedDeclarationReport = readReport(
      changedDeclarationStatus.stdout || changedDeclarationStatus.stderr,
    );
    assert.ok(
      (
        changedDeclarationReport.diagnostics as readonly Record<
          string,
          unknown
        >[]
      ).some((diagnostic) => diagnostic.code === "sync.configuration-changed"),
    );
    assert.equal(
      (changedDeclarationReport.summary as { readonly resourceFiles: number })
        .resourceFiles,
      6,
    );
    assert.equal(
      (changedDeclarationReport.summary as { readonly messages: number })
        .messages,
      8,
    );
    assert.ok(
      !JSON.stringify(changedDeclarationReport).includes(
        "Locale/unavailable-candidate.yml",
      ),
    );
    assert.deepEqual(
      await snapshotProjectFiles(declarationProject),
      changedDeclarationFiles,
    );
    const changedDeclarationCheck = runArtifactCliWithoutJava(
      "check",
      "--project",
      declarationProject,
      "--output-format",
      "structured",
    );
    assert.equal(changedDeclarationCheck.status, 1);
    const changedDeclarationCheckReport = readReport(
      changedDeclarationCheck.stdout || changedDeclarationCheck.stderr,
    );
    assert.ok(
      (
        changedDeclarationCheckReport.diagnostics as readonly Record<
          string,
          unknown
        >[]
      ).some((diagnostic) => diagnostic.code === "sync.configuration-changed"),
    );
    assert.ok(
      !JSON.stringify(changedDeclarationCheckReport).includes(
        "Locale/unavailable-candidate.yml",
      ),
    );
    assert.deepEqual(
      await snapshotProjectFiles(declarationProject),
      changedDeclarationFiles,
    );
    const changedDeclarationText = runArtifactCliWithoutJava(
      "status",
      "--project",
      declarationProject,
    );
    assert.equal(
      changedDeclarationText.status,
      changedDeclarationStatus.status,
    );
    assert.match(
      changedDeclarationText.stdout || changedDeclarationText.stderr,
      /lands-l10n sync --project <项目目录> --jar <候选 JAR>/u,
    );
    assert.deepEqual(
      await snapshotProjectFiles(declarationProject),
      changedDeclarationFiles,
    );

    const baselineProject = join(temporaryDirectory, "changed-baseline");
    await cp(fixtureDirectory, baselineProject, { recursive: true });
    const baselinePath = join(
      baselineProject,
      ".l10n/upstream/source-baseline.json",
    );
    await writeFile(baselinePath, `${await readFile(baselinePath, "utf8")} `);
    const changedBaselineFiles = await snapshotProjectFiles(baselineProject);
    for (const operation of ["status", "check"] as const) {
      const result = runArtifactCliWithoutJava(
        operation,
        "--project",
        baselineProject,
        "--output-format",
        "structured",
      );
      assert.equal(result.status, 1, result.stderr);
      const invalidReport = readReport(result.stdout || result.stderr);
      const invalidDiagnostics = invalidReport.diagnostics as readonly Record<
        string,
        unknown
      >[];
      assert.ok(
        invalidDiagnostics.some(
          (diagnostic) =>
            diagnostic.code === "state.invalid" &&
            String(diagnostic.reason).includes(
              "原文基线摘要与同步锁文件不一致",
            ),
        ),
        JSON.stringify(invalidDiagnostics),
      );
      assert.equal(
        (invalidReport.summary as { readonly resourceFiles: number })
          .resourceFiles,
        0,
      );
      assert.deepEqual(invalidReport.exceptionCandidates, []);
      assert.deepEqual(
        await snapshotProjectFiles(baselineProject),
        changedBaselineFiles,
      );
    }
    const incompleteLockProject = join(temporaryDirectory, "incomplete-lock");
    await cp(fixtureDirectory, incompleteLockProject, { recursive: true });
    await rm(join(incompleteLockProject, ".l10n/lock.json"));
    const incompleteLockFiles = await snapshotProjectFiles(
      incompleteLockProject,
    );
    for (const operation of ["status", "check"] as const) {
      const result = runArtifactCliWithoutJava(
        operation,
        "--project",
        incompleteLockProject,
        "--output-format",
        "structured",
      );
      assert.equal(result.status, 1, result.stderr);
      const invalidReport = readReport(result.stdout || result.stderr);
      const invalidDiagnostics = invalidReport.diagnostics as readonly Record<
        string,
        unknown
      >[];
      assert.ok(
        invalidDiagnostics.some(
          (diagnostic) =>
            diagnostic.code === "state.invalid" &&
            String(diagnostic.reason).includes("同步锁文件不完整"),
        ),
        JSON.stringify(invalidDiagnostics),
      );
      assert.equal(
        (invalidReport.summary as { readonly resourceFiles: number })
          .resourceFiles,
        0,
      );
      assert.deepEqual(invalidReport.exceptionCandidates, []);
      assert.deepEqual(
        await snapshotProjectFiles(incompleteLockProject),
        incompleteLockFiles,
      );
    }
    const policyProject = join(temporaryDirectory, "changed-policy");
    await cp(fixtureDirectory, policyProject, { recursive: true });
    const policyTargetPath = join(policyProject, "Locale/zh-CN.yml");
    const policyTarget = await readFile(policyTargetPath, "utf8");
    await writeFile(
      policyTargetPath,
      policyTarget
        .replace("<green>欢迎,%player%</green>", "<blue>欢迎,%player%</blue>")
        .replace("  draft: Review this policy\n", ""),
    );
    const defaultPolicyFiles = await snapshotProjectFiles(policyProject);
    const defaultPolicyCheck = runArtifactCli(
      "check",
      "--project",
      policyProject,
      "--output-format",
      "structured",
    );
    assert.equal(defaultPolicyCheck.status, 1, defaultPolicyCheck.stderr);
    const defaultPolicyReport = readReport(
      defaultPolicyCheck.stdout || defaultPolicyCheck.stderr,
    );
    const defaultPolicyDiagnostics =
      defaultPolicyReport.diagnostics as readonly Record<string, unknown>[];
    assert.ok(
      defaultPolicyDiagnostics.some(
        (diagnostic) =>
          diagnostic.code === "message.missing" &&
          diagnostic.severity === "error",
      ),
    );
    assert.ok(
      defaultPolicyDiagnostics.some(
        (diagnostic) => diagnostic.code === "minimessage.tag-mismatch",
      ),
    );
    assert.deepEqual(
      await snapshotProjectFiles(policyProject),
      defaultPolicyFiles,
    );
    const policyConfigPath = join(policyProject, ".l10n/config.yml");
    await writeFile(
      policyConfigPath,
      `${await readFile(policyConfigPath, "utf8")}rules:\n  structure:\n    severity: warning\n  minimessage-tags:\n    enabled: false\n`,
    );
    const configuredPolicyFiles = await snapshotProjectFiles(policyProject);
    const configuredPolicyCheck = runArtifactCli(
      "check",
      "--project",
      policyProject,
      "--output-format",
      "structured",
    );
    assert.equal(configuredPolicyCheck.status, 1);
    const configuredPolicyReport = readReport(
      configuredPolicyCheck.stdout || configuredPolicyCheck.stderr,
    );
    const configuredPolicyDiagnostics =
      configuredPolicyReport.diagnostics as readonly Record<string, unknown>[];
    assert.ok(
      configuredPolicyDiagnostics.some(
        (diagnostic) =>
          diagnostic.code === "message.missing" &&
          diagnostic.severity === "warning",
      ),
    );
    assert.ok(
      !configuredPolicyDiagnostics.some(
        (diagnostic) => diagnostic.code === "minimessage.tag-mismatch",
      ),
    );
    const configuredCoverage = configuredPolicyReport.coverage as {
      readonly complete: boolean;
      readonly enabledRuleIds: readonly string[];
      readonly disabledRuleIds: readonly string[];
    };
    assert.equal(configuredCoverage.complete, false);
    assert.ok(configuredCoverage.disabledRuleIds.includes("minimessage-tags"));
    assert.ok(!configuredCoverage.enabledRuleIds.includes("minimessage-tags"));
    assert.ok(
      !configuredPolicyDiagnostics.some(
        (diagnostic) => diagnostic.code === "sync.configuration-changed",
      ),
    );
    assert.deepEqual(
      await snapshotProjectFiles(policyProject),
      configuredPolicyFiles,
    );
    const configuredPolicyText = runArtifactCli(
      "check",
      "--project",
      policyProject,
    );
    assert.equal(configuredPolicyText.status, configuredPolicyCheck.status);
    assert.match(
      configuredPolicyText.stdout || configuredPolicyText.stderr,
      /已禁用规则：minimessage-tags/u,
    );
    assert.match(
      configuredPolicyText.stdout || configuredPolicyText.stderr,
      /\[warning\].*message\.missing/u,
    );
    assert.deepEqual(
      await snapshotProjectFiles(policyProject),
      configuredPolicyFiles,
    );
  });
});
