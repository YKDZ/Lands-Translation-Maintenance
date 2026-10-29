import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import { builtInRules, inspectProject } from "@lands-l10n/l10n";
import type { CheckRule } from "@lands-l10n/l10n";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import {
  createFormatProject,
  createGuiProject,
  createProject,
  readReport,
  runCli,
  runCliWithoutJava,
  snapshotProjectFiles,
} from "../cli-fixtures.ts";

const repeatedSource = "You cannot claim <v:land>.";

async function createMessageProject(
  t: TestContext,
  sources: readonly [string, string, string, string],
  translations: readonly [string, string, string, string],
) {
  const project = await createGuiProject(t, {
    name: sources[0],
    lore: [sources[1]],
    dialogItemName: sources[2],
    categoryName: sources[3],
  });
  const initialized = runCli(
    "init",
    "--project",
    project.directory,
    "--jar",
    project.jarFile,
    "--output-format",
    "structured",
  );
  assert.equal(initialized.status, 0, initialized.stderr);

  const targets = [
    ["Locale/zh-CN_gui.yml", sources[0], translations[0]],
    ["Locale/zh-CN_gui.yml", sources[1], translations[1]],
    ["Locale/zh-CN_dialogs.yml", sources[2], translations[2]],
    ["Locale/zh-CN_categories.yml", sources[3], translations[3]],
  ] as const;
  for (const [file, source, translation] of targets) {
    const path = join(project.directory, file);
    const contents = await readFile(path, "utf8");
    const index = contents.indexOf(source);
    assert.notEqual(index, -1, `${file} 应包含初始化写入的原文`);
    await writeFile(
      path,
      `${contents.slice(0, index)}${translation}${contents.slice(index + source.length)}`,
    );
  }
  return project;
}

function consistencyDiagnostics(report: Record<string, unknown>) {
  return (report.diagnostics as readonly Record<string, unknown>[]).filter(
    (diagnostic) => diagnostic.ruleId === "translation-consistency",
  );
}

void describe("跨消息翻译一致性", () => {
  void it("跨文件与字段报告同原文异译，并保留参与消息身份；同译不误报", async (t) => {
    const divergent = await createMessageProject(
      t,
      [repeatedSource, repeatedSource, repeatedSource, repeatedSource],
      [
        "你不能认领<v:land>。",
        "你不能认领<v:land>。",
        "无法认领<v:land>。",
        "不可认领<v:land>。",
      ],
    );
    const beforeCheck = await snapshotProjectFiles(divergent.directory);
    const checked = runCli(
      "check",
      "--project",
      divergent.directory,
      "--output-format",
      "structured",
    );
    assert.equal(checked.status, 1, checked.stderr || checked.stdout);
    const report = readReport(checked.stdout || checked.stderr);
    const issues = consistencyDiagnostics(report);

    assert.equal(issues.length, 1, checked.stderr || checked.stdout);
    assert.equal(issues[0]?.code, "translation-consistency.same-source");
    const participants = JSON.stringify(issues[0]?.actual);
    assert.match(participants, /Locale\/zh-CN_gui\.yml/u);
    assert.match(participants, /Locale\/zh-CN_dialogs\.yml/u);
    assert.match(participants, /Locale\/zh-CN_categories\.yml/u);
    assert.match(participants, /physical/u);
    assert.match(participants, /dialogs/u);
    assert.match(participants, /land/u);
    assert.match(JSON.stringify(issues[0]?.expected), /You cannot claim/u);
    assert.deepEqual(
      await snapshotProjectFiles(divergent.directory),
      beforeCheck,
      "check 不得改写项目文件",
    );

    const textCheck = runCli(
      "check",
      "--project",
      divergent.directory,
      "--output-format",
      "text",
    );
    assert.equal(textCheck.status, 1, textCheck.stderr || textCheck.stdout);
    assert.match(
      textCheck.stdout || textCheck.stderr,
      /translation-consistency\.same-source/u,
    );
    assert.match(
      textCheck.stdout || textCheck.stderr,
      /Locale\/zh-CN_dialogs\.yml/u,
    );
    assert.match(textCheck.stdout || textCheck.stderr, /无法认领/u);
    assert.match(
      textCheck.stdout || textCheck.stderr,
      new RegExp(String(issues[0]?.diagnosticId), "u"),
    );

    const inRegistrationOrder = await inspectProject(
      divergent.directory,
      "check",
      builtInRules,
    );
    const inReverseOrder = await inspectProject(
      divergent.directory,
      "check",
      [...builtInRules].reverse(),
    );
    const consistencySummary = (report: typeof inRegistrationOrder) =>
      report.diagnostics
        .filter((diagnostic) => diagnostic.ruleId === "translation-consistency")
        .map(({ diagnosticId, objectId, contentFingerprint, code }) => ({
          diagnosticId,
          objectId,
          contentFingerprint,
          code,
        }));
    assert.deepEqual(
      consistencySummary(inRegistrationOrder),
      consistencySummary(inReverseOrder),
    );

    const exemption = runCli(
      "exempt",
      "--project",
      divergent.directory,
      "--id",
      String(issues[0]?.diagnosticId),
      "--reason",
      "此场景按业务上下文保留不同译法",
      "--output-format",
      "structured",
    );
    assert.equal(exemption.status, 0, exemption.stderr || exemption.stdout);
    const afterExemption = runCli(
      "check",
      "--project",
      divergent.directory,
      "--output-format",
      "structured",
    );
    const afterExemptionReport = readReport(
      afterExemption.stdout || afterExemption.stderr,
    );
    assert.equal(
      (
        afterExemptionReport.diagnostics as readonly Record<string, unknown>[]
      ).some(
        (diagnostic) => diagnostic.diagnosticId === issues[0]?.diagnosticId,
      ),
      false,
    );

    const consistent = await createMessageProject(
      t,
      [repeatedSource, repeatedSource, repeatedSource, repeatedSource],
      [
        "你不能认领<v:land>。",
        "你不能认领<v:land>。",
        "你不能认领<v:land>。",
        "你不能认领<v:land>。",
      ],
    );
    const consistentCheck = runCli(
      "check",
      "--project",
      consistent.directory,
      "--output-format",
      "structured",
    );
    const consistentReport = readReport(
      consistentCheck.stdout || consistentCheck.stderr,
    );
    assert.deepEqual(consistencyDiagnostics(consistentReport), []);
  });

  void it("按列表项路径配对，并识别没有待翻译记录的同文", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "first",
      sourceEntries: ["first", "second"],
    });
    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(
      initialized.status,
      0,
      initialized.stderr || initialized.stdout,
    );

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace(
        /^  greeting:.*$/mu,
        `  greeting: ${JSON.stringify("第一项")}`,
      ),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stdout || checked.stderr);

    assert.deepEqual(consistencyDiagnostics(report), []);

    const partiallyTranslated = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      partiallyTranslated
        .replace(/^  greeting:.*$/mu, `  greeting: ${JSON.stringify("你好")}`)
        .replace(/^    - 第一项$/mu, "    - first")
        .replace(
          /^  welcome:.*$/mu,
          `  welcome: ${JSON.stringify("§c未完成")}`,
        ),
    );
    const partialCheck = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const partialReport = readReport(
      partialCheck.stdout || partialCheck.stderr,
    );
    const partialConsistency = consistencyDiagnostics(partialReport).filter(
      (diagnostic) => diagnostic.code === "translation-consistency.same-source",
    );
    assert.equal(
      partialConsistency.length,
      1,
      partialCheck.stderr || partialCheck.stdout,
    );
    const partialFinding = partialConsistency[0];
    assert.ok(partialFinding);
    assert.equal(
      (partialFinding.expected as { readonly sourceText?: string }).sourceText,
      "first",
    );
    const partialParticipants = JSON.stringify(partialFinding.actual);
    assert.match(partialParticipants, /greeting/u);
    assert.match(partialParticipants, /entries/u);
    assert.ok(
      (partialReport.diagnostics as readonly Record<string, unknown>[]).some(
        (diagnostic) => diagnostic.code === "minimessage.syntax-invalid",
      ),
      partialCheck.stderr || partialCheck.stdout,
    );
  });

  void it("按正式交互归属配对重排的悬浮文档", async (t) => {
    const clickHover = (command: string, hover: string, body: string) =>
      `<click:run_command:'/${command}'><hover:show_text:'${hover}'>${body}</hover></click>`;
    const firstSource = clickHover("a", "First", "A");
    const secondSource = clickHover("b", "Second", "B");
    const greetingSource = `${firstSource} ${secondSource}`;
    const welcomeSource = firstSource;
    const greetingTranslation = `${clickHover("b", "第二项", "乙")} ${clickHover("a", "第一项", "甲")}`;
    const welcomeTranslation = clickHover("a", "第一项", "甲");
    const project = await createProject(t, {
      sourceGreeting: greetingSource,
    });
    const jar = unzipSync(await readFile(project.jarFile));
    jar["lang/en.yml"] = strToU8(
      strFromU8(jar["lang/en.yml"]!).replace(
        /^  welcome:.*$/mu,
        `  welcome: ${JSON.stringify(welcomeSource)}`,
      ),
    );
    await writeFile(project.jarFile, zipSync(jar));

    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(
      initialized.status,
      0,
      initialized.stderr || initialized.stdout,
    );
    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target
        .replace(
          /^  greeting:.*$/mu,
          `  greeting: ${JSON.stringify(greetingTranslation)}`,
        )
        .replace(
          /^  welcome:.*$/mu,
          `  welcome: ${JSON.stringify(welcomeTranslation)}`,
        ),
    );

    const consistentCheck = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const consistentReport = readReport(
      consistentCheck.stdout || consistentCheck.stderr,
    );
    assert.deepEqual(
      consistencyDiagnostics(consistentReport),
      [],
      consistentCheck.stderr || consistentCheck.stdout,
    );

    const changedTarget = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      changedTarget.replace(
        JSON.stringify(greetingTranslation),
        JSON.stringify(greetingTranslation.replace("第一项", "错译")),
      ),
    );
    const divergentCheck = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const divergentReport = readReport(
      divergentCheck.stdout || divergentCheck.stderr,
    );
    const sameSource = consistencyDiagnostics(divergentReport).filter(
      (diagnostic) => diagnostic.code === "translation-consistency.same-source",
    );
    assert.equal(
      sameSource.length,
      1,
      divergentCheck.stderr || divergentCheck.stdout,
    );
    const finding = sameSource[0];
    assert.ok(finding);
    assert.equal(
      (finding.expected as { readonly sourceText?: string }).sourceText,
      "First",
    );
    const participants = JSON.stringify(finding.actual);
    assert.match(participants, /错译/u);
    assert.match(participants, /第一项/u);
  });

  void it("豁免按同组全部必要输入等待，且忽略无关消息", async (t) => {
    const project = await createProject(t, { sourceGreeting: "Welcome" });
    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(
      initialized.status,
      0,
      initialized.stderr || initialized.stdout,
    );

    const targetPath = join(project.directory, "lang/zh.yml");
    const setTarget = async (name: string, value: string) => {
      const target = await readFile(targetPath, "utf8");
      const field = new RegExp(`^(  ${name}: ).*$`, "mu");
      if (field.test(target)) {
        await writeFile(
          targetPath,
          target.replace(field, `$1${JSON.stringify(value)}`),
        );
      } else {
        await writeFile(
          targetPath,
          target.replace(
            /^(  greeting: .*\n)/mu,
            `$1  ${name}: ${JSON.stringify(value)}\n`,
          ),
        );
      }
    };
    await setTarget("greeting", "你好");
    await setTarget("welcome", "欢迎");

    const before = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const beforeReport = readReport(before.stdout || before.stderr);
    const group = consistencyDiagnostics(beforeReport).find(
      (diagnostic) => diagnostic.code === "translation-consistency.same-source",
    );
    assert.ok(group, before.stderr || before.stdout);

    const exempted = runCli(
      "exempt",
      "--project",
      project.directory,
      "--id",
      String(group.diagnosticId),
      "--reason",
      "临时复核具体同源译文组",
      "--output-format",
      "structured",
    );
    assert.equal(exempted.status, 0, exempted.stderr || exempted.stdout);

    const setRegistered = async (value: string) => {
      const target = await readFile(targetPath, "utf8");
      await writeFile(
        targetPath,
        target.replace(
          /^(    registered: ).*$/mu,
          `$1${JSON.stringify(value)}`,
        ),
      );
    };
    await setRegistered("§c无关消息");
    const unrelatedUnavailable = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const unrelatedReport = readReport(
      unrelatedUnavailable.stdout || unrelatedUnavailable.stderr,
    );
    const unrelatedExceptions = (
      unrelatedReport.diagnostics as readonly Record<string, unknown>[]
    ).filter((diagnostic) => diagnostic.ruleId === "exceptions");
    assert.equal(
      unrelatedExceptions.some((diagnostic) =>
        ["exception.unable-to-evaluate", "exception.orphaned"].includes(
          String(diagnostic.code),
        ),
      ),
      false,
      unrelatedUnavailable.stderr || unrelatedUnavailable.stdout,
    );

    await setRegistered("已注册");
    await setTarget("welcome", "§c未完成");
    const unavailable = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const unavailableReport = readReport(
      unavailable.stdout || unavailable.stderr,
    );
    const unavailableExceptions = (
      unavailableReport.diagnostics as readonly Record<string, unknown>[]
    ).filter((diagnostic) => diagnostic.ruleId === "exceptions");
    assert.ok(
      unavailableExceptions.some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
      unavailable.stderr || unavailable.stdout,
    );
    assert.equal(
      unavailableExceptions.some(
        (diagnostic) => diagnostic.code === "exception.orphaned",
      ),
      false,
      unavailable.stderr || unavailable.stdout,
    );

    await setTarget("welcome", "欢迎");
    const recovered = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const recoveredReport = readReport(recovered.stdout || recovered.stderr);
    assert.equal(
      (recoveredReport.diagnostics as readonly Record<string, unknown>[]).some(
        (diagnostic) =>
          diagnostic.code === "exception.unable-to-evaluate" ||
          diagnostic.code === "exception.orphaned",
      ),
      false,
      recovered.stderr || recovered.stdout,
    );

    await setTarget("welcome", "你好");
    const disappeared = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const disappearedReport = readReport(
      disappeared.stdout || disappeared.stderr,
    );
    assert.ok(
      (
        disappearedReport.diagnostics as readonly Record<string, unknown>[]
      ).some((diagnostic) => diagnostic.code === "exception.orphaned"),
      disappeared.stderr || disappeared.stdout,
    );

    const configPath = join(project.directory, ".l10n/config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${config}\nrules:\n  translation-consistency:\n    enabled: false\n`,
    );
    const disabled = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const disabledReport = readReport(disabled.stdout || disabled.stderr);
    assert.ok(
      (disabledReport.diagnostics as readonly Record<string, unknown>[]).some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
      disabled.stderr || disabled.stdout,
    );
  });

  void it("列表项 hover 真消失与输入解析失败使用不同豁免状态", async (t) => {
    const sourceEntries = [
      "<hover:show_text:'Welcome'>One</hover>",
      "<hover:show_text:'Welcome'>Two</hover>",
    ] as const;
    const targetEntries = [
      "<hover:show_text:'你好'>一</hover>",
      "<hover:show_text:'欢迎'>二</hover>",
    ] as const;
    const project = await createProject(t, { sourceEntries });
    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(
      initialized.status,
      0,
      initialized.stderr || initialized.stdout,
    );

    const targetPath = join(project.directory, "lang/zh.yml");
    const writeEntries = async (entries: readonly string[]) => {
      const contents = await readFile(targetPath, "utf8");
      const updated = contents.replace(
        /^  entries:\n(?:    - .*\n){2}/mu,
        `  entries:\n${entries.map((entry) => `    - ${JSON.stringify(entry)}\n`).join("")}`,
      );
      assert.notEqual(updated, contents);
      await writeFile(targetPath, updated);
    };
    await writeEntries(targetEntries);

    const before = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const beforeReport = readReport(before.stdout || before.stderr);
    const group = consistencyDiagnostics(beforeReport).find(
      (diagnostic) => diagnostic.code === "translation-consistency.same-source",
    );
    assert.ok(group, before.stderr || before.stdout);
    const exempted = runCli(
      "exempt",
      "--project",
      project.directory,
      "--id",
      String(group.diagnosticId),
      "--reason",
      "临时复核列表项 hover 生命周期",
      "--output-format",
      "structured",
    );
    assert.equal(exempted.status, 0, exempted.stderr || exempted.stdout);

    await writeEntries([targetEntries[0], "二"]);
    const removed = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const removedReport = readReport(removed.stdout || removed.stderr);
    const removedDiagnostics = removedReport.diagnostics as readonly Record<
      string,
      unknown
    >[];
    const removedExceptions = removedDiagnostics.filter(
      (diagnostic) => diagnostic.ruleId === "exceptions",
    );
    assert.ok(
      removedExceptions.some(
        (diagnostic) => diagnostic.code === "exception.orphaned",
      ),
      removed.stderr || removed.stdout,
    );
    assert.equal(
      removedExceptions.some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
      false,
      removed.stderr || removed.stdout,
    );
    assert.ok(
      removedDiagnostics.some(
        (diagnostic) => diagnostic.code === "minimessage.tag-mismatch",
      ),
      removed.stderr || removed.stdout,
    );

    await writeEntries(targetEntries);
    const restored = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const restoredReport = readReport(restored.stdout || restored.stderr);
    assert.equal(
      (restoredReport.diagnostics as readonly Record<string, unknown>[]).some(
        (diagnostic) =>
          diagnostic.code === "exception.orphaned" ||
          diagnostic.code === "exception.unable-to-evaluate",
      ),
      false,
      restored.stderr || restored.stdout,
    );

    await writeEntries([targetEntries[0], "§c未完成"]);
    const unavailable = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const unavailableReport = readReport(
      unavailable.stdout || unavailable.stderr,
    );
    const unavailableExceptions = (
      unavailableReport.diagnostics as readonly Record<string, unknown>[]
    ).filter((diagnostic) => diagnostic.ruleId === "exceptions");
    assert.ok(
      unavailableExceptions.some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
      unavailable.stderr || unavailable.stdout,
    );
    assert.equal(
      unavailableExceptions.some(
        (diagnostic) => diagnostic.code === "exception.orphaned",
      ),
      false,
      unavailable.stderr || unavailable.stdout,
    );

    await writeEntries(targetEntries);
    const recovered = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const recoveredReport = readReport(recovered.stdout || recovered.stderr);
    assert.equal(
      (recoveredReport.diagnostics as readonly Record<string, unknown>[]).some(
        (diagnostic) =>
          diagnostic.code === "exception.orphaned" ||
          diagnostic.code === "exception.unable-to-evaluate",
      ),
      false,
      recovered.stderr || recovered.stdout,
    );
  });

  void it("已解析的参与 hover 表面消失时仍孤立旧组豁免", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "<hover:show_text:'Welcome'>First</hover>",
    });
    const jar = unzipSync(await readFile(project.jarFile));
    jar["lang/en.yml"] = strToU8(
      strFromU8(jar["lang/en.yml"]!).replace(
        /^  welcome:.*$/mu,
        `  welcome: ${JSON.stringify("<hover:show_text:'Welcome'>Second</hover>")}`,
      ),
    );
    await writeFile(project.jarFile, zipSync(jar));

    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(
      initialized.status,
      0,
      initialized.stderr || initialized.stdout,
    );

    const targetPath = join(project.directory, "lang/zh.yml");
    let target = await readFile(targetPath, "utf8");
    target = target
      .replace(
        /^  greeting:.*$/mu,
        `  greeting: ${JSON.stringify("<hover:show_text:'你好'>第一条</hover>")}`,
      )
      .replace(
        /^  welcome:.*$/mu,
        `  welcome: ${JSON.stringify("<hover:show_text:'欢迎'>第二条</hover>")}`,
      );
    await writeFile(targetPath, target);

    const before = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const beforeReport = readReport(before.stdout || before.stderr);
    const group = consistencyDiagnostics(beforeReport).find(
      (diagnostic) => diagnostic.code === "translation-consistency.same-source",
    );
    assert.ok(group, before.stderr || before.stdout);
    const exempted = runCli(
      "exempt",
      "--project",
      project.directory,
      "--id",
      String(group.diagnosticId),
      "--reason",
      "临时复核 hover 表面删除后的生命周期",
      "--output-format",
      "structured",
    );
    assert.equal(exempted.status, 0, exempted.stderr || exempted.stdout);

    const primaryPath = (
      group.message as { readonly path?: readonly (string | number)[] }
    ).path?.at(-1);
    assert.ok(primaryPath === "greeting" || primaryPath === "welcome");
    const nonPrimary = primaryPath === "greeting" ? "welcome" : "greeting";
    target = await readFile(targetPath, "utf8");
    const hoverText =
      nonPrimary === "welcome"
        ? "<hover:show_text:'欢迎'>第二条</hover>"
        : "<hover:show_text:'你好'>第一条</hover>";
    const bodyText = nonPrimary === "welcome" ? "第二条" : "第一条";
    await writeFile(
      targetPath,
      target.replace(
        new RegExp(`^  ${nonPrimary}: ${JSON.stringify(hoverText)}$`, "mu"),
        `  ${nonPrimary}: ${JSON.stringify(bodyText)}`,
      ),
    );

    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stdout || checked.stderr);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    const exceptionDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.ruleId === "exceptions",
    );
    assert.ok(
      exceptionDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.orphaned",
      ),
      checked.stderr || checked.stdout,
    );
    assert.equal(
      exceptionDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
      false,
      checked.stderr || checked.stdout,
    );
    assert.ok(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "minimessage.tag-mismatch" &&
          (
            diagnostic.message as { readonly path?: readonly string[] }
          )?.path?.at(-1) === nonPrimary,
      ),
      checked.stderr || checked.stdout,
    );
  });

  void it("相似原文仅发复核警告，并保留否定、数字、变量和实体差别", async (t) => {
    const project = await createMessageProject(
      t,
      [
        "You cannot claim 2 plots for <v:land> today.",
        "You can claim 2 plots for <v:land> today.",
        "Nation cannot claim 2 plots for <v:land> today under this rule.",
        "Lands cannot claim 3 plots for <v:owner> today under this rule.",
      ],
      [
        "你不能占领<v:land>的2块地.",
        "你可以占领<v:land>的2块地.",
        "联邦不能占领<v:land>的2块地.",
        "城镇不能占领<v:owner>的3块地.",
      ],
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stdout || checked.stderr);
    const candidates = consistencyDiagnostics(report).filter(
      (diagnostic) =>
        diagnostic.code === "translation-consistency.similar-source-candidate",
    );

    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.equal(report.state, "ready", JSON.stringify(report));
    assert.ok(candidates.length > 0, checked.stderr || checked.stdout);
    assert.equal(
      candidates.some((diagnostic) => diagnostic.severity === "error"),
      false,
    );
    assert.equal(
      consistencyDiagnostics(report).some(
        (diagnostic) =>
          diagnostic.code === "translation-consistency.same-source",
      ),
      false,
    );
    assert.ok(
      candidates.every((diagnostic) => diagnostic.severity === "warning"),
    );
    const candidateData = JSON.stringify(candidates);
    assert.match(candidateData, /semanticEquivalence/u);
    assert.match(candidateData, /unknown/u);
    assert.match(candidateData, /cannot/u);
    assert.match(candidateData, /2/u);
    assert.match(candidateData, /3/u);
    assert.match(candidateData, /land/u);
    assert.match(candidateData, /owner/u);
    assert.match(candidateData, /Nation/u);
    assert.match(candidateData, /Lands/u);

    const negationCandidate = candidates.find((diagnostic) => {
      const actual = diagnostic.actual as {
        readonly messages?: readonly {
          readonly source?: { readonly text?: string };
        }[];
      };
      const sourceTexts =
        actual.messages?.map((message) => message.source?.text) ?? [];
      return (
        sourceTexts.includes("You can claim 2 plots for  today.") &&
        sourceTexts.includes("You cannot claim 2 plots for  today.")
      );
    });
    assert.ok(negationCandidate, candidateData);
    const configPath = join(project.directory, ".l10n/config.yml");
    const originalConfig = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${originalConfig}\nrules:\n  translation-consistency:\n    parameters:\n      minimumSimilarity: 0.8\n`,
    );
    const adjustedThreshold = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const adjustedReport = readReport(
      adjustedThreshold.stdout || adjustedThreshold.stderr,
    );
    const adjustedCandidate = consistencyDiagnostics(adjustedReport).find(
      (diagnostic) => diagnostic.objectId === negationCandidate?.objectId,
    );
    assert.ok(
      adjustedCandidate,
      `未找到对象 ${String(negationCandidate?.objectId)} 的复核候选。${adjustedThreshold.stderr || adjustedThreshold.stdout}`,
    );
    assert.notEqual(
      adjustedCandidate?.contentFingerprint,
      negationCandidate?.contentFingerprint,
      "诊断指纹应包含已配置的相似度阈值",
    );

    await writeFile(
      configPath,
      `${originalConfig}\nrules:\n  translation-consistency:\n    severity: error\n    parameters:\n      minimumSimilarity: 0.8\n`,
    );
    const errorSeverity = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const errorReport = readReport(
      errorSeverity.stdout || errorSeverity.stderr,
    );
    const configuredError = consistencyDiagnostics(errorReport).find(
      (diagnostic) => diagnostic.objectId === negationCandidate?.objectId,
    );
    assert.equal(configuredError?.severity, "error");

    await writeFile(
      configPath,
      `${originalConfig}\nrules:\n  translation-consistency:\n    enabled: false\n`,
    );
    const disabledCheck = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const disabledReport = readReport(
      disabledCheck.stdout || disabledCheck.stderr,
    );
    assert.deepEqual(consistencyDiagnostics(disabledReport), []);
    assert.ok(
      (
        (disabledReport.coverage as Record<string, unknown>)
          .disabledRuleIds as string[]
      ).includes("translation-consistency"),
    );
  });

  void it("为常用短词构成的相似否定句提供复核候选", async (t) => {
    const project = await createMessageProject(
      t,
      [
        "You can do it.",
        "You can not do it.",
        "Open settings.",
        "Close the menu.",
      ],
      ["你可以这样做。", "你不能这样做。", "打开设置。", "关闭菜单。"],
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stdout || checked.stderr);
    const candidates = consistencyDiagnostics(report).filter(
      (diagnostic) =>
        diagnostic.code === "translation-consistency.similar-source-candidate",
    );
    const negative = candidates.find((diagnostic) => {
      const actual = diagnostic.actual as {
        readonly messages?: readonly {
          readonly source?: { readonly text?: string };
        }[];
      };
      const sources =
        actual.messages?.map((message) => message.source?.text) ?? [];
      return (
        sources.includes("You can do it.") &&
        sources.includes("You can not do it.")
      );
    });

    assert.ok(negative, checked.stderr || checked.stdout);
    assert.equal(negative.severity, "warning");
    const actual = negative.actual as {
      readonly similarity: number;
      readonly sourceDifferences: {
        readonly negations: {
          readonly left: readonly string[];
          readonly right: readonly string[];
        };
      };
      readonly semanticEquivalence: string;
    };
    assert.equal(actual.similarity, 0.8);
    assert.ok(
      [
        ...actual.sourceDifferences.negations.left,
        ...actual.sourceDifferences.negations.right,
      ].includes("not"),
    );
    assert.equal(actual.semanticEquivalence, "unknown");
  });

  void it("为三词与四词短句提供有界相似否定候选", async (t) => {
    const project = await createMessageProject(
      t,
      ["You may go.", "You may not go.", "Open settings.", "Close the menu."],
      ["你可以走。", "你不可以走。", "打开设置。", "关闭菜单。"],
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stdout || checked.stderr);
    const candidates = consistencyDiagnostics(report).filter(
      (diagnostic) =>
        diagnostic.code === "translation-consistency.similar-source-candidate",
    );
    const negative = candidates.find((diagnostic) => {
      const actual = diagnostic.actual as {
        readonly messages?: readonly {
          readonly source?: { readonly text?: string };
        }[];
      };
      const sources =
        actual.messages?.map((message) => message.source?.text) ?? [];
      return (
        sources.includes("You may go.") && sources.includes("You may not go.")
      );
    });

    assert.ok(negative, checked.stderr || checked.stdout);
    assert.equal(negative.severity, "warning");
    const actual = negative.actual as {
      readonly similarity: number;
      readonly sourceDifferences: {
        readonly negations: {
          readonly left: readonly string[];
          readonly right: readonly string[];
        };
      };
      readonly semanticEquivalence: string;
    };
    assert.equal(actual.similarity, 0.75);
    assert.ok(
      [
        ...actual.sourceDifferences.negations.left,
        ...actual.sourceDifferences.negations.right,
      ].includes("not"),
    );
    assert.equal(actual.semanticEquivalence, "unknown");
  });

  void it("不把待翻译英文种子纳入译文分歧，同时继续检查变量遗漏", async (t) => {
    const project = await createMessageProject(
      t,
      [repeatedSource, repeatedSource, repeatedSource, repeatedSource],
      [repeatedSource, "你不能认领。", "你不能认领。", "你不能认领。"],
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stdout || checked.stderr);
    assert.deepEqual(consistencyDiagnostics(report), []);
    assert.ok(
      (report.diagnostics as readonly Record<string, unknown>[]).some(
        (diagnostic) => diagnostic.code === "minimessage.variable-missing",
      ),
      checked.stderr || checked.stdout,
    );
  });

  void it("同文确认只解除待翻译原因，部分列表仍保留未处理英文项", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "Lands",
      sourceEntries: ["Lands", "Lands"],
    });
    const targetPath = join(project.directory, "lang/zh.yml");
    const initialTarget = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      initialTarget
        .replace(/^  greeting:.*$/mu, `  greeting: ${JSON.stringify("Lands")}`)
        .replace(
          /^  entries:\n(?:    - .*\n){2}/mu,
          "  entries:\n    - Lands\n    - Lands\n",
        ),
    );

    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(
      initialized.status,
      0,
      initialized.stderr || initialized.stdout,
    );

    const candidateReport = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const candidates = (
      readReport(candidateReport.stdout || candidateReport.stderr)
        .exceptionCandidates as readonly Record<string, unknown>[]
    ).filter((candidate) => candidate.ruleId === "translation-review");
    const greeting = candidates.find(
      (candidate) =>
        JSON.stringify((candidate.message as Record<string, unknown>).path) ===
        JSON.stringify(["messages", "greeting"]),
    );
    assert.ok(greeting, candidateReport.stderr || candidateReport.stdout);
    if (greeting === undefined) throw new Error("缺少同文待确认消息");

    const confirmed = runCli(
      "exempt",
      "--project",
      project.directory,
      "--id",
      String(greeting.id),
      "--reason",
      "品牌名在此处保留英文",
      "--output-format",
      "structured",
    );
    assert.equal(confirmed.status, 0, confirmed.stderr || confirmed.stdout);

    const currentTarget = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      currentTarget.replace(
        /^  entries:\n    - Lands\n    - Lands$/mu,
        "  entries:\n    - Lands\n    - 兰德斯",
      ),
    );

    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stdout || checked.stderr);
    const sameSource = consistencyDiagnostics(report).filter(
      (diagnostic) => diagnostic.code === "translation-consistency.same-source",
    );
    assert.equal(sameSource.length, 1, checked.stderr || checked.stdout);
    const finding = sameSource[0];
    assert.ok(finding);
    const sameSourceParticipants = (
      finding.actual as {
        readonly variants: readonly {
          readonly messages: readonly {
            readonly source: {
              readonly path: readonly (string | number)[];
              readonly text: string;
            };
            readonly target: { readonly text: string };
          }[];
        }[];
      }
    ).variants.flatMap((variant) => variant.messages);
    assert.ok(
      sameSourceParticipants.some(
        ({ source }) =>
          JSON.stringify(source.path) ===
          JSON.stringify(["messages", "greeting"]),
      ),
    );
    assert.deepEqual(
      sameSourceParticipants
        .filter(({ source }) => source.path[0] === "list")
        .map(({ source }) => source.path),
      [["list", "entries", 1]],
      "仍为英文的列表项应继续作为待翻译种子排除",
    );
    assert.ok(
      sameSourceParticipants.some(({ target }) => target.text === "兰德斯"),
    );

    const observeTranslationReview: CheckRule = {
      id: "translation-review-observer",
      defaultSeverity: "info",
      requiredInputs: ["minimessage-parse"],
      evaluate(view) {
        return [
          {
            code: "observe",
            identity: { state: "translation-review" },
            location: { file: "lang/zh.yml", path: [] },
            reason: "测试从正式检查视图读取待翻译状态",
            expected: { state: "observed" },
            actual: {
              messages: view.messages.map((message) => ({
                path: message.path,
                translationReview: message.translationReview ?? null,
              })),
            },
          },
        ];
      },
    };
    const observed = await inspectProject(project.directory, "check", [
      observeTranslationReview,
    ]);
    const observation = observed.diagnostics.find(
      (diagnostic) => diagnostic.ruleId === "translation-review-observer",
    );
    assert.ok(observation);
    const messages = (
      observation.actual as {
        readonly messages: readonly {
          readonly path: readonly string[];
          readonly translationReview: {
            readonly pendingReason?: string;
            readonly confirmedSameText: boolean;
          } | null;
        }[];
      }
    ).messages;
    const greetingState = messages.find(
      (message) => JSON.stringify(message.path) === '["messages","greeting"]',
    )?.translationReview;
    const entriesState = messages.find(
      (message) => JSON.stringify(message.path) === '["list","entries"]',
    )?.translationReview;
    assert.deepEqual(greetingState, {
      pendingReason: "same-text-candidate",
      confirmedSameText: true,
    });
    assert.deepEqual(entriesState, {
      pendingReason: "same-text-candidate",
      confirmedSameText: false,
    });
  });

  void it("按共享 HTML 上下文分开比较属性与正文", async (t) => {
    const project = await createFormatProject(t, {
      mapDescription: '<div title="Nation">Owner</div>',
      targetMapDescription: '<div title="国家">业主</div>',
      mapSpawn: "NationOwner",
      targetMapSpawn: "土地所有者",
    });
    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stdout || checked.stderr);
    assert.deepEqual(consistencyDiagnostics(report), []);
  });

  void it("分开相邻 HTML 属性表面，同时合并正文中的纯样式短语", async (t) => {
    const project = await createFormatProject(t, {
      mapDescription:
        '<div><span title="First"></span><span title="Second"></span><red>First</red>Second</div>',
      targetMapDescription:
        '<div><span title="第一项"></span><span title="第二项"></span><red>一</red>二</div>',
      mapSpawn:
        '<div><span title="FirstSecond"></span><red>First</red>Second</div>',
      targetMapSpawn:
        '<div><span title="复合标题"></span><red>合</red>并</div>',
    });
    const initialized = runCli(
      "init",
      "--project",
      project.directory,
      "--jar",
      project.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(
      initialized.status,
      0,
      initialized.stderr || initialized.stdout,
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stdout || checked.stderr);
    const sameSource = consistencyDiagnostics(report).filter(
      (diagnostic) => diagnostic.code === "translation-consistency.same-source",
    );

    assert.equal(sameSource.length, 1, checked.stderr || checked.stdout);
    const bodyFinding = sameSource[0];
    assert.ok(bodyFinding);
    assert.equal(
      (bodyFinding.expected as { readonly sourceText?: string }).sourceText,
      "FirstSecond",
    );
    const participants = JSON.stringify(bodyFinding.actual);
    assert.match(participants, /"role":"body"/u);
    assert.doesNotMatch(participants, /HTML 属性/u);
    assert.match(participants, /description/u);
    assert.match(participants, /spawn/u);

    const differentOrdinal = await createFormatProject(t, {
      mapDescription:
        '<div><span title="Second"></span><span title="First"></span></div>',
      targetMapDescription:
        '<div><span title="第二项"></span><span title="第一项"></span></div>',
      mapSpawn: '<div><span title="First"></span></div>',
      targetMapSpawn: '<div><span title="首项"></span></div>',
    });
    const secondInitialized = runCli(
      "init",
      "--project",
      differentOrdinal.directory,
      "--jar",
      differentOrdinal.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(
      secondInitialized.status,
      0,
      secondInitialized.stderr || secondInitialized.stdout,
    );
    const secondCheck = runCli(
      "check",
      "--project",
      differentOrdinal.directory,
      "--output-format",
      "structured",
    );
    const secondReport = readReport(secondCheck.stdout || secondCheck.stderr);
    const secondSameSource = consistencyDiagnostics(secondReport).filter(
      (diagnostic) => diagnostic.code === "translation-consistency.same-source",
    );
    assert.equal(
      secondSameSource.length,
      1,
      secondCheck.stderr || secondCheck.stdout,
    );
    const ordinalFinding = secondSameSource[0];
    assert.ok(ordinalFinding);
    assert.equal(
      (ordinalFinding.expected as { readonly sourceText?: string }).sourceText,
      "First",
    );
  });

  void it("分开比较正文与悬浮文本", async (t) => {
    const project = await createMessageProject(
      t,
      ["Claim", "<hover:show_text:'Owner'>Details</hover>", "Owner", "Owner"],
      ["认领", "<hover:show_text:'主人'>详情</hover>", "所有者", "主人"],
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stdout || checked.stderr);
    const sameSource = consistencyDiagnostics(report).filter(
      (diagnostic) => diagnostic.code === "translation-consistency.same-source",
    );

    assert.equal(checked.status, 1, checked.stderr || checked.stdout);
    assert.equal(sameSource.length, 1, checked.stderr || checked.stdout);
    const actual = sameSource[0]?.actual as {
      readonly variants?: readonly {
        readonly text: string;
        readonly messages: readonly {
          readonly source?: {
            readonly text?: string;
            readonly context?: unknown;
          };
          readonly target?: { readonly text?: string };
        }[];
      }[];
    };
    assert.deepEqual(
      actual.variants?.flatMap((variant) =>
        variant.messages.map((message) => ({
          source: message.source?.text,
          target: message.target?.text,
        })),
      ),
      [
        { source: "Owner", target: "主人" },
        { source: "Owner", target: "所有者" },
      ],
    );
  });

  void it("规则启用时报告解析输入不可用，全部禁用时不强制启动 Java", async (t) => {
    const enabledProject = await createMessageProject(
      t,
      [repeatedSource, repeatedSource, repeatedSource, repeatedSource],
      [
        "你不能认领<v:land>。",
        "你不能认领<v:land>。",
        "无法认领<v:land>。",
        "不可认领<v:land>。",
      ],
    );
    const enabledCheck = runCliWithoutJava(
      "check",
      "--project",
      enabledProject.directory,
      "--output-format",
      "structured",
    );
    const enabledReport = readReport(
      enabledCheck.stdout || enabledCheck.stderr,
    );
    const enabledCoverage = enabledReport.coverage as Record<string, unknown>;
    assert.equal(enabledCoverage.complete, false);
    assert.ok(
      (enabledCoverage.enabledRuleIds as string[]).includes(
        "translation-consistency",
      ),
    );
    assert.match(
      (enabledCoverage.unavailableCapabilities as string[]).join(" "),
      /Java|MiniMessage|辅助程序/u,
    );
    assert.deepEqual(consistencyDiagnostics(enabledReport), []);

    const disabledProject = await createMessageProject(
      t,
      [repeatedSource, repeatedSource, repeatedSource, repeatedSource],
      [
        "你不能认领<v:land>。",
        "你不能认领<v:land>。",
        "无法认领<v:land>。",
        "不可认领<v:land>。",
      ],
    );
    const configPath = join(disabledProject.directory, ".l10n/config.yml");
    const configuration = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${configuration}\nrules:\n  legacy-variable:\n    enabled: false\n  map-html:\n    enabled: false\n  map-html-source-limits:\n    enabled: false\n  minimessage-syntax:\n    enabled: false\n  minimessage-tags:\n    enabled: false\n  minimessage-variables:\n    enabled: false\n  terminology:\n    enabled: false\n  translation-style:\n    enabled: false\n  translation-consistency:\n    enabled: false\n`,
    );
    const disabledCheck = runCliWithoutJava(
      "check",
      "--project",
      disabledProject.directory,
      "--output-format",
      "structured",
    );
    const disabledReport = readReport(
      disabledCheck.stdout || disabledCheck.stderr,
    );
    const disabledCoverage = disabledReport.coverage as Record<string, unknown>;
    assert.ok(
      (disabledCoverage.disabledRuleIds as string[]).includes(
        "translation-consistency",
      ),
    );
    const disabledInputLimitations = (
      disabledCoverage.unavailableCapabilities as string[]
    ).filter((entry) => /Java|MiniMessage 辅助程序/u.test(entry));
    assert.deepEqual(disabledInputLimitations, []);
    assert.deepEqual(consistencyDiagnostics(disabledReport), []);
  });
});
