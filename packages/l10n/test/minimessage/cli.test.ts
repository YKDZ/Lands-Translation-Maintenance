import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createProject,
  createGuiProject,
  readReport,
  runCli,
  snapshotProjectFiles,
} from "../cli-fixtures.ts";

void describe("MiniMessage 官方检查制品", () => {
  void it("默认检查要求译文保留颜色标签及出现次数", async (t) => {
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
      target.replace("greeting: 你好", 'greeting: "<blue>你好</blue>"'),
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
    const mismatches = diagnostics.filter(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-tags" &&
        diagnostic.code === "minimessage.tag-mismatch",
    );
    assert.equal(mismatches.length, 2, checked.stderr || checked.stdout);
    const missingRed = mismatches.find((diagnostic) =>
      JSON.stringify(diagnostic.expected).includes("#ff5555"),
    );
    const addedBlue = mismatches.find((diagnostic) =>
      JSON.stringify(diagnostic.expected).includes("#5555ff"),
    );
    assert.ok(missingRed, checked.stderr || checked.stdout);
    assert.ok(addedBlue, checked.stderr || checked.stdout);
    assert.equal(missingRed?.severity, "error");
    assert.match(JSON.stringify(missingRed?.expected), /expectedCount/u);
    assert.match(JSON.stringify(missingRed?.actual), /actualCount/u);
    assert.match(JSON.stringify(addedBlue?.expected), /expectedCount/u);
    assert.match(JSON.stringify(addedBlue?.actual), /actualCount/u);
  });

  void it("标签数量与颜色相同也不能省略原文显式结束标签", async (t) => {
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
    const targetYaml = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      targetYaml.replace("greeting: 你好", 'greeting: "<red>你好"'),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stderr || checked.stdout);
    const missingClose = (
      report.diagnostics as readonly Record<string, unknown>[]
    ).find(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-tags" &&
        diagnostic.code === "minimessage.tag-mismatch" &&
        (diagnostic.expected as Record<string, unknown>).closing === true,
    );
    assert.ok(missingClose, checked.stderr || checked.stdout);
    if (missingClose === undefined) {
      throw new Error("缺少原文显式结束标签差异");
    }
    assert.equal(
      (missingClose.expected as Record<string, unknown>).expectedCount,
      1,
    );
    assert.equal(
      (missingClose.actual as Record<string, unknown>).actualCount,
      0,
    );
    assert.equal(
      (
        (missingClose.expected as Record<string, unknown>)
          .positions as readonly unknown[]
      ).length,
      1,
    );
  });

  void it("同类颜色标签的嵌套次序改变时仍报告实际样式变化", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "<red><blue>Hello</blue></red>",
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
        `greeting: ${JSON.stringify("<blue><red>你好</red></blue>")}`,
      ),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stderr || checked.stdout);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.ok(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "minimessage-tags" &&
          diagnostic.code === "minimessage.tag-mismatch",
      ),
      checked.stderr || checked.stdout,
    );
  });

  void it("允许官方颜色、装饰和换行别名并允许样式标签换序", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "<red><bold>Hello</bold></red><newline>Next",
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
        'greeting: "<b><c:RED>你好</c></b><br>下一个"',
      ),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stderr || checked.stdout);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.deepEqual(
      diagnostics.filter(
        (diagnostic) => diagnostic.ruleId === "minimessage-tags",
      ),
      [],
      checked.stderr || checked.stdout,
    );
  });

  void it("按官方 resolver 参数语义规范化标签并递归保留可译参数", async (t) => {
    const source = [
      "<gradient:red:blue:-0.25>gradient</gradient>",
      "<transition:red:blue:-0.25>transition</transition>",
      "<click:run_command:'/lands claim'>点击</click>",
      "<hover:show_text:'Owner <bold>online</bold>'>hover</hover>",
      "<translate:lands.welcome:'Hello <red>land</red>'>",
      "<translate_or:lands.key:'Fallback':'argument'>",
      "<font:default>font</font>",
      "<selector:@a>",
      "<nbt:storage:lands:data:time>",
      "<pride>pride</pride>",
      "<shadow:red:0.5>shadow</shadow>",
      "<sprite:atlas:key>",
      "<head:123e4567-e89b-42d3-a456-426614174000>",
      "<rainbow:!2>rainbow</rainbow>",
      "<newline><reset>",
    ].join(" ");
    const equivalent = [
      "<gradient:#5555ff:#ff5555:0.75>渐变</gradient>",
      "<transition:#5555ff:#ff5555:0.75>切换</transition>",
      "<click:run_command:'/lands claim'>占领</click>",
      "<hover:show_text:'所有者 <b>在线</b>'>悬停</hover>",
      "<tr:lands.welcome:'你好 <c:#f55>领地</c>'>",
      "<tr_or:lands.key:'后备':'参数'>",
      "<font:minecraft:default>字体</font>",
      "<sel:@a>",
      "<data:storage:lands:data:time>",
      "<pride:pride>彩虹</pride>",
      "<shadow:#ff55557f>阴影</shadow>",
      "<sprite:minecraft:atlas:minecraft:key>",
      "<head:123e4567-e89b-42d3-a456-426614174000:true>",
      "<rainbow:!2>彩虹</rainbow>",
      "<br><reset>",
    ].join(" ");
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
        "greeting: 你好",
        `greeting: ${JSON.stringify(equivalent)}`,
      ),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stderr || checked.stdout);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.deepEqual(
      diagnostics.filter((diagnostic) =>
        String(diagnostic.ruleId).startsWith("minimessage."),
      ),
      [],
      checked.stderr || checked.stdout,
    );
  });

  void it("对官方 StandardTags 的全部 resolver 家族比较标签并定位遗漏", async (t) => {
    const source = [
      "<hover:show_text:'Owner <bold>online</bold>'>owner</hover>",
      '<click:run_command:"/lands claim">Claim</click>',
      "<red>color</red>",
      "<key:key.jump>",
      "<translate:chat.type.text:'Hello <red>land</red>'>",
      "<translate_or:lands.key:'Fallback <bold>text</bold>':'argument'>",
      "<insert:land-name>",
      "<font:default>font</font>",
      "<bold>decoration</bold>",
      "<gradient:red:blue>gradient</gradient>",
      "<rainbow:1>rainbow</rainbow>",
      "<reset>",
      "<newline>",
      "<transition:red:blue>",
      "<selector:@a>",
      "<score:owner:objective>",
      "<nbt:storage:lands:data:time>",
      "<pride:bi>pride</pride>",
      "<shadow:red:0.5>shadow</shadow>",
      "<sprite:atlas:key>",
      "<head:123e4567-e89b-42d3-a456-426614174000>",
    ].join(" ");
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
      target.replace("greeting: 你好", `greeting: ${JSON.stringify(source)}`),
    );
    const preserved = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const preservedReport = readReport(preserved.stderr || preserved.stdout);
    const preservedDiagnostics = preservedReport.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.deepEqual(
      preservedDiagnostics.filter((diagnostic) =>
        String(diagnostic.ruleId).startsWith("minimessage."),
      ),
      [],
      preserved.stderr || preserved.stdout,
    );

    const currentTarget = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      currentTarget.replace(/^  greeting:.*$/mu, '  greeting: "翻译"'),
    );
    const omitted = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    assert.equal(omitted.status, 1, omitted.stderr);
    const omittedReport = readReport(omitted.stderr || omitted.stdout);
    const omissions = (
      omittedReport.diagnostics as readonly Record<string, unknown>[]
    ).filter(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-tags" &&
        diagnostic.code === "minimessage.tag-mismatch",
    );
    const omittedNames = new Set(
      omissions.map((diagnostic) =>
        String((diagnostic.expected as Record<string, unknown>).tag),
      ),
    );
    assert.deepEqual(
      [...omittedNames].sort(),
      [
        "bold",
        "click",
        "color",
        "font",
        "gradient",
        "head",
        "hover",
        "insert",
        "key",
        "nbt",
        "newline",
        "pride",
        "rainbow",
        "reset",
        "score",
        "selector",
        "shadow",
        "sprite",
        "transition",
        "translate",
        "translate_or",
      ].sort(),
      omitted.stderr || omitted.stdout,
    );

    const additionProject = await createProject(t, { sourceGreeting: "Text" });
    const additionInitialized = runCli(
      "init",
      "--project",
      additionProject.directory,
      "--jar",
      additionProject.jarFile,
      "--output-format",
      "structured",
    );
    assert.equal(additionInitialized.status, 0, additionInitialized.stderr);
    const additionTargetPath = join(additionProject.directory, "lang/zh.yml");
    const additionTarget = await readFile(additionTargetPath, "utf8");
    await writeFile(
      additionTargetPath,
      additionTarget.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(source)}`,
      ),
    );
    const added = runCli(
      "check",
      "--project",
      additionProject.directory,
      "--output-format",
      "structured",
    );
    const addedReport = readReport(added.stderr || added.stdout);
    const additions = (
      addedReport.diagnostics as readonly Record<string, unknown>[]
    ).filter(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-tags" &&
        diagnostic.code === "minimessage.tag-mismatch",
    );
    const addedNames = new Set(
      additions.map((diagnostic) =>
        String((diagnostic.expected as Record<string, unknown>).tag),
      ),
    );
    assert.deepEqual(
      [...addedNames].sort(),
      [...omittedNames].sort(),
      added.stderr || added.stdout,
    );
    assert.ok(
      additions.every(
        (diagnostic) =>
          (diagnostic.expected as Record<string, unknown>).expectedCount ===
            0 &&
          Number((diagnostic.actual as Record<string, unknown>).actualCount) >
            0,
      ),
      added.stderr || added.stdout,
    );
  });

  void it("保留 Lands 条件块的聊天范围与内部标签上下文", async (t) => {
    const source =
      "<verbose><red>Verbose</red></verbose> <ingame><bold>Player</bold></ingame> <java><italic>Java</italic></java>";
    const target =
      "<verbose><c:#f55>详细</c></verbose> <ingame><b>玩家</b></ingame> <java><i>Java</i></java>";
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
    const targetYaml = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      targetYaml.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(target)}`,
      ),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stderr || checked.stdout);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.deepEqual(
      diagnostics.filter((diagnostic) =>
        String(diagnostic.ruleId).startsWith("minimessage."),
      ),
      [],
      checked.stderr || checked.stdout,
    );
    assert.equal(
      (
        (report.coverage as Record<string, unknown>)
          .unavailableCapabilities as readonly string[]
      ).some((capability) => capability.includes("Lands 控制")),
      false,
      checked.stderr || checked.stdout,
    );
  });

  void it("检测标签在不同 Lands 条件块之间移动", async (t) => {
    const source =
      "<verbose><red>verbose</red></verbose> <ingame>ingame</ingame>";
    const target = "<verbose>日志</verbose> <ingame><red>游戏</red></ingame>";
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
    const targetYaml = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      targetYaml.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(target)}`,
      ),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stderr || checked.stdout);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    const movedColor = diagnostics.filter(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-tags" &&
        diagnostic.code === "minimessage.tag-mismatch" &&
        JSON.stringify(diagnostic.expected).includes("#ff5555"),
    );
    assert.equal(movedColor.length, 2, checked.stderr || checked.stdout);
    assert.ok(
      movedColor.some((diagnostic) =>
        JSON.stringify(diagnostic.expected).includes('"name":"verbose"'),
      ),
      checked.stderr || checked.stdout,
    );
    assert.ok(
      movedColor.some((diagnostic) =>
        JSON.stringify(diagnostic.actual).includes('"name":"ingame"'),
      ),
      checked.stderr || checked.stdout,
    );
  });

  void it("只接受 Lands 消息起始的 title/actionbar/bossbar/noprefix 控制", async (t) => {
    const source =
      "<title:5:40:2><red>标题</red><subtitle><blue>副标题</blue><actionbar><bold>操作栏</bold>";
    const target =
      "<title><c:#f55>标题</c><subtitle><c:#55f>副标题</c><actionbar><b>操作栏</b>";
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
    const targetYaml = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      targetYaml.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(target)}`,
      ),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stderr || checked.stdout);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.deepEqual(
      diagnostics.filter((diagnostic) =>
        String(diagnostic.ruleId).startsWith("minimessage."),
      ),
      [],
      checked.stderr || checked.stdout,
    );

    await writeFile(
      targetPath,
      targetYaml.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify("标题<actionbar><red>移位</red>")}`,
      ),
    );
    const moved = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const movedReport = readReport(moved.stderr || moved.stdout);
    assert.ok(
      (movedReport.diagnostics as readonly Record<string, unknown>[]).some(
        (diagnostic) =>
          diagnostic.ruleId === "minimessage-tags" &&
          diagnostic.code === "minimessage.lands-control-invalid" &&
          diagnostic.origin === "target",
      ),
      moved.stderr || moved.stdout,
    );
  });

  void it("按消息前缀保留 actionbar、bossbar 和 noprefix 控制", async (t) => {
    const cases = [
      {
        source: "<actionbar><red>Operation</red>",
        target: "<actionbar><c:#f55>操作</c>",
      },
      {
        source: "<noprefix><bossbar:blue:segmented_10:12>Welcome",
        target: "<noprefix><bossbar:blue:segmented_10:12>欢迎",
      },
    ];
    for (const { source, target } of cases) {
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
      const targetYaml = await readFile(targetPath, "utf8");
      await writeFile(
        targetPath,
        targetYaml.replace(
          "greeting: 你好",
          `greeting: ${JSON.stringify(target)}`,
        ),
      );
      const checked = runCli(
        "check",
        "--project",
        project.directory,
        "--output-format",
        "structured",
      );
      const report = readReport(checked.stderr || checked.stdout);
      assert.deepEqual(
        (report.diagnostics as readonly Record<string, unknown>[]).filter(
          (diagnostic) =>
            String(diagnostic.ruleId).startsWith("minimessage.") &&
            diagnostic.ruleId !== "minimessage-syntax",
        ),
        [],
        checked.stderr || checked.stdout,
      );
    }

    const project = await createProject(t, {
      sourceGreeting: "<noprefix><bossbar:blue:segmented_10:12>Welcome",
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
        `greeting: ${JSON.stringify("欢迎<noprefix><bossbar:purple:segmented_10:12>")}`,
      ),
    );
    const changed = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const changedReport = readReport(changed.stderr || changed.stdout);
    assert.ok(
      (changedReport.diagnostics as readonly Record<string, unknown>[]).some(
        (diagnostic) =>
          diagnostic.ruleId === "minimessage-tags" &&
          diagnostic.code === "minimessage.lands-control-invalid" &&
          diagnostic.origin === "target",
      ),
      changed.stderr || changed.stdout,
    );
  });

  void it("按 Lands 8.9.2 GUI lore action、label、desc 和 indent 语义比较", async (t) => {
    const sourceLore = [
      "<action:claim><label><red>Claim</red></label></action>",
      "<action:bank><label><bold>Bank</bold></label><desc><gray>Details</gray></desc></action>",
      "<indent>Next",
    ];
    const equivalentLore = [
      "<action:claim><label><c:#f55>占领</c></label></action>",
      "<action:bank><label><b>银行</b></label><desc><gray>详情</gray></desc></action>",
      "<indent>下一项",
    ];
    const project = await createGuiProject(t, {
      name: "Selection",
      lore: sourceLore,
    });
    const configPath = join(project.directory, ".l10n/config.yml");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        'version: "8.0.1"',
        'version: "8.9.2"',
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
    assert.equal(initialized.status, 0, initialized.stderr);

    const targetPath = join(project.directory, "Locale/zh-CN_gui.yml");
    const writeTarget = async (lore: readonly string[]) => {
      await writeFile(
        targetPath,
        [
          "physical:",
          "  selection:",
          '    name: "选择"',
          "    lore:",
          ...lore.map((line) => `      - ${JSON.stringify(line)}`),
          "",
        ].join("\n"),
      );
    };
    await writeTarget(equivalentLore);
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stderr || checked.stdout);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.deepEqual(
      diagnostics.filter((diagnostic) =>
        String(diagnostic.ruleId).startsWith("minimessage."),
      ),
      [],
      checked.stderr || checked.stdout,
    );

    await writeTarget([
      "<action:claim><label>占领</label></action>",
      "<action:bank><label><red>银行</red></label><desc><gray>详情</gray></desc></action>",
      "<indent>下一项",
    ]);
    const moved = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const movedReport = readReport(moved.stderr || moved.stdout);
    const movedColors = (
      movedReport.diagnostics as readonly Record<string, unknown>[]
    ).filter(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-tags" &&
        diagnostic.code === "minimessage.tag-mismatch" &&
        JSON.stringify(diagnostic.expected).includes("#ff5555"),
    );
    assert.equal(movedColors.length, 2, moved.stderr || moved.stdout);
    assert.ok(
      movedColors.some((diagnostic) =>
        JSON.stringify(diagnostic.expected).includes('"action":"claim"'),
      ),
      moved.stderr || moved.stdout,
    );
    assert.ok(
      movedColors.some((diagnostic) =>
        JSON.stringify(diagnostic.actual).includes('"action":"bank"'),
      ),
      moved.stderr || moved.stdout,
    );
  });

  void it("GUI lore 的空行和重复行保留整体拼接的 newline 次数", async (t) => {
    const project = await createGuiProject(t, {
      name: "Selection",
      lore: ["<red>First</red>", "", "<red>First</red>"],
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
    await writeFile(
      join(project.directory, "Locale/zh-CN_gui.yml"),
      [
        "physical:",
        "  selection:",
        '    name: "选择"',
        "    lore:",
        `      - ${JSON.stringify("<red>第一</red>")}`,
        `      - ${JSON.stringify("<red>第一</red>")}`,
        "",
      ].join("\n"),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stderr || checked.stdout);
    assert.ok(
      (report.diagnostics as readonly Record<string, unknown>[]).some(
        (diagnostic) =>
          diagnostic.ruleId === "minimessage-tags" &&
          diagnostic.code === "minimessage.tag-mismatch" &&
          JSON.stringify(diagnostic.expected).includes('"tag":"newline"') &&
          JSON.stringify(diagnostic.expected).includes('"expectedCount":2') &&
          JSON.stringify(diagnostic.actual).includes('"actualCount":1'),
      ),
      checked.stderr || checked.stdout,
    );
  });

  void it("Lands 8.0.1 GUI lore desc 语义明确报告覆盖限制", async (t) => {
    const project = await createGuiProject(t, {
      name: "Selection",
      lore: ["<action:bank><desc>Details</desc></action>"],
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
    const coverage = report.coverage as Record<string, unknown>;
    assert.equal(coverage.complete, false);
    assert.match(
      JSON.stringify(coverage.unavailableCapabilities),
      /8\.0\.1 GUI lore action 没有 desc 模板语义/u,
      checked.stderr || checked.stdout,
    );
  });

  void it("在标签数量相同但结束标签交叉时报告无效嵌套", async (t) => {
    const source = "<red><bold>Hello</red></bold>";
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
      target.replace("greeting: 你好", `greeting: ${JSON.stringify(source)}`),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stderr || checked.stdout);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.ok(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "minimessage-tags" &&
          diagnostic.code === "minimessage.tag-nesting-invalid",
      ),
      checked.stderr || checked.stdout,
    );
  });

  void it("递归检查 translate 参数中的标签并允许翻译参数正文", async (t) => {
    const project = await createProject(t, {
      sourceGreeting: "<translate:chat.type.text:'Hello <red>land</red>'>",
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
        `greeting: ${JSON.stringify("<tr:chat.type.text:'你好 <blue>土地</blue>'>")}`,
      ),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stderr || checked.stdout);
    const diagnostics = report.diagnostics as readonly Record<
      string,
      unknown
    >[];
    assert.ok(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "minimessage-tags" &&
          diagnostic.code === "minimessage.tag-mismatch" &&
          JSON.stringify(diagnostic.expected).includes("#ff5555") &&
          JSON.stringify(diagnostic.actual).includes("actualCount"),
      ),
      checked.stderr || checked.stdout,
    );
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

  void it("语法和变量规则关闭时标签规则仍驱动共享解析", async (t) => {
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

    const configurationPath = join(project.directory, ".l10n/config.yml");
    const configuration = await readFile(configurationPath, "utf8");
    await writeFile(
      configurationPath,
      `${configuration}\nrules:\n  minimessage-syntax:\n    enabled: false\n  minimessage-variables:\n    enabled: false\n`,
    );
    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace("greeting: 你好", 'greeting: "翻译"'),
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
        (diagnostic) =>
          diagnostic.ruleId === "minimessage-tags" &&
          diagnostic.code === "minimessage.tag-mismatch",
      ),
      checked.stderr || checked.stdout,
    );
    assert.ok(
      (coverage.enabledRuleIds as string[]).includes("minimessage-tags"),
      checked.stderr || checked.stdout,
    );
    assert.ok(
      (coverage.disabledRuleIds as string[]).includes("minimessage-syntax") &&
        (coverage.disabledRuleIds as string[]).includes(
          "minimessage-variables",
        ),
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

  void it("支持的 Lands 条件不会被误报为扩展，未知 MiniMessage 标签仍显示限制", async (t) => {
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
    assert.equal(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.ruleId === "minimessage-tags" &&
          diagnostic.code === "minimessage.lands-control-invalid",
      ),
      false,
      structured.stderr || structured.stdout,
    );
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
      /自定义 MiniMessage 标签/u,
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

  void it("主题 token 与同样式颜色标签仍按不同标签种类比较", async (t) => {
    const project = await createProject(t, {
      theme: 'theme:\n  tokens:\n    regular: "<gray>"\n    accent: "<red>"\n',
      sourceGreeting: "<t:regular>Neutral</t> <t:accent>Accent</t>",
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
        `greeting: ${JSON.stringify("<gray>中性</gray> <red>强调</red>")}`,
      ),
    );
    const checked = runCli(
      "check",
      "--project",
      project.directory,
      "--output-format",
      "structured",
    );
    const report = readReport(checked.stderr || checked.stdout);
    const mismatches = (
      report.diagnostics as readonly Record<string, unknown>[]
    ).filter(
      (diagnostic) =>
        diagnostic.ruleId === "minimessage-tags" &&
        diagnostic.code === "minimessage.tag-mismatch",
    );
    assert.ok(
      mismatches.some((diagnostic) =>
        JSON.stringify(diagnostic.expected).includes('"tag":"t"'),
      ),
      checked.stderr || checked.stdout,
    );
    assert.ok(
      mismatches.some((diagnostic) =>
        JSON.stringify(diagnostic.expected).includes('"tag":"color"'),
      ),
      checked.stderr || checked.stdout,
    );
  });

  void it("正式 CLI 接受嵌套 hover、引号参数、转义和默认宽松闭合", async (t) => {
    const sourceGreeting =
      "<hover:show_text:'<t:regular>提示</t>'><red>正文 \\<字面></red></hover> <red>未显式闭合";
    const project = await createProject(t, {
      theme: 'theme:\n  tokens:\n    regular: "<gray>"\n',
      sourceGreeting,
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

    const targetPath = join(project.directory, "lang/zh.yml");
    const targetYaml = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      targetYaml.replace(
        "greeting: 你好",
        'greeting: "<color:red><gray><#00ff88><!b>正文"',
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
