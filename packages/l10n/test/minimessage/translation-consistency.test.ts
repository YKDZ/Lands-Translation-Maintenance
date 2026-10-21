import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import { builtInRules, inspectProject } from "@lands-l10n/l10n";

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
      "--diagnostic",
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

  void it("按列表项路径配对聊天列表文档", async (t) => {
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
    assert.deepEqual(consistencyDiagnostics(partialReport), []);
    assert.ok(
      (partialReport.diagnostics as readonly Record<string, unknown>[]).some(
        (diagnostic) => diagnostic.code === "minimessage.syntax-invalid",
      ),
      partialCheck.stderr || partialCheck.stdout,
    );
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
      "--diagnostic",
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
        "你不能认领<v:land>的2块地。",
        "你可以认领<v:land>的2块地。",
        "Nation不能认领<v:land>的2块地。",
        "Lands不能认领<v:owner>的3块地。",
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

    assert.equal(checked.status, 1, checked.stderr || checked.stdout);
    assert.equal(report.state, "incomplete");
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
      `${configuration}\nrules:\n  legacy-variable:\n    enabled: false\n  map-html:\n    enabled: false\n  map-html-source-limits:\n    enabled: false\n  minimessage-syntax:\n    enabled: false\n  minimessage-tags:\n    enabled: false\n  minimessage-variables:\n    enabled: false\n  translation-consistency:\n    enabled: false\n`,
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
