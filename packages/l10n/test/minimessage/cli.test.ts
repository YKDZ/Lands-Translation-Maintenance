import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { strToU8, unzipSync, zipSync } from "fflate";

import {
  createProject,
  createGuiProject,
  readReport,
  runCli,
  runCliWithoutJava,
  snapshotProjectFiles,
} from "../cli-fixtures.ts";

void describe("MiniMessage 官方检查制品", () => {
  void it("正式检查用官方 MiniMessage 解析器定位非法译文语法", async (t) => {
    const project = await createProject(t);
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const targetBeforeCheck = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      targetBeforeCheck.replace("greeting: 你好", 'greeting: "你好 §c世界"'),
    );
    const protectedFiles = [
      targetPath,
      join(project.directory, ".l10n/upstream/source-baseline.json"),
      join(project.directory, ".l10n/lock.json"),
    ];
    const beforeCheck = await Promise.all(
      protectedFiles.map((file) => readFile(file)),
    );

    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(checked.status, 1, checked.stderr);
    const report = readReport(checked.stderr || checked.stdout);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    const syntaxIssue = diagnostics.find(
      (diagnostic) => diagnostic.code === "minimessage.syntax-invalid",
    );
    assert.ok(syntaxIssue, checked.stderr || checked.stdout);
    if (syntaxIssue === undefined) throw new Error("缺少 MiniMessage 语法诊断");
    assert.equal(syntaxIssue.ruleId, "minimessage-syntax");
    assert.equal(
      (syntaxIssue.location as Record<string, unknown>).file,
      "lang/zh.yml",
    );
    assert.deepEqual((syntaxIssue.location as Record<string, unknown>).path, [
      "messages",
      "greeting",
    ]);
    assert.match(String(syntaxIssue.reason), /译文/u);
    assert.equal(syntaxIssue.origin, "target");
    const afterCheck = await Promise.all(
      protectedFiles.map((file) => readFile(file)),
    );
    assert.deepEqual(afterCheck, beforeCheck);
  });

  void it("同一主题问题的消息内容变化会使旧诊断选择失效", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "<t:missing>Old</t>",
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

    const firstCheck = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(firstCheck.status, 1, firstCheck.stderr);
    const firstDiagnostics = readReport(firstCheck.stdout || firstCheck.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    const original = firstDiagnostics.find(
      (diagnostic) =>
        diagnostic.code === "minimessage.theme-unknown" &&
        diagnostic.origin === "source",
    );
    assert.ok(original, firstCheck.stdout || firstCheck.stderr);
    if (original === undefined) throw new Error("缺少来源主题诊断");

    const exempted = runCli(
      "exempt",
      "--project",
      project.directory,
      "--diagnostic",
      String(original.diagnosticId),
      "--reason",
      "此遗留 token 由上游运行时支持",
      "--output-format",
      "structured",
    );
    assert.equal(exempted.status, 0, exempted.stderr);
    const exceptionPath = join(project.directory, ".l10n/exceptions.yml");
    const exceptionBytes = await readFile(exceptionPath);

    const resources = unzipSync(await readFile(project.jarFile));
    resources["lang/en.yml"] = strToU8(
      [
        "messages:",
        '  greeting: "<t:missing>New</t>"',
        "  welcome: Welcome",
        "  commands:",
        "    registered: Run",
        "list:",
        "  entries: [first, second]",
        "",
      ].join("\n"),
    );
    const candidateJar = join(project.directory, "candidate.jar");
    await writeFile(candidateJar, zipSync(resources));
    const synced = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      candidateJar,
      "--output-format",
      "structured",
    );
    assert.equal(synced.status, 0, synced.stderr);

    const changedCheck = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(changedCheck.status, 1, changedCheck.stderr);
    const changedDiagnostics = readReport(
      changedCheck.stdout || changedCheck.stderr,
    ).diagnostics as readonly Record<string, unknown>[];
    const current = changedDiagnostics.find(
      (diagnostic) =>
        diagnostic.code === "minimessage.theme-unknown" &&
        diagnostic.origin === "source",
    );
    assert.ok(current);
    if (current === undefined) throw new Error("缺少变更后的来源主题诊断");
    assert.notEqual(current.diagnosticId, original.diagnosticId);
    assert.deepEqual(current.expected, original.expected);
    assert.deepEqual(current.actual, original.actual);
    assert.equal(
      changedDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.review-required",
      ),
      true,
    );

    const staleSelection = runCli(
      "exempt",
      "--project",
      project.directory,
      "--diagnostic",
      String(original.diagnosticId),
      "--reason",
      "不得使用消息内容变更前的诊断",
      "--output-format",
      "structured",
    );
    assert.equal(staleSelection.status, 1);
    assert.deepEqual(await readFile(exceptionPath), exceptionBytes);
  });

  void it("主题 token 其他界面的同名定义不使聊天诊断豁免失效", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "<t:missing>Old</t>",
      theme: [
        "theme:",
        "  tokens:",
        '    common: "<gray>"',
        "  gui:",
        '    missing: "<green>"',
        "",
      ].join("\n"),
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
    assert.equal(checked.status, 1, checked.stderr);
    const diagnostics = readReport(checked.stdout || checked.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    const selected = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "minimessage.theme-unknown" &&
        diagnostic.origin === "source",
    );
    assert.ok(selected, JSON.stringify(diagnostics));
    if (selected === undefined) throw new Error("缺少聊天主题 token 诊断");
    const exceptionPath = join(project.directory, ".l10n/exceptions.yml");

    const unavailableSelection = runCliWithoutJava(
      "exempt",
      "--project",
      project.directory,
      "--diagnostic",
      String(selected.diagnosticId),
      "--reason",
      "解析器不可用时不能确认旧诊断",
      "--output-format",
      "structured",
    );
    assert.equal(unavailableSelection.status, 1);
    await assert.rejects(readFile(exceptionPath), { code: "ENOENT" });

    const exempted = runCli(
      "exempt",
      "--project",
      project.directory,
      "--diagnostic",
      String(selected.diagnosticId),
      "--reason",
      "聊天主题范围内没有此 token 定义",
      "--output-format",
      "structured",
    );
    assert.equal(exempted.status, 0, exempted.stderr);
    const exceptionBytes = await readFile(exceptionPath);

    for (const operation of ["status", "check"] as const) {
      const unavailable = runCliWithoutJava(
        operation,
        "--project",
        project.directory,
        "--output-format",
        "structured",
      );
      const unavailableDiagnostics = readReport(
        unavailable.stdout || unavailable.stderr,
      ).diagnostics as readonly Record<string, unknown>[];
      assert.equal(
        unavailableDiagnostics.some(
          (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
        ),
        true,
        operation,
      );
      assert.equal(
        unavailableDiagnostics.some(
          (diagnostic) => diagnostic.code === "exception.orphaned",
        ),
        false,
        operation,
      );
      assert.deepEqual(await readFile(exceptionPath), exceptionBytes);
    }

    const resources = unzipSync(await readFile(project.jarFile));
    resources["Locale/theme.yml"] = strToU8(
      [
        "theme:",
        "  tokens:",
        '    common: "<gray>"',
        "  gui:",
        '    missing: "<blue>"',
        "",
      ].join("\n"),
    );
    const changedJar = join(project.directory, "changed-theme.jar");
    await writeFile(changedJar, zipSync(resources));
    const synced = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      changedJar,
      "--output-format",
      "structured",
    );
    assert.equal(synced.status, 0, synced.stderr);

    const after = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(after.status, 1, after.stderr);
    const afterDiagnostics = readReport(after.stdout || after.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      afterDiagnostics.some(
        (diagnostic) =>
          diagnostic.code === "minimessage.theme-unknown" &&
          diagnostic.origin === "source",
      ),
      false,
      JSON.stringify(afterDiagnostics),
    );
    assert.equal(
      afterDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.review-required",
      ),
      false,
      JSON.stringify(afterDiagnostics),
    );
    assert.deepEqual(await readFile(exceptionPath), exceptionBytes);
  });

  void it("Java 解析器不可用时仍可独立确认同文并报告质量检查未完成", async (t) => {
    const project = await createProject(t);
    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target
        .replace("greeting: 你好", "greeting: Hello")
        .replace("  welcome: Welcome\n", ""),
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
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(
      targetPath,
      (await readFile(targetPath, "utf8")).replace("  welcome: Welcome\n", ""),
    );

    const before = runCliWithoutJava(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const candidates = readReport(before.stdout || before.stderr)
      .sameTextToConfirm as readonly Record<string, unknown>[];
    const greeting = candidates.find(
      (candidate) =>
        JSON.stringify((candidate.message as Record<string, unknown>).path) ===
        '["messages","greeting"]',
    );
    assert.ok(greeting);
    if (greeting === undefined) throw new Error("缺少同文候选");
    const candidateId = String(greeting.candidateId);

    const confirmed = runCliWithoutJava(
      "confirm-same-text",
      "--project",
      project.directory,
      "--candidate",
      candidateId,
      "--reason",
      "此名称按品牌规范保留英文",
      "--output-format",
      "structured",
    );
    assert.equal(confirmed.status, 0, confirmed.stderr);
    const confirmationEnvelope = JSON.parse(confirmed.stdout) as {
      readonly data: {
        readonly confirmation: Readonly<Record<string, unknown>>;
      };
    };
    assert.equal(confirmationEnvelope.data.confirmation.kind, "same-text");
    assert.equal(
      confirmationEnvelope.data.confirmation.candidateId,
      candidateId,
    );
    assert.equal(
      confirmationEnvelope.data.confirmation.reason,
      "此名称按品牌规范保留英文",
    );
    const exceptionPath = join(project.directory, ".l10n/exceptions.yml");
    const exceptionBytes = await readFile(exceptionPath);

    for (const [operation, args] of [
      ["status", ["status"]],
      ["check", ["check"]],
    ] as const) {
      const unavailable = runCliWithoutJava(
        ...args,
        "--project",
        project.directory,
        "--output-format",
        "structured",
      );
      assert.equal(unavailable.status, 1, unavailable.stderr);
      const report = readReport(unavailable.stdout || unavailable.stderr);
      const summary = report.summary as Record<string, unknown>;
      assert.equal(summary.confirmedSameText, 1, operation);
      const diagnostics = report.diagnostics as readonly Record<
        string,
        unknown
      >[];
      assert.equal(
        diagnostics.some(
          (diagnostic) => diagnostic.code === "same-text.unable-to-evaluate",
        ),
        false,
        operation,
      );
      assert.equal(
        diagnostics.some((diagnostic) => diagnostic.code === "message.missing"),
        true,
        operation,
      );
      if (operation === "check") {
        assert.equal(
          (report.coverage as Record<string, unknown>).complete,
          false,
        );
      }
      assert.deepEqual(await readFile(exceptionPath), exceptionBytes);
    }
    assert.deepEqual(await readFile(exceptionPath), exceptionBytes);
  });

  void it("同一消息同一规则的两个问题可以只豁免一个", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "<t:missing>A</t> <t:missing>B</t>",
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

    const before = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(before.status, 1, before.stderr);
    const beforeDiagnostics = readReport(before.stdout || before.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    const issues = beforeDiagnostics.filter(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-syntax" &&
        diagnostic.code === "minimessage.theme-unknown" &&
        diagnostic.origin === "source",
    );
    assert.equal(issues.length, 2, JSON.stringify(beforeDiagnostics));
    assert.equal(
      (issues[0]?.message as Record<string, unknown> | undefined)?.id,
      (issues[1]?.message as Record<string, unknown> | undefined)?.id,
    );
    assert.notEqual(issues[0]?.diagnosticId, issues[1]?.diagnosticId);
    const selected = issues.find(
      (diagnostic) =>
        (diagnostic.actual as Record<string, unknown>).position === 17,
    );
    const neighbor = issues.find(
      (diagnostic) =>
        (diagnostic.actual as Record<string, unknown>).position === 0,
    );
    if (selected === undefined || neighbor === undefined)
      throw new Error(
        `缺少相邻的两个同规则诊断：${JSON.stringify(issues.map((issue) => issue.actual))}`,
      );

    const exempted = runCli(
      "exempt",
      "--project",
      project.directory,
      "--diagnostic",
      String(selected.diagnosticId),
      "--reason",
      "只接受第一处已知主题 token",
      "--output-format",
      "structured",
    );
    assert.equal(exempted.status, 0, exempted.stderr);

    const after = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(after.status, 1, after.stderr);
    const afterDiagnostics = readReport(after.stdout || after.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    const remaining = afterDiagnostics.filter(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-syntax" &&
        diagnostic.code === "minimessage.theme-unknown" &&
        diagnostic.origin === "source",
    );
    assert.deepEqual(
      remaining.map((diagnostic) => diagnostic.diagnosticId),
      [neighbor.diagnosticId],
    );

    const updatedSource = [
      "messages:",
      '  greeting: "<t:missing>A</t>"',
      "  welcome: Welcome",
      "  commands:",
      "    registered: Run",
      "list:",
      "  entries: [first, second]",
      "",
    ].join("\n");
    const updatedJar = join(project.directory, "updated.jar");
    await writeFile(
      updatedJar,
      zipSync({
        ...unzipSync(await readFile(project.jarFile)),
        "lang/en.yml": strToU8(updatedSource),
      }),
    );
    const synced = runCli(
      "sync",
      "--project",
      project.directory,
      "--jar",
      updatedJar,
      "--output-format",
      "structured",
    );
    assert.equal(synced.status, 0, synced.stderr);

    const afterSelectedIssueDisappears = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(afterSelectedIssueDisappears.status, 1);
    const afterRemovalDiagnostics = readReport(
      afterSelectedIssueDisappears.stdout ||
        afterSelectedIssueDisappears.stderr,
    ).diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      afterRemovalDiagnostics.filter(
        (diagnostic) =>
          diagnostic.ruleId === "minimessage-syntax" &&
          diagnostic.code === "minimessage.theme-unknown" &&
          diagnostic.origin === "source",
      ).length,
      1,
    );
    assert.equal(
      afterRemovalDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.orphaned",
      ),
      true,
      JSON.stringify(afterRemovalDiagnostics),
    );
    assert.equal(
      afterRemovalDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.review-required",
      ),
      false,
      JSON.stringify(afterRemovalDiagnostics),
    );
  });

  void it("确认同文不会抑制同一消息的 MiniMessage 质量诊断", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "Hello §cWorld",
    });
    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace("greeting: 你好", 'greeting: "Hello §cWorld"'),
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
    assert.equal(initialized.status, 0, initialized.stderr);

    const status = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const candidates = readReport(status.stdout || status.stderr)
      .sameTextToConfirm as readonly Record<string, unknown>[];
    const greeting = candidates.find(
      (candidate) =>
        JSON.stringify((candidate.message as Record<string, unknown>).path) ===
        '["messages","greeting"]',
    );
    assert.ok(greeting);
    if (greeting === undefined) throw new Error("缺少同文候选");

    const confirmed = runCli(
      "confirm-same-text",
      "--project",
      project.directory,
      "--candidate",
      String(greeting.candidateId),
      "--reason",
      "测试对象的原文和译文虽相同，仍需保留语法诊断",
      "--output-format",
      "structured",
    );
    assert.equal(confirmed.status, 0, confirmed.stderr);

    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(checked.status, 1, checked.stderr);
    const report = readReport(checked.stdout || checked.stderr);
    const summary = report.summary as Record<string, unknown>;
    assert.equal(summary.confirmedSameText, 1);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.equal(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "minimessage.syntax-invalid" &&
          JSON.stringify(
            (diagnostic.message as Record<string, unknown> | undefined)?.path,
          ) === '["messages","greeting"]',
      ),
      true,
      JSON.stringify(report),
    );
  });

  void it("未支持的 Lands 扩展会定位原文并显示覆盖限制", async (t) => {
    const project = await createProject(t, {
      sourceGreeting:
        "<verbose>需要日志权限</verbose> <future>未知扩展</future>",
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

    const structured = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(structured.status, 1, structured.stderr);
    const report = readReport(structured.stdout || structured.stderr);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    const extension = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "minimessage.extension-unsupported" &&
        diagnostic.origin === "source",
    );
    assert.ok(extension, structured.stderr || structured.stdout);
    const unknownTag = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "minimessage.tag-unknown" &&
        diagnostic.origin === "source",
    );
    assert.ok(unknownTag, structured.stderr || structured.stdout);
    assert.match(JSON.stringify(unknownTag.actual), /<future>/u);
    assert.equal(
      typeof (unknownTag.actual as Record<string, unknown>).position,
      "number",
    );
    assert.deepEqual(unknownTag.location, {
      file: "lang/en.yml",
      path: ["messages", "greeting"],
    });
    const coverage = report.coverage as Record<string, unknown>;
    assert.equal(coverage.complete, false);
    assert.match(
      JSON.stringify(coverage.unavailableCapabilities),
      /Lands 控制/u,
    );

    const text = runCli("check", "--project", project.directory);
    assert.equal(text.status, 1, text.stderr);
    assert.match(text.stdout || text.stderr, /来源：原文/u);
    assert.match(text.stdout || text.stderr, /检查覆盖不完整/u);
  });

  void it("按主题基线解析 token，并区分非法主题定义与未定义引用", async (t) => {
    const project = await createProject(t, {
      theme: 'theme:\n  tokens:\n    regular: "<gray>"\n',
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

    const baseline = await readFile(
      join(project.directory, ".l10n/upstream/source-baseline.json"),
      "utf8",
    );
    assert.match(baseline, /Locale\/theme\.yml/u);
    assert.match(baseline, /<gray>/u);

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace("greeting: 你好", 'greeting: "<t:missing>你好</t>"'),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(checked.status, 1, checked.stderr);
    const report = readReport(checked.stderr || checked.stdout);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    const unknownTheme = diagnostics.find(
      (diagnostic) => diagnostic.code === "minimessage.theme-unknown",
    );
    assert.ok(unknownTheme, checked.stderr || checked.stdout);
    assert.equal(unknownTheme?.origin, "target");
    assert.match(String(unknownTheme?.reason), /missing/u);
    assert.equal(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "minimessage.theme-reference-invalid" &&
          diagnostic.origin === "target",
      ),
      false,
    );
  });

  void it("按 Lands 主题语义规范化 token 名并保留空样式", async (t) => {
    const cases = [
      {
        theme: "theme:\n  tokens:\n    regular:\n",
        sourceGreeting: "<t:regular>正文</t>",
      },
      {
        theme: 'theme:\n  tokens:\n    regular: ""\n',
        sourceGreeting: "<t:regular>正文</t>",
      },
      {
        theme: 'theme:\n  tokens:\n    Regular: "<red>"\n',
        sourceGreeting: "<t:regular>正文</t>",
      },
    ];

    for (const { theme, sourceGreeting } of cases) {
      const project = await createProject(t, { theme, sourceGreeting });
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
      const diagnostics = report.diagnostics as readonly Record<
        string,
        unknown
      >[];
      assert.deepEqual(
        diagnostics.filter((diagnostic) =>
          String(diagnostic.code).startsWith("minimessage.theme-"),
        ),
        [],
      );
    }
  });

  void it("正式 CLI 接受嵌套 hover、引号参数、转义和默认宽松闭合", async (t) => {
    const project = await createProject(t, {
      theme: 'theme:\n  tokens:\n    regular: "<gray>"\n',
      sourceGreeting:
        "<hover:show_text:'<t:regular>提示</t>'><red>正文 \\<字面></red></hover> <red>未显式闭合",
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
    assert.equal(checked.status, 1, checked.stderr);
    const report = readReport(checked.stderr || checked.stdout);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.deepEqual(
      diagnostics.filter((diagnostic) =>
        String(diagnostic.code).startsWith("minimessage."),
      ),
      [],
    );
  });

  void it("GUI lore 列表走整体 MiniMessage 输入与 GUI 主题", async (t) => {
    const project = await createGuiProject(t, {
      name: "<t:gui_only>工具</t>",
      lore: ["<t:gui_only>第一行</t>", "<t:missing>第二行</t>", "&c旧颜色码"],
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
    assert.equal(checked.status, 1, checked.stderr);
    const report = readReport(checked.stdout || checked.stderr);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    const sourceThemeIssues = diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === "minimessage.theme-unknown" &&
        diagnostic.origin === "source",
    );
    assert.equal(sourceThemeIssues.length, 1);
    const [missingToken] = sourceThemeIssues;
    assert.ok(missingToken);
    assert.deepEqual(missingToken.location, {
      file: "Locale/en-US_gui.yml",
      path: ["physical", "selection", "lore"],
    });
    assert.match(JSON.stringify(missingToken.actual), /missing/u);
    const loreIdentity = missingToken.message as Record<string, unknown>;
    assert.equal(loreIdentity.sourceFile, "Locale/en-US_gui.yml");
    assert.equal(loreIdentity.targetFile, "Locale/zh-CN_gui.yml");
    assert.deepEqual(loreIdentity.path, ["physical", "selection", "lore"]);
    assert.equal(loreIdentity.category, "gui-lore");
    assert.equal(loreIdentity.scene, "gui-item-lore");
    assert.equal(loreIdentity.format, "legacy-color-minimessage");
    const coverage = report.coverage as Record<string, unknown>;
    assert.ok(
      (coverage.unavailableCapabilities as string[]).some((capability) =>
        capability.includes("旧颜色码"),
      ),
    );
  });

  void it("按场景把对话框物品和混合配置字符串交给 GUI 主题", async (t) => {
    const project = await createGuiProject(t, {
      name: "<t:gui_only>工具</t>",
      lore: ["<t:gui_only>说明</t>"],
      dialogItemName: "<t:gui_only>对话框物品</t> <t:dialog_missing>未知项</t>",
      categoryName: "<t:gui_only>分类</t> <t:category_missing>未知项</t>",
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
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    const sourceThemeIssues = diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === "minimessage.theme-unknown" &&
        diagnostic.origin === "source",
    );
    assert.equal(sourceThemeIssues.length, 2);

    const dialogIssue = sourceThemeIssues.find(
      ({ location }) =>
        JSON.stringify((location as Record<string, unknown>).path) ===
        '["dialogs","confirmation","bodies","icon","item","name"]',
    );
    assert.ok(dialogIssue);
    assert.match(JSON.stringify(dialogIssue.actual), /dialog_missing/u);
    const dialogIdentity = dialogIssue.message as Record<string, unknown>;
    assert.equal(dialogIdentity.scene, "gui-item-name");
    assert.equal(dialogIdentity.format, "legacy-color-minimessage");

    const categoryIssue = sourceThemeIssues.find(
      ({ location }) =>
        JSON.stringify((location as Record<string, unknown>).path) ===
        '["land","categories","peaceful","name"]',
    );
    assert.ok(categoryIssue);
    assert.match(JSON.stringify(categoryIssue.actual), /category_missing/u);
    const categoryIdentity = categoryIssue.message as Record<string, unknown>;
    assert.equal(categoryIdentity.scene, "category-name");
    assert.equal(categoryIdentity.format, "legacy-color-minimessage");
  });

  void it("为每个重复主题 token 保留各自的原文位置", async (t) => {
    const source = "<t:missing>A</t> and <t:missing>B</t>";
    const project = await createProject(t, { sourceGreeting: source });
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
    const occurrences = (
      report.diagnostics as readonly Record<string, unknown>[]
    ).filter(
      (diagnostic) =>
        diagnostic.code === "minimessage.theme-unknown" &&
        diagnostic.origin === "source",
    );
    assert.equal(occurrences.length, 2);
    const positions = occurrences
      .map((diagnostic) =>
        Number((diagnostic.actual as Record<string, unknown>).position),
      )
      .sort((left, right) => left - right);
    assert.deepEqual(positions, [
      source.indexOf("<t:missing>"),
      source.lastIndexOf("<t:missing>"),
    ]);
    assert.equal(
      new Set(occurrences.map((diagnostic) => diagnostic.diagnosticId)).size,
      2,
    );
  });

  void it("保留嵌套和正文中同名未知标签的解析文档及位置", async (t) => {
    const source =
      "<hover:show_text:'<future:nested>n</future>'>X</hover> <future:body>b</future>";
    const project = await createProject(t, { sourceGreeting: source });
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
    const occurrences = (
      report.diagnostics as readonly Record<string, unknown>[]
    ).filter(
      (diagnostic) =>
        diagnostic.code === "minimessage.tag-unknown" &&
        diagnostic.origin === "source",
    );
    assert.equal(occurrences.length, 4);
    const expectedPositions = [
      source.indexOf("<future:nested>"),
      source.indexOf("</future>"),
      source.indexOf("<future:body>"),
      source.lastIndexOf("</future>"),
    ].sort((left, right) => left - right);
    assert.deepEqual(
      occurrences
        .map((diagnostic) =>
          Number((diagnostic.actual as Record<string, unknown>).position),
        )
        .sort((left, right) => left - right),
      expectedPositions,
    );
    assert.equal(
      new Set(occurrences.map((diagnostic) => diagnostic.diagnosticId)).size,
      4,
    );
    const nested = occurrences.filter((diagnostic) => {
      const actual = diagnostic.actual as Record<string, unknown>;
      return Number(actual.position) < source.indexOf(">X</hover>");
    });
    assert.equal(nested.length, 2);
    assert.ok(
      nested.every(
        (diagnostic) =>
          Number((diagnostic.actual as Record<string, unknown>).documentIndex) >
          0,
      ),
    );
  });

  void it("让官方宽松解析器处理 hover 参数引号与转义", async (t) => {
    const cases = [
      "<hover:show_text:tip>X</hover>",
      "<hover:'show_text':'<v:x>tip'>X</hover>",
      "<hover:show_text:'unclosed>X",
      "<hover:show_text:'<click:run_command:\\'/x <v:x>\\'>tip</click>'>X</hover>",
    ];
    for (const sourceGreeting of cases) {
      const project = await createProject(t, { sourceGreeting });
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
      const miniMessageDiagnostics = (
        report.diagnostics as readonly Record<string, unknown>[]
      ).filter((diagnostic) =>
        String(diagnostic.code).startsWith("minimessage."),
      );
      assert.deepEqual(miniMessageDiagnostics, [], sourceGreeting);
      assert.equal(
        JSON.stringify(report.coverage).includes("偏移无法可靠映射"),
        false,
        sourceGreeting,
      );
    }
  });

  void it("定位官方未解析的 hover 参数且不伪造 hover 上下文", async (t) => {
    const cases = [
      "<hover:bogus:tip>X</hover>",
      "<hover:show_text>X</hover>",
      "<hover:bogus:tip><future:inner>正文</future></hover>",
    ];

    for (const sourceGreeting of cases) {
      const project = await createProject(t, { sourceGreeting });
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

      const targetPath = join(project.directory, "lang/zh.yml");
      const target = await readFile(targetPath, "utf8");
      await writeFile(
        targetPath,
        target.replace(
          "greeting: 你好",
          `greeting: ${JSON.stringify(sourceGreeting)}`,
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
      const unresolved = diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === "minimessage.tag-unresolved" &&
          (diagnostic.actual as Record<string, unknown>).tag ===
            sourceGreeting.slice(0, sourceGreeting.indexOf(">") + 1),
      );
      assert.equal(unresolved.length, 2, JSON.stringify(diagnostics, null, 2));
      assert.deepEqual(
        unresolved
          .map((diagnostic) => String(diagnostic.origin))
          .sort((left, right) => left.localeCompare(right)),
        ["source", "target"],
      );
      assert.deepEqual(
        unresolved
          .map((diagnostic) =>
            Number((diagnostic.actual as Record<string, unknown>).position),
          )
          .sort((left, right) => left - right),
        [0, 0],
      );
      assert.ok(
        unresolved.every((diagnostic) => {
          const actual = diagnostic.actual as Record<string, unknown>;
          return !(actual.context as readonly unknown[]).some(
            (frame) => Array.isArray(frame) && frame[0] === "hover-text",
          );
        }),
      );
      assert.equal(
        new Set(unresolved.map((diagnostic) => diagnostic.diagnosticId)).size,
        2,
      );
      assert.equal(
        diagnostics.some(
          (diagnostic) => diagnostic.code === "minimessage.syntax-invalid",
        ),
        false,
      );
      if (sourceGreeting.includes("<future:inner>")) {
        const nestedUnknown = diagnostics.filter(
          (diagnostic) =>
            diagnostic.code === "minimessage.tag-unknown" &&
            (diagnostic.actual as Record<string, unknown>).tag ===
              "<future:inner>",
        );
        assert.equal(nestedUnknown.length, 2);
        assert.deepEqual(
          nestedUnknown
            .map((diagnostic) => String(diagnostic.origin))
            .sort((left, right) => left.localeCompare(right)),
          ["source", "target"],
        );
        assert.ok(
          nestedUnknown.every((diagnostic) => {
            const actual = diagnostic.actual as Record<string, unknown>;
            return !(actual.context as readonly unknown[]).some(
              (frame) =>
                Array.isArray(frame) &&
                (frame[0] === "hover-text" || frame[1] === "hover"),
            );
          }),
        );
      }
    }
  });

  void it("正式 CLI 接受 MiniMessage 4.26.1 官方别名与颜色写法", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "<c:red><grey><#00ff88><!bold>正文",
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
    assert.equal(checked.status, 1, checked.stderr);
    const report = readReport(checked.stderr || checked.stdout);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.deepEqual(
      diagnostics.filter((diagnostic) =>
        String(diagnostic.code).startsWith("minimessage."),
      ),
      [],
    );
  });

  void it("初始化阻断主题 YAML 歧义，完整检查报告原文与主题质量问题", async (t) => {
    const ambiguous = await createProject(t, {
      theme: 'theme:\n  tokens:\n    regular: "<gray>"\n    regular: "<red>"\n',
    });
    const beforeRejection = await snapshotProjectFiles(ambiguous.directory);
    const rejected = runCli(
      "init",
      "--project",
      ambiguous.directory,
      "--jar",
      ambiguous.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr || rejected.stdout, /主题 YAML 无法安全读取/u);
    assert.deepEqual(
      await snapshotProjectFiles(ambiguous.directory),
      beforeRejection,
    );

    const invalid = await createProject(t, {
      sourceGreeting: "Hello §cWorld",
      theme:
        "theme:\n  tokens:\n    regular: \"<click:run_command:'/test'>\"\n",
    });
    const initialized = runCli(
      "init",
      "--project",
      invalid.directory,
      "--jar",
      invalid.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(initialized.status, 0, initialized.stderr);

    const checked = runCli(
      "check",
      "--project",
      invalid.directory,
      "--output-format",
      "structured",
    );
    assert.equal(checked.status, 1, checked.stderr);
    const report = readReport(checked.stderr || checked.stdout);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    const sourceSyntax = diagnostics.find(
      (diagnostic) => diagnostic.code === "minimessage.syntax-invalid",
    );
    const invalidTheme = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "minimessage.theme-definition-invalid",
    );
    assert.ok(sourceSyntax, checked.stderr || checked.stdout);
    if (sourceSyntax === undefined) throw new Error("缺少原文语法诊断");
    assert.equal(sourceSyntax.origin, "source");
    assert.equal(
      (sourceSyntax.location as Record<string, unknown>).file,
      "lang/en.yml",
    );
    assert.ok(invalidTheme, checked.stderr || checked.stdout);
    if (invalidTheme === undefined) throw new Error("缺少主题定义诊断");
    assert.equal(invalidTheme.origin, "theme");
    assert.equal(
      (invalidTheme.location as Record<string, unknown>).file,
      "Locale/theme.yml",
    );
  });
});
