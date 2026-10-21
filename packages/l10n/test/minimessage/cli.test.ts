import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createProject, readReport, runCli } from "../cli-fixtures.ts";

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
      join(project.directory, ".lands-l10n/source-baseline.json"),
      join(project.directory, ".lands-l10n/sync-lock.json"),
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

    const baseline = await readFile(
      join(project.directory, ".lands-l10n/source-baseline.json"),
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

  void it("正式 CLI 接受嵌套 hover、引号参数、转义和默认宽松闭合", async (t) => {
    const project = await createProject(t, {
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
    await assert.rejects(
      readFile(join(ambiguous.directory, ".lands-l10n/source-baseline.json")),
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
