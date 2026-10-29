import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import {
  createProject,
  createGuiProject,
  readReport,
  runCli,
  runCliWithoutJava,
} from "../cli-fixtures.ts";

const cliFile = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

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
          '<click:run_command:"/lands info <v:land>">城镇</click> <click:run_command:"/lands info <v:owner>">所有者</click>',
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
    assert.equal(checked.status, 0, checked.stderr);
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
