import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import {
  createProject,
  createGuiProject,
  createFormatProject,
  readReport,
  runCli,
  runCliWithoutJava,
} from "../cli-fixtures.ts";

const cliFile = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

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
  void it("通过可执行符号链接检查项目", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "<red>Hello</red>",
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
      target.replace("greeting: 你好", 'greeting: "<red>你好</red>"'),
    );
    const executable = join(project.directory, "lands-l10n");
    await symlink(cliFile, executable);
    const argumentsForCheck = [
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    ];
    const throughLink = spawnSync(executable, argumentsForCheck, {
      encoding: "utf8",
    });
    assert.equal(throughLink.status, 0, throughLink.stderr);
    const direct = runCli(...argumentsForCheck);
    assert.equal(direct.status, 0, direct.stderr);
    assert.deepEqual(readReport(throughLink.stdout), readReport(direct.stdout));
  });

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
      "--id",
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
        "--id",
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
    const savedExceptions = parseYaml(exceptionText) as {
      records: readonly { id: string }[];
    };
    assert.deepEqual(
      new Set(savedExceptions.records.map((record) => record.id)),
      new Set(issues.map((issue) => issue.diagnosticId)),
    );
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
      "--id",
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
      "--id",
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
});

void describe("术语和风格正式检查", () => {
  void it("只在对应地图 HTML 可译上下文中检查术语译法", async (t) => {
    const cases = [
      {
        source: "<div title=Nation>Owner</div>",
        target: "<div title=国家>所有权</div>",
        expected: ["nation", "owner"],
      },
      {
        source: "<div title='Owner '>Nation</div>",
        target: "<div title='联邦 '>所有者</div>",
        expected: ["nation", "owner"],
      },
      {
        source: "<div title=Nation>Owner</div>",
        target: "<div title=联邦>所有者</div>",
        expected: [],
      },
      {
        source: "<div>Nation and Owner</div>",
        target: "<div>所有者与联邦</div>",
        expected: [],
      },
      {
        source: "<div><span>Nation </span><span>Owner</span></div>",
        target: "<div><span>所有者 </span><span>联邦</span></div>",
        expected: ["nation", "owner"],
      },
      {
        source: "<click:run_command:'/x'>Nation</click> Owner",
        target: "<click:run_command:'/x'>所有者</click> 联邦",
        expected: ["nation", "owner"],
      },
    ] as const;

    for (const testCase of cases) {
      const project = await createFormatProject(t, {
        mapDescription: testCase.source,
        targetMapDescription: testCase.target,
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
      const report = readReport(checked.stderr || checked.stdout);
      const mapFindings = (
        report.diagnostics as readonly Record<string, unknown>[]
      ).filter((diagnostic) => {
        if (diagnostic.ruleId !== "terminology") return false;
        const location = diagnostic.location as
          | Record<string, unknown>
          | undefined;
        return (
          JSON.stringify(location?.path) ===
          JSON.stringify([
            "general",
            "integration",
            "dynmap",
            "land",
            "description",
          ])
        );
      });
      assert.deepEqual(
        mapFindings
          .map((diagnostic) =>
            String((diagnostic.expected as Record<string, unknown>).termId),
          )
          .sort(),
        [...testCase.expected].sort(),
        checked.stderr || checked.stdout,
      );
    }
  });

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
    assert.equal(result.checked.status, 0);
    assert.equal(result.report.state, "ready");
    assert.equal(
      (result.report.coverage as { readonly complete: boolean }).complete,
      true,
    );
  });

  void it("把 Claim 动词误作领土时报告词义偏差", async (t) => {
    const result = await checkGreeting(t, "Claim chunk(s)", "领土区块");
    const issue = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "terminology.opposite-sense",
    );
    assert.ok(issue, result.checked.stderr || result.checked.stdout);
    if (issue === undefined) throw new Error("缺少 Claim 词义诊断");
    assert.equal(issue.ruleId, "terminology");
    assert.equal(issue.severity, "error");
    assert.equal(issue.origin, "target");
    assert.equal(result.checked.status, 1);
    assert.deepEqual(issue.location, {
      file: "lang/zh.yml",
      path: ["messages", "greeting"],
    });
    assert.equal(
      typeof (issue.message as Record<string, unknown>).id,
      "string",
    );
    assert.match(String(issue.reason), /Claim/u);
    assert.match(JSON.stringify(issue.expected), /占领/u);
    assert.match(JSON.stringify(issue.actual), /领土/u);
  });

  void it("不把 claim-worlds-list 技术键截成 Claim，保留动作和名词义", async (t) => {
    const configKey = await checkGreeting(
      t,
      "The claim-worlds-list option is part of the configuration.",
      "claim-worlds-list 选项属于配置内容.",
    );
    assert.deepEqual(
      configKey.diagnostics.filter(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      [],
      configKey.checked.stderr || configKey.checked.stdout,
    );

    const correct = await checkGreeting(
      t,
      "Claim this chunk. Claims of this world.",
      "占领此区块. 本世界的领土.",
    );
    assert.deepEqual(
      correct.diagnostics.filter(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      [],
      correct.checked.stderr || correct.checked.stdout,
    );

    for (const [target, expectedTermId] of [
      ["领土此区块. 本世界的领土.", "claim-verb"],
      ["占领此区块. 本世界的占领.", "claim-noun"],
    ] as const) {
      const wrong = await checkGreeting(
        t,
        "Claim this chunk. Claims of this world.",
        target,
      );
      assert.ok(
        wrong.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "terminology.opposite-sense" &&
            (diagnostic.expected as Record<string, unknown>).termId ===
              expectedTermId,
        ),
        wrong.checked.stderr || wrong.checked.stdout,
      );
    }
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

  void it("区分未占领地点状态和取消占领动作", async (t) => {
    const location = await checkGreeting(
      t,
      "Successfully teleported into the nearest unclaimed location.",
      "已成功传送到最近的未占领位置.",
    );
    assert.deepEqual(
      location.diagnostics.filter(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      [],
      location.checked.stderr || location.checked.stdout,
    );

    const action = await checkGreeting(
      t,
      "Unclaim this chunk.",
      "未占领此区块.",
    );
    assert.ok(
      action.diagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "terminology" &&
          (diagnostic.expected as Record<string, unknown>).termId === "unclaim",
      ),
      action.checked.stderr || action.checked.stdout,
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

    const lowercaseName = await checkGreeting(
      t,
      "from lands plugin",
      "来自 lands 插件.",
    );
    assert.ok(
      lowercaseName.diagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "terminology" &&
          diagnostic.code === "terminology.translation-missing",
      ),
      lowercaseName.checked.stderr || lowercaseName.checked.stdout,
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

  void it("区分成员身份、非成员访问状态与邀请或移出动作", async (t) => {
    const states = await checkGreeting(
      t,
      "You're not trusted in the area. Temporary trust. " +
        "Open to untrusted players. Untrusted. " +
        "The player will be trusted only for the selected duration. " +
        "The player was untrusted because their temporary trust expired.",
      "你不是该子区域的成员. 临时成员. 向非成员开放. 游客. " +
        "玩家仅在选定时长内作为成员. " +
        "玩家因临时成员期限到期而被移出.",
    );
    assert.deepEqual(
      states.diagnostics.filter(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      [],
      states.checked.stderr || states.checked.stdout,
    );

    const titleCaseTemporaryTrust = await checkGreeting(
      t,
      "Temporary Trust.",
      "临时成员.",
    );
    assert.deepEqual(
      titleCaseTemporaryTrust.diagnostics.filter(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      [],
      titleCaseTemporaryTrust.checked.stderr ||
        titleCaseTemporaryTrust.checked.stdout,
    );

    for (const [source, target, expectedTermId] of [
      ["Trust this player.", "信任此玩家.", "trust"],
      ["Untrust this player.", "保留非成员状态.", "untrust"],
      [
        "The player was untrusted because temporary trust expired.",
        "玩家因临时成员期限到期而成为非成员.",
        "untrust",
      ],
    ] as const) {
      const wrongAction = await checkGreeting(t, source, target);
      assert.ok(
        wrongAction.diagnostics.some(
          (diagnostic) =>
            diagnostic.ruleId === "terminology" &&
            (diagnostic.expected as Record<string, unknown>).termId ===
              expectedTermId,
        ),
        wrongAction.checked.stderr || wrongAction.checked.stdout,
      );
    }

    for (const [source, object] of [
      ["You untrusted this player.", "此玩家"],
      ["You untrusted that player.", "该玩家"],
      ["You untrusted the player.", "该玩家"],
      ["You untrusted a player.", "一名玩家"],
      ["You untrusted our player.", "我们的玩家"],
      ["Successfully untrusted this player.", "此玩家"],
    ] as const) {
      const correctRemoval = await checkGreeting(
        t,
        source,
        `你已将${object}移出.`,
      );
      assert.equal(
        correctRemoval.diagnostics.some(
          (diagnostic) => diagnostic.ruleId === "terminology",
        ),
        false,
        correctRemoval.checked.stderr || correctRemoval.checked.stdout,
      );

      const wrongState = await checkGreeting(
        t,
        source,
        `你已保留${object}为非成员.`,
      );
      assert.ok(
        wrongState.diagnostics.some(
          (diagnostic) =>
            diagnostic.ruleId === "terminology" &&
            (diagnostic.expected as Record<string, unknown>).termId ===
              "untrust",
        ),
        wrongState.checked.stderr || wrongState.checked.stdout,
      );
    }
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

  void it("把 declare as an enemy 识别为政敌关系动作而非宣战", async (t) => {
    const source =
      `You can't declare land <v:land> as an enemy. ` +
      `<hover:show_text:'Click here to declare nation <v:nation> as an enemy'>Details</hover> ` +
      `<click:run_command:'/x'>Declare nation <v:nation> as an enemy instead</click>`;
    const target =
      `你不能将城镇 <v:land>设为政敌. ` +
      `<hover:show_text:'单击此处将联邦 <v:nation>设为政敌'>详情</hover> ` +
      `<click:run_command:'/x'>改为将联邦 <v:nation>设为政敌</click>`;
    const relation = await checkGreeting(t, source, target);
    assert.deepEqual(
      relation.diagnostics.filter(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      [],
      relation.checked.stderr || relation.checked.stdout,
    );

    const wrongWar = await checkGreeting(t, "Declare war.", "设为政敌.");
    assert.ok(
      wrongWar.diagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "terminology" &&
          (diagnostic.expected as Record<string, unknown>).termId ===
            "declare-verb",
      ),
      wrongWar.checked.stderr || wrongWar.checked.stdout,
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

  void it("按 click 所属对象换序配对 hover 术语", async (t) => {
    const sourceA = `<click:run_command:"/lands a"><hover:show_text:'Nation'>Nation</hover></click>`;
    const sourceB = `<click:run_command:"/lands b"><hover:show_text:'Owner'>Owner</hover></click>`;
    const targetB = `<click:run_command:"/lands b"><hover:show_text:'所有者'>所有者</hover></click>`;
    const targetA = `<click:run_command:"/lands a"><hover:show_text:'联邦'>联邦</hover></click>`;
    const result = await checkGreeting(
      t,
      `${sourceA} ${sourceB}`,
      `${targetB} ${targetA}`,
    );
    assert.deepEqual(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      [],
      result.checked.stderr || result.checked.stdout,
    );

    const sameOrder = await checkGreeting(
      t,
      `${sourceA} ${sourceB}`,
      `${targetA} ${targetB}`,
    );
    assert.deepEqual(
      sameOrder.diagnostics.filter(
        (diagnostic) => diagnostic.ruleId === "terminology",
      ),
      [],
      sameOrder.checked.stderr || sameOrder.checked.stdout,
    );

    const wrongBodyOwner = await checkGreeting(
      t,
      `${sourceA} ${sourceB}`,
      `<click:run_command:"/lands a"><hover:show_text:'联邦'>所有者</hover></click> <click:run_command:"/lands b"><hover:show_text:'所有者'>联邦</hover></click>`,
    );
    const bodyFindings = wrongBodyOwner.diagnostics.filter(
      (diagnostic) => diagnostic.ruleId === "terminology",
    );
    assert.equal(
      bodyFindings.length,
      2,
      wrongBodyOwner.checked.stderr || wrongBodyOwner.checked.stdout,
    );
    assert.deepEqual(
      bodyFindings
        .map(
          (diagnostic) =>
            (diagnostic.expected as Record<string, unknown>).termId,
        )
        .sort((left, right) => String(left).localeCompare(String(right))),
      ["nation", "owner"],
    );
  });

  void it("在不同列表项中按实际文档路径解析 hover 术语 owner", async (t) => {
    const sourceEntries = [
      "<click:run_command:'/a'><hover:show_text:'Nation'>A</hover></click>",
      "<click:run_command:'/b'><hover:show_text:'Owner'>B</hover></click>",
    ];
    const targetEntries = [
      "<click:run_command:'/a'><hover:show_text:'国家'>甲</hover></click>",
      "<click:run_command:'/b'><hover:show_text:'业主'>乙</hover></click>",
    ];
    const project = await createProject(t, { sourceEntries });
    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    const initializedTarget = targetEntries.reduce(
      (updated, entry, index) =>
        updated.replace(
          index === 0 ? "- 第一项" : "- 第二项",
          `- ${JSON.stringify(entry)}`,
        ),
      target,
    );
    await writeFile(targetPath, initializedTarget);
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
    const findings = (
      report.diagnostics as readonly Record<string, unknown>[]
    ).filter((diagnostic) => diagnostic.ruleId === "terminology");
    assert.deepEqual(
      findings
        .map(
          (diagnostic) =>
            (diagnostic.expected as Record<string, unknown>).termId,
        )
        .sort((left, right) => String(left).localeCompare(String(right))),
      ["nation", "owner"],
      checked.stderr || checked.stdout,
    );
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

  void it("检查正文术语但不把翻译键中的 owner 当作正文", async (t) => {
    const source = "A <key:key.jump> <lang:lands.owner> <selector:@a> Owner";
    const result = await checkGreeting(
      t,
      source,
      "一段文字 <key:key.jump> <lang:lands.owner> <selector:@a> 业主",
    );
    const terminology = result.diagnostics.filter(
      (diagnostic) => diagnostic.ruleId === "terminology",
    );

    assert.equal(
      terminology.length,
      1,
      result.checked.stderr || result.checked.stdout,
    );
    const finding = terminology[0];
    assert.ok(finding, result.checked.stderr || result.checked.stdout);
    assert.equal(finding.code, "terminology.translation-missing");
    assert.deepEqual(
      (finding.expected as Record<string, unknown>).sourcePositions,
      [
        {
          start: source.lastIndexOf("Owner"),
          end: source.lastIndexOf("Owner") + 5,
        },
      ],
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
    for (const diagnostic of style) {
      assert.deepEqual(diagnostic.location, {
        file: "lang/zh.yml",
        path: ["messages", "greeting"],
      });
      assert.equal(typeof diagnostic.reason, "string");
      assert.notEqual(diagnostic.expected, undefined);
      assert.notEqual(diagnostic.actual, undefined);
    }
  });

  void it("仅继承对应原文表面的装饰符号标点", async (t) => {
    const source =
      `<hover:show_text:'Click here to navigate to the previous page.'>` +
      `<click:run_command:'/pages previous'>«</click></hover> ` +
      `<hover:show_text:'Click here to go to the next page.'>` +
      `<click:run_command:'/pages next'>»</click></hover> •‹›«»·`;
    const seed = await checkGreeting(t, source, source);
    assert.deepEqual(
      seed.diagnostics.filter(
        (diagnostic) => diagnostic.ruleId === "translation-style",
      ),
      [],
      seed.checked.stderr || seed.checked.stdout,
    );

    const translated = await checkGreeting(
      t,
      source,
      `<hover:show_text:'点击返回上一页.'>` +
        `<click:run_command:'/pages previous'>«</click></hover> ` +
        `<hover:show_text:'点击前往下一页.'>` +
        `<click:run_command:'/pages next'>»</click></hover> •‹›«»·`,
    );
    assert.deepEqual(
      translated.diagnostics.filter(
        (diagnostic) => diagnostic.ruleId === "translation-style",
      ),
      [],
      translated.checked.stderr || translated.checked.stdout,
    );

    const added = await checkGreeting(t, "• Previous", "••‹上一页");
    const addedPunctuation = added.diagnostics.filter(
      (diagnostic) =>
        diagnostic.ruleId === "translation-style" &&
        diagnostic.code === "translation-style.punctuation",
    );
    assert.deepEqual(
      addedPunctuation.map(
        (diagnostic) =>
          (diagnostic.actual as Record<string, unknown>).character,
      ),
      ["•", "‹"],
      added.checked.stderr || added.checked.stdout,
    );

    const actualStyle = await checkGreeting(t, "Welcome", "您好吗，");
    assert.deepEqual(
      actualStyle.diagnostics
        .filter((diagnostic) => diagnostic.ruleId === "translation-style")
        .map((diagnostic) => diagnostic.code)
        .sort((left, right) => String(left).localeCompare(String(right))),
      ["translation-style.honorific", "translation-style.punctuation"],
      actualStyle.checked.stderr || actualStyle.checked.stdout,
    );
  });

  void it("在文本与结构化报告中定位同文档内的每处风格违规", async (t) => {
    const result = await checkGreeting(t, "Hello again", "您和您");
    const honorifics = result.diagnostics.filter(
      (diagnostic) =>
        diagnostic.ruleId === "translation-style" &&
        diagnostic.code === "translation-style.honorific",
    );
    assert.equal(honorifics.length, 2, result.checked.stderr);
    const locations = honorifics.map((diagnostic) => {
      const actual = diagnostic.actual as Record<string, unknown>;
      return {
        documentIndex: actual.documentIndex,
        occurrenceIndex: actual.occurrenceIndex,
        position: actual.position,
      };
    });
    assert.deepEqual(locations, [
      {
        documentIndex: 0,
        occurrenceIndex: 0,
        position: { start: 0, end: 1 },
      },
      {
        documentIndex: 0,
        occurrenceIndex: 1,
        position: { start: 2, end: 3 },
      },
    ]);

    const text = runCli("check", "--project", result.project.directory);
    assert.equal(text.status, 1, text.stderr || text.stdout);
    assert.match(
      text.stderr || text.stdout,
      /"position":\{"start":0,"end":1\}/u,
    );
    assert.match(
      text.stderr || text.stdout,
      /"position":\{"start":2,"end":3\}/u,
    );
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
    assert.equal(result.checked.status, 0);
    assert.equal(result.report.state, "ready");
    assert.equal(
      (result.report.coverage as { readonly complete: boolean }).complete,
      true,
    );
    assert.equal(
      result.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      false,
      result.checked.stderr || result.checked.stdout,
    );
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
      "--id",
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

  void it("已解析的 hover 表面消失时将旧术语豁免标为孤立", async (t) => {
    const source = "<hover:show_text:'Owner'>Click</hover>";
    const translated = "<hover:show_text:'业主'>点击</hover>";
    const result = await checkGreeting(t, source, translated);
    const issue = result.diagnostics.find(
      (diagnostic) => diagnostic.ruleId === "terminology",
    );
    assert.ok(issue, result.checked.stderr || result.checked.stdout);
    if (issue === undefined) throw new Error("缺少悬浮术语诊断");
    const exemption = runCli(
      "exempt",
      "--project",
      result.project.directory,
      "--id",
      String(issue.diagnosticId),
      "--reason",
      "只适用于原来的悬浮术语对象",
      "--output-format",
      "structured",
    );
    assert.equal(exemption.status, 0, exemption.stderr);

    const targetPath = join(result.project.directory, "lang/zh.yml");
    const validTarget = await readFile(targetPath, "utf8");
    const targetWithoutHover = validTarget.replace(
      JSON.stringify(translated),
      JSON.stringify("点击"),
    );
    assert.notEqual(targetWithoutHover, validTarget);
    await writeFile(targetPath, targetWithoutHover);
    const removed = runCli(
      "check",
      "--project",
      result.project.directory,
      "--output-format",
      "structured",
    );
    const removedReport = readReport(removed.stdout || removed.stderr);
    const removedDiagnostics = removedReport.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.ok(
      removedDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.orphaned",
      ),
      removed.stderr || removed.stdout,
    );
    assert.equal(
      removedDiagnostics.some(
        (diagnostic) => diagnostic.code === "exception.unable-to-evaluate",
      ),
      false,
      removed.stderr || removed.stdout,
    );

    await writeFile(targetPath, validTarget);
    const restored = runCli(
      "check",
      "--project",
      result.project.directory,
      "--output-format",
      "structured",
    );
    const restoredDiagnostics = (
      readReport(restored.stdout || restored.stderr)
        .diagnostics as readonly Record<string, unknown>[]
    ).filter((diagnostic) => diagnostic.ruleId === "exceptions");
    assert.deepEqual(
      restoredDiagnostics,
      [],
      restored.stderr || restored.stdout,
    );
  });

  void it("仅跳过锁中标记的待翻译英文种子", async (t) => {
    const project = await createProject(t, { sourceGreeting: "Nation" });
    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(targetPath, target.replace("  greeting: 你好\n", ""));

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
    assert.ok(
      Number((report.summary as Record<string, unknown>).pendingTranslations) >
        0,
      checked.stderr || checked.stdout,
    );
    const seed = (
      report.exceptionCandidates as readonly Record<string, unknown>[]
    )
      .filter((candidate) => candidate.ruleId === "translation-review")
      .find((candidate) => {
        const message = candidate.message as Record<string, unknown>;
        return JSON.stringify(message.path) === '["messages","greeting"]';
      });
    assert.ok(seed, checked.stderr || checked.stdout);
    assert.equal(
      (seed.actual as Record<string, unknown>).pendingReason,
      "translation-seed",
    );
    assert.equal(
      diagnostics.some((diagnostic) => diagnostic.ruleId === "terminology"),
      false,
      checked.stderr || checked.stdout,
    );
    assert.equal(checked.status, 0);
    assert.equal(report.state, "ready");
    assert.equal(
      (report.coverage as { readonly complete: boolean }).complete,
      true,
    );
  });

  void it("同文候选经确认前后都继续检查术语", async (t) => {
    const project = await createProject(t, { sourceGreeting: "Nation" });
    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace("  greeting: 你好", "  greeting: Nation"),
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

    const before = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const beforeReport = readReport(before.stdout || before.stderr);
    const candidates = (
      beforeReport.exceptionCandidates as readonly Record<string, unknown>[]
    ).filter((candidate) => candidate.ruleId === "translation-review");
    const greeting = candidates.find((candidate) => {
      const message = candidate.message as Record<string, unknown>;
      return JSON.stringify(message.path) === '["messages","greeting"]';
    });
    assert.ok(greeting, before.stderr || before.stdout);
    if (greeting === undefined) throw new Error("缺少 greeting 同文候选");
    assert.equal(
      (greeting.actual as Record<string, unknown>).pendingReason,
      "same-text-candidate",
    );

    const beforeTerms = (
      beforeReport.diagnostics as readonly Record<string, unknown>[]
    ).filter((diagnostic) => diagnostic.ruleId === "terminology");
    assert.equal(beforeTerms.length, 1, before.stderr || before.stdout);
    assert.equal(beforeTerms[0]?.code, "terminology.translation-missing");

    const confirmed = runCli(
      "exempt",
      "--project",
      project.directory,
      "--id",
      String(greeting.id),
      "--reason",
      "同文确认不代表术语已经译好",
      "--output-format",
      "structured",
    );
    assert.equal(confirmed.status, 0, confirmed.stderr);

    const after = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const afterReport = readReport(after.stdout || after.stderr);
    const afterTerms = (
      afterReport.diagnostics as readonly Record<string, unknown>[]
    ).filter((diagnostic) => diagnostic.ruleId === "terminology");
    assert.equal(afterTerms.length, 1, after.stderr || after.stdout);
    assert.equal(afterTerms[0]?.code, "terminology.translation-missing");
    assert.equal(
      (afterReport.summary as Record<string, unknown>).confirmedSameText,
      1,
    );
  });
});
