import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import { strToU8, unzipSync, zipSync } from "fflate";

import {
  createProject,
  createGuiProject,
  readReport,
  runCli,
  runCliWithoutJava,
  snapshotProjectFiles,
} from "../cli-fixtures.ts";

async function checkGreeting(
  t: TestContext,
  source: string,
  targetText: string,
  ruleConfiguration = "",
) {
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

  const targetPath = join(project.directory, "lang/zh.yml");
  const target = await readFile(targetPath, "utf8");
  await writeFile(
    targetPath,
    target.replace(
      "  greeting: 你好",
      `  greeting: ${JSON.stringify(targetText)}`,
    ),
  );
  if (ruleConfiguration !== "") {
    const configurationPath = join(project.directory, ".l10n/config.yml");
    const configuration = await readFile(configurationPath, "utf8");
    await writeFile(
      configurationPath,
      `${configuration}\n${ruleConfiguration}`,
    );
  }

  const checked = runCli(
    "check",
    "--project",
    project.directory,
    "--output-format",
    "structured",
  );
  const report = readReport(checked.stdout || checked.stderr);
  return {
    project,
    checked,
    report,
    diagnostics: report.diagnostics as readonly Record<string, unknown>[],
  };
}

void describe("MiniMessage 官方检查制品", () => {
  void it("正式检查发现正文变量遗漏，即使译文句子可正常解析", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "Hello, <v:player>!",
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace("greeting: 你好", 'greeting: "你好"'),
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
    const missing = diagnostics.find(
      (diagnostic) => diagnostic.code === "minimessage.variable-missing",
    );
    assert.ok(missing, checked.stderr || checked.stdout);
    assert.equal(missing?.origin, "target");
    assert.match(JSON.stringify(missing?.expected), /player/u);
    assert.match(JSON.stringify(missing?.actual), /0/u);
  });

  void it("同一消息的多个变量诊断可分别豁免", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "Hello, <v:player> and <v:land>!",
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
    const diagnostics = readReport(before.stdout || before.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    const issues = diagnostics.filter(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-variables" &&
        diagnostic.code === "minimessage.variable-missing",
    );
    assert.equal(issues.length, 2, before.stdout || before.stderr);
    assert.notEqual(issues[0]?.objectId, issues[1]?.objectId);
    const selectedName = JSON.stringify(issues[0]?.expected);
    const selected = issues[0];
    assert.ok(selected);
    if (selected === undefined) throw new Error("缺少变量诊断");

    const exemption = runCli(
      "exempt",
      "--project",
      project.directory,
      "--diagnostic",
      String(selected.diagnosticId),
      "--reason",
      "此变量由其他上下文提供",
      "--output-format",
      "structured",
    );
    assert.equal(exemption.status, 0, exemption.stderr);

    const after = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(after.status, 1, after.stderr);
    const remaining = readReport(after.stdout || after.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    const variableIssues = remaining.filter(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-variables" &&
        diagnostic.code === "minimessage.variable-missing",
    );
    assert.equal(variableIssues.length, 1, after.stdout || after.stderr);
    assert.equal(
      variableIssues[0]?.diagnosticId,
      issues.find((issue) => issue.diagnosticId !== selected.diagnosticId)
        ?.diagnosticId,
    );
    assert.notEqual(JSON.stringify(variableIssues[0]?.expected), selectedName);
  });

  void it("关闭语法规则时仍由启用的变量规则驱动共享解析", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "Hello <v:owner>",
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

    const configurationPath = join(project.directory, ".l10n/config.yml");
    const configuration = await readFile(configurationPath, "utf8");
    await writeFile(
      configurationPath,
      `${configuration}\nrules:\n  minimessage-syntax:\n    enabled: false\n`,
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
    const coverage = report.coverage as Record<string, unknown>;
    assert.ok(
      diagnostics.some(
        (diagnostic) => diagnostic.code === "minimessage.variable-missing",
      ),
      checked.stderr || checked.stdout,
    );
    assert.ok(
      (coverage.enabledRuleIds as string[]).includes("minimessage-variables"),
      checked.stderr || checked.stdout,
    );
    assert.ok(
      (coverage.disabledRuleIds as string[]).includes("minimessage-syntax"),
      checked.stderr || checked.stdout,
    );
  });

  void it("允许中文正文改写和变量语序调整，并忽略相似普通文本", async (t) => {
    const project = await createProject(t, {
      sourceGreeting:
        "Hello <v:player>, this is <v:land>; literal {player}, %player%, and \\<v:fake>.",
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace(
        "greeting: 你好",
        'greeting: "<v:land> 的内容由 <v:player>编写；字面 {player}、%player% 和 \\\\<v:fake>。"',
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
    assert.equal(
      diagnostics.some((diagnostic) =>
        String(diagnostic.code).startsWith("minimessage.variable-"),
      ),
      false,
      checked.stderr || checked.stdout,
    );
  });

  void it("分别报告变量错写、遗漏、新增和大小写变化", async (t) => {
    const cases = [
      {
        name: "同总量的另一个变量",
        source: "<v:player>属于<v:land>",
        target: "<v:player>属于<v:player>",
        code: "minimessage.variable-name-mismatch",
      },
      {
        name: "遗漏",
        source: "<v:player>属于<v:land>",
        target: "<v:player>属于这片土地",
        code: "minimessage.variable-missing",
      },
      {
        name: "新增或重复",
        source: "<v:player>",
        target: "<v:player> <v:player>",
        code: "minimessage.variable-added",
      },
      {
        name: "变量名大小写",
        source: "<v:Player>",
        target: "<v:player>",
        code: "minimessage.variable-name-mismatch",
      },
    ];

    for (const example of cases) {
      const project = await createProject(t, {
        sourceGreeting: example.source,
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

      const targetPath = join(project.directory, "lang/zh.yml");
      const target = await readFile(targetPath, "utf8");
      await writeFile(
        targetPath,
        target.replace(
          "greeting: 你好",
          `greeting: ${JSON.stringify(example.target)}`,
        ),
      );
      const checked = runCli(
        "check",
        "--project",
        project.directory,
        "--output-format",
        "structured",
      );
      assert.equal(checked.status, 1, `${example.name}: ${checked.stderr}`);
      const report = readReport(checked.stdout || checked.stderr);
      const diagnostics = report.diagnostics as readonly Record<
        string,
        unknown
      >[];
      assert.ok(
        diagnostics.some((diagnostic) => diagnostic.code === example.code),
        `${example.name}: ${checked.stderr || checked.stdout}`,
      );
    }
  });

  void it("为列表各项的交互位置保留独立路径", async (t) => {
    const project = await createProject(t, {
      sourceEntries: [
        '<click:run_command:"/lands claim <v:land>">Claim</click>',
        '<click:suggest_command:"/lands rename <v:player>">Rename</click>',
      ],
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    const changed = target
      .replace(
        "- 第一项",
        `- ${JSON.stringify('<click:run_command:"/lands claim <v:player>">认领</click>')}`,
      )
      .replace(
        "- 第二项",
        `- ${JSON.stringify('<click:suggest_command:"/lands rename <v:player>">改名</click>')}`,
      );
    await writeFile(targetPath, changed);

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
    const firstItemMismatch = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "minimessage.variable-name-mismatch" &&
        JSON.stringify(diagnostic.expected).includes(
          '"path":["list","entries",0]',
        ),
    );
    assert.ok(firstItemMismatch, checked.stderr || checked.stdout);
    assert.match(JSON.stringify(firstItemMismatch.expected), /land/u);
    assert.match(JSON.stringify(firstItemMismatch.actual), /player/u);
  });

  void it("保持正文、click 命令与 hover 文本的变量上下文", async (t) => {
    const project = await createProject(t, {
      sourceGreeting:
        "<v:player> <click:run_command:\"/lands claim <v:land>\">Claim <hover:show_text:'Owner <v:owner>'>details</hover></click>",
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(
          "<v:owner> <click:run_command:\"/lands claim <v:player>\">认领 <hover:show_text:'由 <v:land> 拥有'>说明</hover></click>",
        )}`,
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
    const variableDiagnostics = diagnostics.filter((diagnostic) =>
      String(diagnostic.code).startsWith("minimessage.variable-"),
    );
    assert.ok(
      variableDiagnostics.length >= 3,
      checked.stderr || checked.stdout,
    );
    assert.match(JSON.stringify(variableDiagnostics), /click-command/u);
    assert.match(JSON.stringify(variableDiagnostics), /hover-text/u);
  });

  void it("交互顺序可调整，hover 文本可译且变量仍绑定所属命令", async (t) => {
    const project = await createProject(t, {
      sourceGreeting:
        "<click:run_command:\"/lands claim <v:land>\">Claim <hover:show_text:'Owner <v:owner>'>Owner</hover></click> and <click:suggest_command:\"/lands rename <v:player>\">Rename <hover:show_text:'Name <v:name>'>Name</hover></click>",
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(
          "<click:suggest_command:\"/lands rename <v:player>\">改名 <hover:show_text:'<v:name> 的名称'>名称</hover></click>；<click:run_command:\"/lands claim <v:land>\">认领 <hover:show_text:'<v:owner> 的所有者'>所有者</hover></click>",
        )}`,
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
    assert.equal(
      diagnostics.some(
        (diagnostic) =>
          String(diagnostic.code).startsWith("minimessage.variable-") ||
          String(diagnostic.code).startsWith("minimessage.click-"),
      ),
      false,
      checked.stderr || checked.stdout,
    );
  });

  void it("同一父交互下多段 hover 完整换序时保留对象变量分布", async (t) => {
    const project = await createProject(t, {
      sourceGreeting:
        "<click:run_command:\"/lands claim <v:land>\"><hover:show_text:'<v:owner> owns it'>Owner</hover><hover:show_text:'<v:date> created it'>Date</hover></click>",
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(
          "<click:run_command:\"/lands claim <v:land>\"><hover:show_text:'<v:date> 创建'>日期</hover><hover:show_text:'<v:owner> 的土地'>所有者</hover></click>",
        )}`,
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
    assert.equal(
      diagnostics.some((diagnostic) =>
        String(diagnostic.code).startsWith("minimessage.variable-"),
      ),
      false,
      checked.stderr || checked.stdout,
    );
  });

  void it("同命令的多个 click 正文按对象分别核对变量分布", async (t) => {
    const project = await createProject(t, {
      sourceGreeting:
        '<click:run_command:"/lands info">Owner <v:owner></click> <click:run_command:"/lands info">Land <v:land></click>',
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(
          '<click:run_command:"/lands info">所有者 <v:owner> <v:land></click> <click:run_command:"/lands info">土地</click>',
        )}`,
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
    const distributionMismatch = diagnostics.find(
      (diagnostic) =>
        diagnostic.code ===
        "minimessage.variable-interaction-distribution-mismatch",
    );
    assert.ok(distributionMismatch, checked.stderr || checked.stdout);
    assert.match(JSON.stringify(distributionMismatch.expected), /owner/u);
    assert.match(JSON.stringify(distributionMismatch.actual), /land/u);
    assert.match(JSON.stringify(distributionMismatch.expected), /click-text/u);
    assert.match(JSON.stringify(distributionMismatch.actual), /positions/u);
  });

  void it("多段 hover 按内部正文与 click 上下文分别核对变量分布", async (t) => {
    const project = await createProject(t, {
      sourceGreeting:
        "<hover:show_text:'<v:owner> <click:run_command:\"/lands info\"><v:land></click>'>Owner</hover> <hover:show_text:'<v:land> <click:run_command:\"/lands info\"><v:owner></click>'>Land</hover>",
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(
          "<hover:show_text:'<v:owner> <v:land> <click:run_command:\"/lands info\"></click>'>所有者</hover> <hover:show_text:'<click:run_command:\"/lands info\"><v:owner> <v:land></click>'>土地</hover>",
        )}`,
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
    const distributionMismatch = diagnostics.find(
      (diagnostic) =>
        diagnostic.code ===
        "minimessage.variable-interaction-distribution-mismatch",
    );
    assert.ok(distributionMismatch, checked.stderr || checked.stdout);
    assert.match(JSON.stringify(distributionMismatch.expected), /hover-text/u);
    assert.match(
      JSON.stringify(distributionMismatch.expected),
      /commandVariables/u,
    );
    assert.match(
      JSON.stringify(distributionMismatch.expected),
      /textVariables/u,
    );
    assert.match(JSON.stringify(distributionMismatch.actual), /positions/u);
  });

  void it("相同命令模板下多个 click 整体换序时保留对象变量分布", async (t) => {
    const project = await createProject(t, {
      sourceGreeting:
        '<click:run_command:"/lands info <v:owner>">Owner</click> <click:run_command:"/lands info <v:land>">Land</click>',
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(
          '<click:run_command:"/lands info <v:land>">土地</click> <click:run_command:"/lands info <v:owner>">所有者</click>',
        )}`,
      ),
    );
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
    assert.equal(
      diagnostics.some((diagnostic) =>
        String(diagnostic.code).startsWith("minimessage.variable-"),
      ),
      false,
      checked.stderr || checked.stdout,
    );
  });

  void it("变量在不同 click 命令间调换时分别报告上下文", async (t) => {
    const project = await createProject(t, {
      sourceGreeting:
        '<click:run_command:"/lands claim <v:land>">Claim</click> <click:suggest_command:"/lands rename <v:player>">Rename</click>',
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(
          '<click:run_command:"/lands claim <v:player>">认领</click> <click:suggest_command:"/lands rename <v:land>">改名</click>',
        )}`,
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
    const contextErrors = diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === "minimessage.variable-name-mismatch" &&
        JSON.stringify(diagnostic.expected).includes("click-command"),
    );
    assert.equal(contextErrors.length, 2, checked.stderr || checked.stdout);
    assert.match(JSON.stringify(contextErrors), /claim/u);
    assert.match(JSON.stringify(contextErrors), /rename/u);
  });

  void it("按固定版官方动作比较 click 参数，并只对 Lands 可插值形式计变量", async (t) => {
    const project = await createProject(t, {
      sourceGreeting:
        '<click:open_url:"https://example.test/<v:player>">Open</click> <click:run_command:/lands claim>Claim</click>',
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(
          '<click:open_url:"https://example.test/<v:land>">打开</click> <click:run_command:/lands claim>认领</click>',
        )}`,
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
    assert.equal(
      diagnostics.some((diagnostic) =>
        String(diagnostic.code).startsWith("minimessage.variable-"),
      ),
      false,
      checked.stderr || checked.stdout,
    );
    assert.ok(
      diagnostics.some((diagnostic) =>
        String(diagnostic.code).startsWith("minimessage.click-"),
      ),
      checked.stderr || checked.stdout,
    );
  });

  void it("覆盖固定版官方定义的全部 click 动作", async (t) => {
    const sourceGreeting =
      '<click:open_url:"https://example.test">url</click> <click:open_file:"/tmp/file">file</click> <click:run_command:"/lands list">run</click> <click:suggest_command:"/lands list">suggest</click> <click:change_page:2>page</click> <click:copy_to_clipboard:"copied">copy</click> <click:show_dialog:example>dialog</click> <click:custom:"custom-value">custom</click>';
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
        `greeting: ${JSON.stringify(
          '<click:open_url:"https://example.test">链接</click> <click:open_file:"/tmp/file">文件</click> <click:run_command:"/lands list">运行</click> <click:suggest_command:"/lands list">建议</click> <click:change_page:2>页面</click> <click:copy_to_clipboard:"copied">复制</click> <click:show_dialog:example>对话框</click> <click:custom:"custom-value">自定义</click>',
        )}`,
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
    const actionErrors = diagnostics.filter(
      (diagnostic) =>
        String(diagnostic.code).startsWith("minimessage.click-") ||
        (String(diagnostic.code).startsWith("minimessage.variable-") &&
          diagnostic.code !== "minimessage.variable-coverage-unavailable"),
    );
    assert.deepEqual(actionErrors, [], checked.stderr || checked.stdout);
    assert.ok(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "minimessage.variable-coverage-unavailable" &&
          String(diagnostic.reason).includes("show_dialog"),
      ),
      checked.stderr || checked.stdout,
    );
    assert.ok(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "minimessage.variable-coverage-unavailable" &&
          String(diagnostic.reason).includes("custom"),
      ),
      checked.stderr || checked.stdout,
    );
  });

  void it("分别报告 click 动作、命令名和行为参数变化", async (t) => {
    const cases = [
      {
        source: '<click:run_command:"/lands claim <v:land>">Claim</click>',
        target: '<click:suggest_command:"/lands claim <v:land>">认领</click>',
        code: "minimessage.click-action-mismatch",
      },
      {
        source: '<click:run_command:"/lands claim <v:land>">Claim</click>',
        target: '<click:run_command:"/land claim <v:land>">放弃</click>',
        code: "minimessage.click-command-name-mismatch",
      },
      {
        source:
          '<click:run_command:"/lands claim <v:land> --world Earth">Claim</click>',
        target:
          '<click:run_command:"/lands claim <v:land> --world Mars">认领</click>',
        code: "minimessage.click-command-arguments-mismatch",
      },
    ];

    for (const example of cases) {
      const project = await createProject(t, {
        sourceGreeting: example.source,
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

      const targetPath = join(project.directory, "lang/zh.yml");
      const target = await readFile(targetPath, "utf8");
      await writeFile(
        targetPath,
        target.replace(
          "greeting: 你好",
          `greeting: ${JSON.stringify(example.target)}`,
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
      const difference = diagnostics.find(
        (diagnostic) => diagnostic.code === example.code,
      );
      assert.ok(
        difference,
        `${example.code}: ${checked.stderr || checked.stdout}`,
      );
      assert.match(JSON.stringify(difference?.expected), /lands/u);
      assert.match(JSON.stringify(difference?.actual), /land/u);
    }
  });

  void it("同消息的多个 click 参数问题可以分别确认并独立过期", async (t) => {
    const project = await createProject(t, {
      sourceGreeting:
        "<click:run_command:'/a one'>A</click> <click:run_command:'/b two'>B</click>",
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    const mismatchedTarget =
      "<click:run_command:'/a other'>甲</click> <click:run_command:'/b else'>乙</click>";
    await writeFile(
      targetPath,
      target.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(mismatchedTarget)}`,
      ),
    );
    const before = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const beforeDiagnostics = readReport(before.stdout || before.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    const issues = beforeDiagnostics.filter(
      (diagnostic) =>
        diagnostic.code === "minimessage.click-command-arguments-mismatch",
    );
    assert.equal(issues.length, 2, before.stdout || before.stderr);
    assert.notEqual(issues[0]?.objectId, issues[1]?.objectId);

    for (const [index, issue] of issues.entries()) {
      const exemption = runCli(
        "exempt",
        "--project",
        project.directory,
        "--diagnostic",
        String(issue.diagnosticId),
        "--reason",
        `此处命令参数由运行时约定，问题 ${index + 1}`,
        "--output-format",
        "structured",
      );
      assert.equal(exemption.status, 0, exemption.stderr);
    }

    const exceptionText = await readFile(
      join(project.directory, ".l10n/exceptions.yml"),
      "utf8",
    );
    assert.equal(exceptionText.match(/diagnosticId:/gu)?.length, 2);
    const afterBoth = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const afterBothDiagnostics = readReport(
      afterBoth.stdout || afterBoth.stderr,
    ).diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      afterBothDiagnostics.some(
        (diagnostic) =>
          diagnostic.code === "minimessage.click-command-arguments-mismatch",
      ),
      false,
      afterBoth.stdout || afterBoth.stderr,
    );

    const currentTarget = await readFile(targetPath, "utf8");
    await writeFile(targetPath, currentTarget.replace("/a other", "/a one"));
    const afterFirstDisappears = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const afterFirstDiagnostics = readReport(
      afterFirstDisappears.stdout || afterFirstDisappears.stderr,
    ).diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      afterFirstDiagnostics.filter(
        (diagnostic) => diagnostic.code === "exception.orphaned",
      ).length,
      1,
      afterFirstDisappears.stdout || afterFirstDisappears.stderr,
    );
    assert.equal(
      afterFirstDiagnostics.filter(
        (diagnostic) => diagnostic.code === "exception.review-required",
      ).length,
      1,
      afterFirstDisappears.stdout || afterFirstDisappears.stderr,
    );
    const remainingMismatch = afterFirstDiagnostics.filter(
      (diagnostic) =>
        diagnostic.code === "minimessage.click-command-arguments-mismatch",
    );
    assert.equal(
      remainingMismatch.length,
      1,
      afterFirstDisappears.stdout || afterFirstDisappears.stderr,
    );
    assert.match(JSON.stringify(remainingMismatch[0]?.expected), /\/b two/u);
    assert.match(JSON.stringify(remainingMismatch[0]?.actual), /\/b else/u);
  });

  void it("按 Lands Java Pattern 行终止符边界保留多行 click 字面参数", async (t) => {
    const lineTerminators = ["\n", "\r", "\u0085", "\u2028", "\u2029"];
    const source = lineTerminators.map(
      (lineTerminator) =>
        `<click:run_command:"/lands${lineTerminator} <v:owner> <v:land>">Info</click>`,
    );
    const target = lineTerminators.map(
      (lineTerminator) =>
        `<click:run_command:"/lands${lineTerminator} <v:land> <v:owner>">详情</click>`,
    );
    source.push(
      '<click:run_command:"/lands info <v:owner> <v:land>">Single line</click>',
    );
    target.push(
      '<click:run_command:"/lands info <v:land> <v:owner>">单行</click>',
    );
    const project = await createProject(t, {
      sourceGreeting: source.join(" "),
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const targetYaml = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      targetYaml.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(target.join(" "))}`,
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
    const argumentDifferences = diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === "minimessage.click-command-arguments-mismatch",
    );
    assert.equal(argumentDifferences.length, lineTerminators.length);
    for (const lineTerminator of lineTerminators) {
      assert.ok(
        argumentDifferences.some((diagnostic) => {
          const expected = diagnostic.expected as Record<string, unknown>;
          return (
            typeof expected.value === "string" &&
            expected.value.includes(
              `/lands${lineTerminator} <v:owner> <v:land>`,
            )
          );
        }),
        checked.stderr || checked.stdout,
      );
    }
    assert.equal(
      diagnostics.some(
        (diagnostic) =>
          String(diagnostic.code).startsWith("minimessage.variable-") &&
          diagnostic.code !== "minimessage.variable-coverage-unavailable",
      ),
      false,
      checked.stderr || checked.stdout,
    );
  });

  void it("保留 click 引号转义并接受单引号变量参数", async (t) => {
    const project = await createProject(t, {
      sourceGreeting:
        '<click:run_command:"/lands say \\"quoted\\" <v:land>">Claim</click> and <click:copy_to_clipboard:\'/lands owner <v:owner> \\\\ path\'>Owner</click>',
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(
          '<click:run_command:"/lands say \\"quoted\\" <v:land>">认领</click>；<click:copy_to_clipboard:\'/lands owner <v:owner> \\\\ path\'>所有者</click>',
        )}`,
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
    assert.equal(
      diagnostics.some(
        (diagnostic) =>
          String(diagnostic.code).startsWith("minimessage.variable-") ||
          String(diagnostic.code).startsWith("minimessage.click-"),
      ),
      false,
      checked.stderr || checked.stdout,
    );
  });

  void it("递归核对 show_entity 的可译名称变量", async (t) => {
    const project = await createProject(t, {
      sourceGreeting:
        "<hover:show_entity:bee:550e8400-e29b-41d4-a716-446655440000:'Owner <v:owner>'>蜂</hover>",
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(
          "<hover:show_entity:bee:550e8400-e29b-41d4-a716-446655440000:'<v:player> 的主人'>蜜蜂</hover>",
        )}`,
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
    assert.ok(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "minimessage.variable-name-mismatch" &&
          JSON.stringify(diagnostic.expected).includes("hover-text"),
      ),
      checked.stderr || checked.stdout,
    );
  });

  void it("递归区分多层 hover 文本内的变量上下文", async (t) => {
    const project = await createProject(t, {
      sourceGreeting:
        "<hover:show_text:'Outer <hover:show_text:\"Inner <v:owner>\">nested</hover>'>Hover</hover>",
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(
          "<hover:show_text:'外层 <hover:show_text:\"内层 <v:player>\">详情</hover>'>悬停</hover>",
        )}`,
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
    const mismatch = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "minimessage.variable-name-mismatch" &&
        JSON.stringify(diagnostic.expected).includes("owner"),
    );
    assert.ok(mismatch, checked.stderr || checked.stdout);
    const context = JSON.stringify(mismatch.expected);
    assert.ok((context.match(/hover-text/gu)?.length ?? 0) >= 2, context);
  });

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

  void it("变量诊断豁免在解析器不可用时无法评估", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "Hello, <v:player>!",
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
    const variableIssue = diagnostics.find(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-variables" &&
        diagnostic.code === "minimessage.variable-missing",
    );
    assert.ok(variableIssue, checked.stdout || checked.stderr);
    if (variableIssue === undefined) throw new Error("缺少变量诊断");

    const exemption = runCli(
      "exempt",
      "--project",
      project.directory,
      "--diagnostic",
      String(variableIssue.diagnosticId),
      "--reason",
      "此变量在当前界面由服务器补齐",
      "--output-format",
      "structured",
    );
    assert.equal(exemption.status, 0, exemption.stderr);
    const exceptionPath = join(project.directory, ".l10n/exceptions.yml");
    const exceptionBytes = await readFile(exceptionPath);

    const status = runCli(
      "status",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const statusDiagnostics = readReport(status.stdout || status.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      statusDiagnostics.some(
        (diagnostic) =>
          diagnostic.code === "exception.unable-to-evaluate" &&
          diagnostic.ruleId === "exceptions",
      ),
      true,
      status.stdout || status.stderr,
    );
    assert.deepEqual(await readFile(exceptionPath), exceptionBytes);

    const unavailable = runCliWithoutJava(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(unavailable.status, 1);
    const unavailableReport = readReport(
      unavailable.stdout || unavailable.stderr,
    );
    const unavailableDiagnostics =
      unavailableReport.diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      unavailableDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
      true,
      unavailable.stdout || unavailable.stderr,
    );
    assert.equal(
      unavailableDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.orphaned",
      ),
      false,
      unavailable.stdout || unavailable.stderr,
    );
    assert.equal(
      (unavailableReport.coverage as Record<string, unknown>).complete,
      false,
    );
    assert.deepEqual(await readFile(exceptionPath), exceptionBytes);
  });

  void it("变量覆盖不完整时保留豁免为无法评估", async (t) => {
    const project = await createProject(t, { sourceGreeting: "Hello!" });
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
    const writeGreeting = async (greeting: string): Promise<void> => {
      const target = await readFile(targetPath, "utf8");
      await writeFile(
        targetPath,
        target.replace(
          /^  greeting:.*$/mu,
          `  greeting: ${JSON.stringify(greeting)}`,
        ),
      );
    };
    await writeGreeting("你好 <v:other>");
    const before = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const beforeDiagnostics = readReport(before.stdout || before.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    const selected = beforeDiagnostics.find(
      (diagnostic) => diagnostic.code === "minimessage.variable-added",
    );
    assert.ok(selected, before.stdout || before.stderr);
    if (selected === undefined) throw new Error("缺少变量新增诊断");

    const exempted = runCli(
      "exempt",
      "--project",
      project.directory,
      "--diagnostic",
      String(selected.diagnosticId),
      "--reason",
      "此变量由运行时接受",
      "--output-format",
      "structured",
    );
    assert.equal(exempted.status, 0, exempted.stderr);

    await writeGreeting("你好 §c世界 <v:other>");
    const invalid = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const invalidDiagnostics = readReport(invalid.stdout || invalid.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      invalidDiagnostics.some(
        (diagnostic) => diagnostic.code === "minimessage.syntax-invalid",
      ),
      true,
      invalid.stdout || invalid.stderr,
    );
    assert.equal(
      invalidDiagnostics.some(
        (diagnostic) =>
          diagnostic.code === "minimessage.variable-coverage-unavailable",
      ),
      true,
      invalid.stdout || invalid.stderr,
    );
    assert.equal(
      invalidDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
      true,
      invalid.stdout || invalid.stderr,
    );
    assert.equal(
      invalidDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.orphaned",
      ),
      false,
      invalid.stdout || invalid.stderr,
    );

    await writeGreeting("你好 <v:other> and again");
    const recovered = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const recoveredDiagnostics = readReport(
      recovered.stdout || recovered.stderr,
    ).diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      recoveredDiagnostics.some(
        (diagnostic) => diagnostic.code === "minimessage.variable-added",
      ),
      true,
      recovered.stdout || recovered.stderr,
    );
    assert.equal(
      recoveredDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.review-required",
      ),
      true,
      recovered.stdout || recovered.stderr,
    );
    assert.equal(
      recoveredDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
      false,
      recovered.stdout || recovered.stderr,
    );

    await writeGreeting("你好");
    const disappeared = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const disappearedDiagnostics = readReport(
      disappeared.stdout || disappeared.stderr,
    ).diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      disappearedDiagnostics.some(
        (diagnostic) => diagnostic.code === "minimessage.variable-added",
      ),
      false,
      disappeared.stdout || disappeared.stderr,
    );
    assert.equal(
      disappearedDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.orphaned",
      ),
      true,
      disappeared.stdout || disappeared.stderr,
    );
    assert.equal(
      disappearedDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
      false,
      disappeared.stdout || disappeared.stderr,
    );
  });

  void it("语法错误诊断在变量覆盖不完整时仍可评估和豁免", async (t) => {
    const project = await createProject(t, { sourceGreeting: "Hello" });
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
        `greeting: ${JSON.stringify("你好 §c世界")}`,
      ),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const diagnostics = readReport(checked.stdout || checked.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    const syntaxIssue = diagnostics.find(
      (diagnostic) => diagnostic.code === "minimessage.syntax-invalid",
    );
    assert.ok(syntaxIssue, checked.stdout || checked.stderr);
    if (syntaxIssue === undefined) throw new Error("缺少语法诊断");
    assert.equal(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "minimessage.variable-coverage-unavailable",
      ),
      true,
      checked.stdout || checked.stderr,
    );

    const exemption = runCli(
      "exempt",
      "--project",
      project.directory,
      "--diagnostic",
      String(syntaxIssue.diagnosticId),
      "--reason",
      "此旧颜色码由上游运行时接受",
      "--output-format",
      "structured",
    );
    assert.equal(exemption.status, 0, exemption.stderr);
    const after = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const afterDiagnostics = readReport(after.stdout || after.stderr)
      .diagnostics as readonly Record<string, unknown>[];
    assert.equal(
      afterDiagnostics.some(
        (diagnostic) => diagnostic.code === "minimessage.syntax-invalid",
      ),
      false,
      after.stdout || after.stderr,
    );
    assert.equal(
      afterDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
      false,
      after.stdout || after.stderr,
    );
    assert.equal(
      afterDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.orphaned",
      ),
      false,
      after.stdout || after.stderr,
    );
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
    assert.equal(
      (coverage.unavailableCapabilities as string[]).some((capability) =>
        capability.includes("旧颜色码"),
      ),
      false,
      "已核实的 8.0.1 & 颜色码应先适配，再进入官方 MiniMessage 解析",
    );
    assert.equal(
      diagnostics.some((diagnostic) =>
        String(diagnostic.code).startsWith("legacy-format."),
      ),
      false,
      "受支持的旧颜色码不应报告为格式错误",
    );
  });

  void it("通过正式 CLI 定位来源版本不支持的旧颜色码", async (t) => {
    const project = await createGuiProject(t, {
      name: "Tool",
      lore: ["§aLand"],
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
    const finding = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "legacy-format.code-unsupported" &&
        diagnostic.origin === "target",
    );

    assert.ok(finding, checked.stderr || checked.stdout);
    assert.match(JSON.stringify(finding?.actual), /§a/u);
    assert.match(JSON.stringify(finding?.actual), /"start":0/u);
  });

  void it("通过正式 CLI 报告未知旧颜色来源版本的未完成范围", async (t) => {
    const project = await createGuiProject(t, {
      name: "&aTool",
      lore: ["&cLand"],
      sourceVersion: "8.9.3",
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
    const coverage = report.coverage as Record<string, unknown>;
    const finding = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "legacy-format.source-version-unsupported" &&
        diagnostic.origin === "target",
    );

    assert.equal(coverage.complete, false);
    assert.ok(finding, checked.stderr || checked.stdout);
    assert.match(JSON.stringify(finding?.expected), /8\.0\.1/u);
    assert.match(JSON.stringify(finding?.expected), /8\.9\.2/u);
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

  void it("变量规则通过正式场景检查 GUI lore、对话框物品和配置文本", async (t) => {
    const project = await createGuiProject(t, {
      name: "工具",
      lore: ["说明 <v:owner>"],
      dialogItemName: "对话框 <v:player>",
      categoryName: "分类 <v:land>",
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

    for (const [file, variable] of [
      ["Locale/zh-CN_gui.yml", "owner"],
      ["Locale/zh-CN_dialogs.yml", "player"],
      ["Locale/zh-CN_categories.yml", "land"],
    ] as const) {
      const targetPath = join(project.directory, file);
      const target = await readFile(targetPath, "utf8");
      assert.ok(target.includes(`<v:${variable}>`), `${file} 缺少初始化文本`);
      await writeFile(targetPath, target.replace(`<v:${variable}>`, ""));
    }

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
    const missingVariables = diagnostics.filter(
      (diagnostic) => diagnostic.code === "minimessage.variable-missing",
    );
    assert.equal(missingVariables.length, 3, checked.stderr || checked.stdout);
    const expectedFields = [
      {
        file: "Locale/zh-CN_gui.yml",
        path: ["physical", "selection", "lore"],
        scene: "gui-item-lore",
      },
      {
        file: "Locale/zh-CN_dialogs.yml",
        path: ["dialogs", "confirmation", "bodies", "icon", "item", "name"],
        scene: "gui-item-name",
      },
      {
        file: "Locale/zh-CN_categories.yml",
        path: ["land", "categories", "peaceful", "name"],
        scene: "category-name",
      },
    ];
    for (const field of expectedFields) {
      assert.ok(
        missingVariables.some((diagnostic) => {
          const location = diagnostic.location as Record<string, unknown>;
          const message = diagnostic.message as Record<string, unknown>;
          return (
            location.file === field.file &&
            JSON.stringify(location.path) === JSON.stringify(field.path) &&
            message.scene === field.scene
          );
        }),
        `${field.file} ${field.path.join(".")} ${checked.stderr || checked.stdout}`,
      );
    }
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

void describe("术语和风格正式检查", () => {
  void it("保留 claims 名词句中同时出现的占领和领土", async (t) => {
    const result = await checkGreeting(
      t,
      "New claims will belong to this area.",
      "新占领的领土将属于这个子区域.",
    );
    assert.equal(
      result.diagnostics.some((diagnostic) =>
        String(diagnostic.ruleId).startsWith("terminology"),
      ),
      false,
      result.checked.stderr || result.checked.stdout,
    );
    assert.equal(result.checked.status, 1);
    assert.equal(result.report.state, "incomplete");
  });

  void it("把 Claim 动词误作领土时报告词义偏差", async (t) => {
    const result = await checkGreeting(t, "Claim chunk(s)", "领土区块");
    const issue = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "terminology.opposite-sense",
    );
    assert.ok(issue, result.checked.stderr || result.checked.stdout);
    if (issue === undefined) throw new Error("缺少 Claim 词义诊断");
    assert.equal(issue.ruleId, "terminology");
    assert.equal(issue.origin, "target");
    assert.equal(
      (issue.location as Record<string, unknown>).path instanceof Array,
      true,
    );
    assert.match(JSON.stringify(issue.expected), /占领/u);
    assert.match(JSON.stringify(issue.actual), /领土/u);
  });

  void it("按完整 Unclaim 处理且不把 Claimblock 拆成 Claim", async (t) => {
    const result = await checkGreeting(
      t,
      "Unclaim chunk(s) / Claimblock",
      "取消占领区块 / 占领方块",
    );
    assert.equal(
      result.diagnostics.some(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      false,
      result.checked.stderr || result.checked.stdout,
    );
  });

  void it("检查跨纯样式节点的短语，且不跨变量拼出术语", async (t) => {
    const styled = await checkGreeting(t, "Na<red>tion</red>", "国家");
    assert.ok(
      styled.diagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "terminology" &&
          diagnostic.code === "terminology.translation-missing",
      ),
      styled.checked.stderr || styled.checked.stdout,
    );

    const separated = await checkGreeting(
      t,
      "Na<v:player>tion",
      "甲<v:player>乙",
    );
    assert.equal(
      separated.diagnostics.some(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      false,
      separated.checked.stderr || separated.checked.stdout,
    );
  });

  void it("将 Lands 产品名视为不适用的 Land 术语", async (t) => {
    const result = await checkGreeting(
      t,
      "This is the Lands plugin.",
      "这是 Lands 插件.",
    );
    assert.equal(
      result.diagnostics.some(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      false,
      result.checked.stderr || result.checked.stdout,
    );

    const gameEntity = await checkGreeting(t, "Your Lands", "你的土地");
    assert.ok(
      gameEntity.diagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "terminology" &&
          diagnostic.code === "terminology.translation-missing",
      ),
      gameEntity.checked.stderr || gameEntity.checked.stdout,
    );
  });

  void it("区分两类 Flags 和普通 Personal Settings", async (t) => {
    const result = await checkGreeting(
      t,
      "Natural Flags; Role Flags; Personal Settings.",
      "环境设置; 职位设置; 个人设置.",
    );
    assert.equal(
      result.diagnostics.some((diagnostic) =>
        String(diagnostic.ruleId).startsWith("terminology"),
      ),
      false,
      result.checked.stderr || result.checked.stdout,
    );
  });

  void it("区分 Trust、Trusted Player 与黑名单中的普通加入", async (t) => {
    const result = await checkGreeting(
      t,
      "Trust this player. Trusted Player. Ban player from this area.",
      "邀请此玩家. 成员. 将玩家加入此子区域黑名单.",
    );
    assert.equal(
      result.diagnostics.some((diagnostic) =>
        String(diagnostic.ruleId).startsWith("terminology"),
      ),
      false,
      result.checked.stderr || result.checked.stdout,
    );

    const banOnly = await checkGreeting(
      t,
      "Ban player from this area.",
      "将玩家加入此子区域黑名单.",
    );
    assert.equal(
      banOnly.diagnostics.some(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      false,
      banOnly.checked.stderr || banOnly.checked.stdout,
    );

    const joined = await checkGreeting(
      t,
      "Trust this player.",
      "将此玩家加入此子区域.",
    );
    assert.equal(
      joined.diagnostics.some(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      false,
      joined.checked.stderr || joined.checked.stdout,
    );
  });

  void it("区分 war declarations 名词与 declare war 动词", async (t) => {
    const result = await checkGreeting(
      t,
      "Deny war declarations and declare war.",
      "拒绝宣战书并宣战.",
    );
    assert.equal(
      result.diagnostics.some((diagnostic) =>
        String(diagnostic.ruleId).startsWith("terminology"),
      ),
      false,
      result.checked.stderr || result.checked.stdout,
    );
  });

  void it("检查 hover 正文，但排除 click 命令里的术语", async (t) => {
    const result = await checkGreeting(
      t,
      "<click:run_command:\"/lands claim\">Click <hover:show_text:'Owner'>details</hover></click>",
      "<click:run_command:\"/lands claim\">点击 <hover:show_text:'所有权'>说明</hover></click>",
    );
    const terminology = result.diagnostics.filter(
      (diagnostic) => diagnostic.ruleId === "terminology",
    );
    assert.equal(
      terminology.length,
      1,
      result.checked.stderr || result.checked.stdout,
    );
    assert.match(JSON.stringify(terminology[0]?.expected), /所有者/u);
    assert.match(JSON.stringify(terminology[0]?.actual), /所有权/u);
  });

  void it("变量和命令参数不参与术语或风格检查", async (t) => {
    const result = await checkGreeting(
      t,
      '<click:run_command:"/lands claim,您？"><v:player>Click</click>',
      '<click:run_command:"/lands claim,您？"><v:player>点击</click>',
    );
    assert.equal(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "terminology" ||
          diagnostic.ruleId === "translation-style",
      ),
      false,
      result.checked.stderr || result.checked.stdout,
    );
  });

  void it("只报告 README 规定的全角标点和‘您’", async (t) => {
    const result = await checkGreeting(t, "Hello", "您好吗？");
    const style = result.diagnostics.filter(
      (diagnostic) => diagnostic.ruleId === "translation-style",
    );
    assert.equal(
      style.length,
      2,
      result.checked.stderr || result.checked.stdout,
    );
    assert.ok(
      style.some(
        (diagnostic) => diagnostic.code === "translation-style.honorific",
      ),
    );
    assert.ok(
      style.some(
        (diagnostic) => diagnostic.code === "translation-style.punctuation",
      ),
    );
    assert.ok(style.every((diagnostic) => diagnostic.origin === "target"));
  });

  void it("允许配置单项规范译法和规则严重级别", async (t) => {
    const defaultResult = await checkGreeting(t, "Nation", "王国");
    const result = await checkGreeting(
      t,
      "Nation",
      "王国",
      [
        "rules:",
        "  terminology:",
        "    severity: warning",
        "    parameters:",
        "      translations:",
        "        nation: 国家",
      ].join("\n"),
    );
    const issue = result.diagnostics.find(
      (diagnostic) => diagnostic.ruleId === "terminology",
    );
    assert.ok(issue, result.checked.stderr || result.checked.stdout);
    assert.equal(issue?.severity, "warning");
    assert.match(JSON.stringify(issue?.expected), /国家/u);
    assert.doesNotMatch(JSON.stringify(issue?.expected), /联邦/u);
    const defaultIssue = defaultResult.diagnostics.find(
      (diagnostic) => diagnostic.ruleId === "terminology",
    );
    assert.ok(
      defaultIssue,
      defaultResult.checked.stderr || defaultResult.checked.stdout,
    );
    assert.notEqual(issue?.contentFingerprint, defaultIssue.contentFingerprint);
  });

  void it("可单独关闭术语规则并在覆盖状态中标出", async (t) => {
    const result = await checkGreeting(
      t,
      "Nation",
      "国家",
      ["rules:", "  terminology:", "    enabled: false"].join("\n"),
    );
    assert.equal(
      result.diagnostics.some(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      false,
      result.checked.stderr || result.checked.stdout,
    );
    const coverage = result.report.coverage as Record<string, unknown>;
    assert.ok((coverage.disabledRuleIds as string[]).includes("terminology"));
    assert.equal(coverage.complete, false);
  });

  void it("片段抽取不完整时将旧术语豁免标为无法评估", async (t) => {
    const result = await checkGreeting(t, "Nation", "王国");
    const issue = result.diagnostics.find(
      (diagnostic) => diagnostic.ruleId === "terminology",
    );
    assert.ok(issue, result.checked.stderr || result.checked.stdout);
    if (issue === undefined) throw new Error("缺少术语诊断");
    const exemption = runCli(
      "exempt",
      "--project",
      result.project.directory,
      "--diagnostic",
      String(issue.diagnosticId),
      "--reason",
      "原译文需要维护者复核",
      "--output-format",
      "structured",
    );
    assert.equal(exemption.status, 0, exemption.stderr);

    const targetPath = join(result.project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace('greeting: "王国"', 'greeting: "王国 §c"'),
    );
    const afterIncompleteParse = runCli(
      "check",
      "--project",
      result.project.directory,
      "--output-format",
      "structured",
    );
    const afterReport = readReport(
      afterIncompleteParse.stdout || afterIncompleteParse.stderr,
    );
    const diagnostics = afterReport.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.ok(
      diagnostics.some(
        (diagnostic) => diagnostic.code === "minimessage.syntax-invalid",
      ),
      afterIncompleteParse.stderr || afterIncompleteParse.stdout,
    );
    const coverage = afterReport.coverage as Record<string, unknown>;
    assert.equal(coverage.complete, false);
    assert.match(
      JSON.stringify(coverage.unavailableCapabilities),
      /可译文本片段不完整/u,
    );
    assert.ok(
      diagnostics.some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
      afterIncompleteParse.stderr || afterIncompleteParse.stdout,
    );
  });

  void it("不因待翻译英文种子缺少中文术语而报告", async (t) => {
    const result = await checkGreeting(t, "Nation", "Nation");
    assert.equal(
      result.diagnostics.some(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      false,
      result.checked.stderr || result.checked.stdout,
    );
    assert.equal(result.checked.status, 1);
    assert.equal(result.report.state, "incomplete");
    const coverage = result.report.coverage as Record<string, unknown>;
    assert.ok((coverage.enabledRuleIds as string[]).includes("terminology"));
    assert.ok(
      (coverage.enabledRuleIds as string[]).includes("translation-style"),
    );
  });
});
