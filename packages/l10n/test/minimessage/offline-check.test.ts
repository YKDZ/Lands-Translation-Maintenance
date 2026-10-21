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

    const initialFiles = await snapshotProjectFiles(projectDirectory);
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
    assert.deepEqual(
      await snapshotProjectFiles(projectDirectory),
      initialFiles,
    );

    const targetPath = join(projectDirectory, "Locale/zh-CN.yml");
    const initialTarget = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      initialTarget
        .replace(
          "<green>欢迎，%player%</green>",
          "<blue>欢迎，%player% §c世界</blue>",
        )
        .replace("draft: Review this policy", "draft: 请审阅此政策"),
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
      sameTextCandidates: 1,
      confirmedSameText: 0,
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
    assert.ok(
      (editedReport.diagnostics as readonly Record<string, unknown>[]).some(
        (diagnostic) =>
          diagnostic.ruleId === "minimessage-syntax" &&
          diagnostic.code === "minimessage.syntax-invalid" &&
          diagnostic.origin === "target",
      ),
    );

    const editedTextCheck = runArtifactCli(
      "check",
      "--project",
      projectDirectory,
    );
    assert.equal(editedTextCheck.status, editedCheck.status);
    const textOutput = editedTextCheck.stderr || editedTextCheck.stdout;
    assert.match(textOutput, /已修改 1 条/u);
    assert.match(textOutput, /检查覆盖不完整/u);
    assert.match(textOutput, /Bedrock/u);
    assert.match(textOutput, /bedrock\/lang\/en_us\.json/u);
    assert.match(textOutput, /不解析/u);
    const editedCoverage = editedReport.coverage as {
      readonly unavailableCapabilities: readonly string[];
    };
    for (const capability of editedCoverage.unavailableCapabilities) {
      const escapedCapability = capability
        .replaceAll("\r", "\\r")
        .replaceAll("\n", "\\n")
        .replaceAll("\0", "\\0");
      assert.ok(textOutput.includes(`尚未覆盖：${escapedCapability}`));
    }
    assert.ok(textOutput.includes("minimessage.syntax-invalid"));
    for (const diagnostic of tagDiagnostics) {
      assert.ok(textOutput.includes(String(diagnostic.code)));
    }
    assert.deepEqual(await snapshotProjectFiles(projectDirectory), editedFiles);
  });
});
