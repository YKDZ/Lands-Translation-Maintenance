import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { readFacts } from "@lioni/lioni";

import { createLandsConfig } from "../../lioni.config.ts";
import { loadMiniMessageQualityDependencies } from "../../src/minimessage-quality.ts";
import {
  createProject,
  createFormatProject,
  createGuiProject,
  readReport,
  runCli,
} from "../cli-fixtures.ts";

const packageDirectory = resolve(new URL("../..", import.meta.url).pathname);
const sourcePreparer = join(
  packageDirectory,
  "scripts/prepare-lioni-source.ts",
);

function diagnostics(report: Record<string, unknown>) {
  return report.diagnostics as readonly Record<string, unknown>[];
}

function initAndCheck(project: { directory: string; jarFile: string }) {
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
  return { checked, report: readReport(checked.stdout || checked.stderr) };
}

function initialize(project: { directory: string; jarFile: string }) {
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
}

async function inspectFormatProjection(project: {
  readonly directory: string;
  readonly jarFile: string;
}) {
  const maintenanceDirectory = join(project.directory, ".lioni");
  const configPath = join(maintenanceDirectory, "lioni.config.ts");
  await mkdir(maintenanceDirectory, { recursive: true });
  await writeFile(
    configPath,
    [
      'import { createLandsConfig } from "@lands-l10n/l10n/lioni.config";',
      "",
      "export default createLandsConfig(import.meta.url);",
      "",
    ].join("\n"),
  );
  const scopedPackageDirectory = join(
    project.directory,
    "node_modules/@lands-l10n",
  );
  await mkdir(scopedPackageDirectory, { recursive: true });
  await symlink(packageDirectory, join(scopedPackageDirectory, "l10n"), "dir");

  const prepared = spawnSync(
    process.execPath,
    [
      "--conditions=source",
      sourcePreparer,
      "--jar",
      project.jarFile,
      "--config",
      configPath,
    ],
    { cwd: project.directory, encoding: "utf8" },
  );
  assert.equal(prepared.status, 0, prepared.stderr);

  const entryUrl = pathToFileURL(configPath);
  const facts = await readFacts(createLandsConfig(entryUrl));
  return loadMiniMessageQualityDependencies(entryUrl, facts);
}

void describe("地图 HTML 与旧格式正式检查", () => {
  void it("正式检查向只读规则提供分开的正文、变量、命令、结构与换行片段", async (t) => {
    const input =
      "<div>前 <click:run_command:/lands claim>认领<v:land></click> 后<br/>完成</div>";
    const project = await createFormatProject(t, {
      mapDescription: input,
      targetMapDescription: input,
      sourceVersion: "8.9.2",
    });
    initialize(project);
    const view = await inspectFormatProjection(project);
    const document = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "source" &&
        entry.segments.some((segment) => segment.kind === "command"),
    );
    assert.ok(document);
    const segments = document.segments;
    const commandIndex = segments.findIndex(
      (segment) => segment.kind === "command",
    );
    const commandBody = segments.find(
      (segment) => segment.kind === "text" && segment.value === "认领",
    );

    assert.ok(document.path.includes("description"));
    assert.ok(commandIndex >= 0);
    assert.equal(segments[commandIndex - 1]?.value, "前 ");
    assert.equal(segments[commandIndex + 1]?.value, "认领");
    assert.ok(commandBody?.context.some((frame) => frame.name === "click"));
    assert.ok(
      segments.some(
        (segment) => segment.kind === "variable" && segment.value === "land",
      ),
    );
    assert.ok(
      segments.some(
        (segment) => segment.kind === "structure" && segment.value === "/click",
      ),
    );
    assert.ok(segments.some((segment) => segment.kind === "boundary"));
    assert.equal(segments.at(-1)?.value, "完成");
  });

  void it("正式解析把 translate_or 的纯字符串 fallback 作为独立片段提供给消费者", async (t) => {
    const input =
      "<lang_or:lands.key:'<v:owner> <red>fallback</red>':'<bold><v:land></bold>'>";
    const project = await createGuiProject(t, {
      name: "Land",
      lore: [input],
      sourceVersion: "8.9.2",
    });
    initialize(project);
    const view = await inspectFormatProjection(project);
    const document = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "source" &&
        entry.documentIndex === 0 &&
        entry.segments.some(
          (segment) =>
            segment.kind === "text" && segment.value.includes("fallback"),
        ),
    );

    assert.ok(document);
    const fallback = document.segments.find(
      (segment) =>
        segment.kind === "text" && segment.value.includes("fallback"),
    );
    assert.ok(fallback);
    assert.equal(fallback?.value, "<v:owner> <red>fallback</red>");
    assert.equal(
      input.slice(fallback?.position.start, fallback?.position.end),
      fallback?.raw,
    );
    assert.match(JSON.stringify(fallback?.context), /translate_or:fallback/u);
    assert.equal(
      document.segments.some(
        (segment) => segment.kind === "variable" && segment.value === "owner",
      ),
      false,
    );
    const targetDocument = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "target" &&
        entry.message.id === document.message.id &&
        entry.documentIndex === 0,
    );
    assert.ok(
      targetDocument?.segments.some(
        (segment) =>
          segment.kind === "text" &&
          segment.value === "<v:owner> <red>fallback</red>",
      ),
    );
    const argumentDocument = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "source" &&
        entry.message.id === document?.message.id &&
        entry.documentIndex > 0,
    );
    assert.ok(argumentDocument);
    assert.match(JSON.stringify(argumentDocument?.context), /translate_or:0/u);
    assert.ok(
      argumentDocument?.segments.some(
        (segment) => segment.kind === "variable" && segment.value === "land",
      ),
    );
    assert.equal(
      argumentDocument?.segments.some((segment) =>
        segment.value.includes("fallback"),
      ),
      false,
    );
  });

  void it("地图 HTML 正文的 fallback 通过正式规则输入保留嵌套上下文", async (t) => {
    const input =
      "<div><lang_or:lands.key:'<v:owner> <red>fallback</red>'></div>";
    const project = await createFormatProject(t, {
      sourceVersion: "8.9.2",
      mapDescription: input,
      targetMapDescription: input,
    });
    initialize(project);
    const view = await inspectFormatProjection(project);
    const document = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "source" &&
        entry.documentIndex === 0 &&
        entry.path.join(".").includes("dynmap.land.description"),
    );
    const fallback = document?.segments.find(
      (segment) =>
        segment.kind === "text" && segment.value.includes("fallback"),
    );

    assert.ok(fallback);
    assert.equal(fallback?.value, "fallback");
    assert.match(JSON.stringify(fallback?.context), /html-element/u);
    assert.match(JSON.stringify(fallback?.context), /translate_or:fallback/u);
    assert.match(JSON.stringify(fallback?.context), /red/u);
    assert.equal(
      document?.segments.some(
        (segment) => segment.kind === "variable" && segment.value === "owner",
      ),
      false,
    );
    const targetDocument = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "target" &&
        entry.path.join(".").includes("dynmap.land.description") &&
        entry.documentIndex === 0,
    );
    assert.ok(
      targetDocument?.segments.some(
        (segment) => segment.kind === "text" && segment.value === "fallback",
      ),
    );
  });

  void it("正式只读投影保留嵌套 hover 与正文中的同名未知标签位置", async (t) => {
    const source =
      "<hover:show_text:'<future:nested>n</future>'>X</hover> <future:body>b</future>";
    const project = await createProject(t, { sourceGreeting: source });
    initialize(project);
    const targetPath = join(project.directory, "lang/zh.yml");
    const target = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      target.replace("greeting: 你好", `greeting: ${JSON.stringify(source)}`),
    );

    const view = await inspectFormatProjection(project);
    const greeting = view.messages.find(
      (message) => message.path.join(".") === "messages.greeting",
    );
    assert.ok(greeting);
    const occurrences = view.projection.syntaxFindings.filter(
      (finding) =>
        finding.message?.id === greeting.id &&
        finding.origin === "source" &&
        finding.code === "minimessage.tag-unknown",
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
        .map(({ position }) => position?.start)
        .sort((left, right) => (left ?? 0) - (right ?? 0)),
      expectedPositions,
    );
    const nested = occurrences.filter(
      ({ position }) =>
        (position?.start ?? Infinity) < source.indexOf(">X</hover>"),
    );
    assert.equal(nested.length, 2);
    assert.ok(
      nested.every((finding) => {
        const actual = finding.actual as Record<string, unknown>;
        return Number(actual.documentIndex) > 0;
      }),
    );
  });

  void it("正文配对不唯一时保留带来源位置的不完整事实", async (t) => {
    const source =
      "<click:run_command:/say hello><hover:show_text:'a'>甲</hover><hover:show_text:'b'>乙</hover></click>";
    const target =
      "<click:run_command:/say hello><hover:show_text:'译文'>丙</hover></click>";
    const project = await createProject(t, { sourceGreeting: source });
    initialize(project);
    const targetPath = join(project.directory, "lang/zh.yml");
    const targetYaml = await readFile(targetPath, "utf8");
    await writeFile(
      targetPath,
      targetYaml.replace(
        "greeting: 你好",
        `greeting: ${JSON.stringify(target)}`,
      ),
    );

    const view = await inspectFormatProjection(project);
    const greeting = view.messages.find(
      (message) => message.path.join(".") === "messages.greeting",
    );
    assert.ok(greeting);
    const incomplete = view.pairing.incomplete.filter(
      (fact) =>
        fact.code === "minimessage.text-pair-not-unique" &&
        fact.message?.id === greeting.id,
    );
    assert.equal(incomplete.length, 3);
    assert.equal(
      incomplete.filter(({ origin }) => origin === "source").length,
      2,
    );
    assert.equal(
      incomplete.filter(({ origin }) => origin === "target").length,
      1,
    );
    assert.ok(
      incomplete.every(
        ({ location }) =>
          location?.file === "lang/en.yml" || location?.file === "lang/zh.yml",
      ),
    );
  });

  void it("官方 hover 参数限制保留实际位置而不伪造悬浮上下文", async (t) => {
    const cases = [
      "<hover:bogus:tip>X</hover>",
      "<hover:show_text>X</hover>",
      "<hover:bogus:tip><future:inner>正文</future></hover>",
    ];

    for (const source of cases) {
      const project = await createProject(t, { sourceGreeting: source });
      initialize(project);
      const targetPath = join(project.directory, "lang/zh.yml");
      const target = await readFile(targetPath, "utf8");
      await writeFile(
        targetPath,
        target.replace("greeting: 你好", `greeting: ${JSON.stringify(source)}`),
      );
      const view = await inspectFormatProjection(project);
      const greeting = view.messages.find(
        (message) => message.path.join(".") === "messages.greeting",
      );
      assert.ok(greeting);
      const unresolved = view.projection.syntaxFindings.filter((finding) => {
        const actual = finding.actual as Record<string, unknown>;
        return (
          finding.message?.id === greeting.id &&
          finding.origin === "source" &&
          finding.code === "minimessage.tag-unresolved" &&
          actual.tag === source.slice(0, source.indexOf(">") + 1)
        );
      });
      assert.equal(unresolved.length, 1, JSON.stringify(unresolved, null, 2));
      assert.equal(unresolved[0]?.position?.start, 0);
      const unresolvedActual = unresolved[0]?.actual;
      assert.ok(unresolvedActual && typeof unresolvedActual === "object");
      const context = (unresolvedActual as Record<string, unknown>)
        .context as readonly unknown[];
      assert.equal(
        context.some(
          (frame) => Array.isArray(frame) && frame[0] === "hover-text",
        ),
        false,
      );
    }
  });

  void it("按地图字段识别 HTML，允许实体、中文属性正文和纯句子 spawn", async (t) => {
    const project = await createFormatProject(t);
    const { checked, report } = initAndCheck(project);

    assert.equal(
      diagnostics(report).some((finding) =>
        String(finding.code).startsWith("minimessage.tag-"),
      ),
      false,
      checked.stderr || checked.stdout,
    );
    assert.equal(
      diagnostics(report).some((finding) =>
        String(finding.code).startsWith("map-html."),
      ),
      false,
      checked.stderr || checked.stdout,
    );
    assert.equal(
      JSON.stringify(report).includes(
        "地图 HTML 与 MiniMessage 混合字段尚未完成专用检查",
      ),
      false,
      checked.stderr || checked.stdout,
    );
  });

  void it("按实际 Nations 资源路径检查地图描述与首都 spawn", async (t) => {
    for (const sourceVersion of ["8.0.1", "8.9.2"]) {
      const nationDescription =
        '<div><a href=/keep title="Nation"><v:land></a> <v:level></div>';
      const targetNationDescription =
        '<div><a href=/drop title="联邦"><v:land></a> <v:level></div>';
      const capitalSpawn =
        "<div><a href=/spawn>Capital <v:public> /<v:cmd></a></div>";
      const targetCapitalSpawn =
        "<div><a href=/spawn>首都 <v:public> /<v:cmd></a></div>";
      const rootNationDescription = "<div><a href=/root-keep>Nation</a></div>";
      const targetRootNationDescription =
        "<div><a href=/root-drop>联邦</a></div>";
      const rootCapitalSpawn = "<div><a href=/root-spawn>Capital</a></div>";
      const targetRootCapitalSpawn = "<div><a href=/root-spawn>首都</a></div>";
      const project = await createFormatProject(t, {
        sourceVersion,
        nationsMapDescription: nationDescription,
        targetNationsMapDescription: targetNationDescription,
        nationsCapitalSpawn: capitalSpawn,
        targetNationsCapitalSpawn: targetCapitalSpawn,
        rootNationsMapDescription: rootNationDescription,
        targetRootNationsMapDescription: targetRootNationDescription,
        rootNationsCapitalSpawn: rootCapitalSpawn,
        targetRootNationsCapitalSpawn: targetRootCapitalSpawn,
      });
      const { checked, report } = initAndCheck(project);
      const view = await inspectFormatProjection(project);
      const findings = diagnostics(report);
      const nationsMapFindings = findings.filter((finding) => {
        const message = finding.message as
          | {
              readonly sourceFile?: string;
              readonly path?: readonly string[];
            }
          | undefined;
        return (
          message?.sourceFile === "Locale/Nations/en-US.yml" &&
          message.path?.[0] === "general" &&
          message.path?.[1] === "integration"
        );
      });
      const unknownHtmlTags = nationsMapFindings.filter(
        (finding) => finding.code === "minimessage.tag-unknown",
      );
      const hrefFinding = nationsMapFindings.find((finding) => {
        const message = finding.message as
          | { readonly path?: readonly string[] }
          | undefined;
        return (
          finding.code === "map-html.behavior-attribute-mismatch" &&
          JSON.stringify(message?.path) ===
            JSON.stringify([
              "general",
              "integration",
              "dynmap",
              "nation",
              "description",
            ])
        );
      });
      const rootNationMessage = [...view.messages.values()].find(
        (message) =>
          message.sourceFile === "Locale/Nations/en-US.yml" &&
          message.path.join(".") === "integration.dynmap.nation.description",
      );
      const rootCapitalMessage = [...view.messages.values()].find(
        (message) =>
          message.sourceFile === "Locale/Nations/en-US.yml" &&
          message.path.join(".") === "integration.dynmap.capital.spawn",
      );
      assert.deepEqual(unknownHtmlTags, [], checked.stderr || checked.stdout);
      assert.ok(hrefFinding, checked.stderr || checked.stdout);
      assert.equal(
        rootNationMessage?.format,
        undefined,
        "根级四段 Nations 路径不属于实际地图字段",
      );
      assert.equal(
        rootCapitalMessage?.format,
        undefined,
        "根级四段首都路径不属于实际地图字段",
      );
      assert.ok(
        view.projection.syntaxFindings.some(
          (finding) =>
            finding.code === "minimessage.tag-unknown" &&
            [rootNationMessage?.id, rootCapitalMessage?.id].includes(
              finding.message?.id,
            ),
        ),
        "根级四段 HTML 应回到普通 MiniMessage 检查",
      );
      assert.ok(
        view.projection.mapFindings.every(
          (finding) =>
            ![rootNationMessage?.id, rootCapitalMessage?.id].includes(
              finding.message?.id,
            ),
        ),
        "根级四段 HTML 不应进入地图检查",
      );
    }
  });

  void it("只接受地图调用实际提供的基础变量", async (t) => {
    const suppliedByBaseResolver = [
      "owner",
      "world",
      "x",
      "z",
      "level",
      "nation",
      "chunks",
      "chunks_max",
      "members",
      "members_max",
      "balance",
      "upkeep",
      "upkeep_next",
      "created_at",
      "taxes_next",
    ];
    const requiresPlayer = [
      "balance_player",
      "chunk_cost",
      "taxes",
      "player_chunks_used",
      "player_chunks",
    ];
    const variables = [...suppliedByBaseResolver, ...requiresPlayer];
    const source = `<div>${variables.map((name) => `<v:${name}>`).join(" ")}</div>`;

    for (const sourceVersion of ["8.0.1", "8.9.2"]) {
      const project = await createFormatProject(t, {
        sourceVersion,
        nationsMapDescription: source,
        targetNationsMapDescription: source,
      });
      const { checked, report } = initAndCheck(project);
      const findings = diagnostics(report).filter(
        (finding) => finding.code === "map-html.variable-unknown",
      );
      const unknownVariables = new Set(
        findings.map((finding) => {
          const actual = finding.actual as
            | { readonly variable?: string }
            | undefined;
          return actual?.variable;
        }),
      );

      assert.ok(
        suppliedByBaseResolver.every((name) => !unknownVariables.has(name)),
        checked.stderr || checked.stdout,
      );
      assert.ok(
        requiresPlayer.every((name) => unknownVariables.has(name)),
        checked.stderr || checked.stdout,
      );
    }
  });

  void it("诊断地图 HTML 中行为属性变化并定位到对应消息", async (t) => {
    const project = await createFormatProject(t, {
      targetMapDescription:
        '<div class="region" title="领地与石头">土地：<v:land></div>',
    });
    const { checked, report } = initAndCheck(project);
    const finding = diagnostics(report).find(
      (entry) => entry.code === "map-html.behavior-attribute-mismatch",
    );
    assert.equal(checked.status, 1);
    assert.ok(finding, checked.stderr || checked.stdout);
    assert.deepEqual(
      finding?.message && (finding.message as Record<string, unknown>).path,
      ["general", "integration", "dynmap", "land", "description"],
    );
    assert.match(JSON.stringify(finding?.expected), /land/u);
    assert.match(JSON.stringify(finding?.actual), /region/u);
  });

  void it("按官方 PlainText 结果检查插入 keybind 的地图 HTML", async (t) => {
    const source = `<div><key:'<a href=/keep title="Old">Land</a>'></div>`;
    const target = `<div><key:'<a href=/drop title="新">领地</a>'></div>`;
    const project = await createFormatProject(t, {
      sourceVersion: "8.9.2",
      mapDescription: source,
      targetMapDescription: target,
    });
    const { checked, report } = initAndCheck(project);
    const view = await inspectFormatProjection(project);
    const finding = diagnostics(report).find(
      (entry) => entry.code === "map-html.behavior-attribute-mismatch",
    );
    const actual = finding?.actual as
      | { readonly position?: { readonly start: number; readonly end: number } }
      | undefined;
    const expected = finding?.expected as
      | { readonly position?: { readonly start: number; readonly end: number } }
      | undefined;
    const sourceDocument = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "source" && entry.path.at(-1) === "description",
    );
    const targetDocument = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "target" && entry.path.at(-1) === "description",
    );

    assert.equal(checked.status, 1);
    assert.ok(finding, checked.stderr || checked.stdout);
    assert.ok(actual?.position);
    assert.ok(expected?.position);
    assert.equal(
      target.slice(actual.position.start, actual.position.end),
      "href=/drop",
    );
    assert.equal(
      source.slice(expected.position.start, expected.position.end),
      "href=/keep",
    );
    assert.ok(
      sourceDocument?.segments.some(
        (segment) =>
          segment.kind === "text" &&
          segment.value === "Land" &&
          segment.context.some(
            (frame) => frame.kind === "html-element" && frame.name === "a",
          ),
      ),
    );
    const sourceAnchor = sourceDocument?.segments
      .find((segment) => segment.kind === "text" && segment.value === "Land")
      ?.context.find(
        (frame) => frame.kind === "html-element" && frame.name === "a",
      );
    assert.deepEqual(sourceAnchor?.position, { start: 11, end: 45 });
    assert.ok(
      sourceDocument?.segments.some(
        (segment) =>
          segment.kind === "text" &&
          segment.value === "Old" &&
          segment.context.some(
            (frame) =>
              frame.kind === "html-attribute" && frame.name === "title",
          ),
      ),
    );
    assert.ok(
      targetDocument?.segments.some(
        (segment) =>
          segment.kind === "text" &&
          segment.value === "领地" &&
          segment.context.some(
            (frame) => frame.kind === "html-element" && frame.name === "a",
          ),
      ),
    );
    assert.ok(
      targetDocument?.segments.some(
        (segment) =>
          segment.kind === "text" &&
          segment.value === "新" &&
          segment.context.some(
            (frame) =>
              frame.kind === "html-attribute" && frame.name === "title",
          ),
      ),
    );
  });

  void it("按官方文本节点的转义结果检查地图并映射回原文", async (t) => {
    const source = "<div>\\<red>Land\\</red></div>";
    const target = "<div>\\<red>领地\\</red></div>";
    const project = await createFormatProject(t, {
      sourceVersion: "8.9.2",
      mapDescription: source,
      targetMapDescription: target,
    });
    const { report } = initAndCheck(project);
    const view = await inspectFormatProjection(project);
    const sourceDocument = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "source" && entry.path.at(-1) === "description",
    );
    const targetDocument = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "target" && entry.path.at(-1) === "description",
    );
    const sourceText = sourceDocument?.segments.find(
      (segment) => segment.kind === "text" && segment.value === "Land",
    );

    assert.equal(
      diagnostics(report).some(
        (entry) => entry.code === "map-html.structure-invalid",
      ),
      false,
    );
    assert.ok(sourceText);
    assert.equal(
      source.slice(sourceText.position.start, sourceText.position.end),
      "Land",
    );
    assert.ok(
      targetDocument?.segments.some(
        (segment) => segment.kind === "text" && segment.value === "领地",
      ),
    );
    assert.equal(
      sourceDocument?.segments.some(
        (segment) => segment.kind === "text" && segment.value.includes("\\"),
      ),
      false,
    );
  });

  void it("地图动态游戏组件明确降低静态可见文本覆盖", async (t) => {
    const project = await createFormatProject(t, {
      sourceVersion: "8.9.2",
      mapDescription: "<div><score:'Alex':'points'></div>",
      targetMapDescription: "<div><score:'Alex':'points'></div>",
    });
    const { report } = initAndCheck(project);
    const coverage = report.coverage as
      | {
          readonly complete: boolean;
          readonly unavailableCapabilities: readonly string[];
        }
      | undefined;

    assert.equal(coverage?.complete, false);
    assert.ok(
      coverage?.unavailableCapabilities.some((reason) =>
        reason.includes("依赖游戏运行时数据"),
      ),
    );
  });

  void it("普通聊天的动态结构不触发地图与旧变量的静态渲染限制", async (t) => {
    const project = await createFormatProject(t, {
      unrelatedText: "<score:'Alex':'points'>",
      targetUnrelatedText: "<score:'Alex':'points'>",
    });
    const { report } = initAndCheck(project);
    const coverage = report.coverage as
      | {
          readonly complete: boolean;
          readonly unavailableCapabilities: readonly string[];
        }
      | undefined;

    assert.equal(
      coverage?.unavailableCapabilities.some((reason) =>
        reason.includes("依赖游戏运行时数据"),
      ),
      false,
    );
  });

  void it("普通聊天只把按键、翻译键和选择器作为结构身份暴露", async (t) => {
    const input =
      "A <key:key.jump> <lang:lands.owner> <selector:@a> <lang_or:lands.owner:'Owner'> label";
    const project = await createFormatProject(t, {
      unrelatedText: input,
      targetUnrelatedText: input,
    });
    const { report } = initAndCheck(project);
    const view = await inspectFormatProjection(project);
    const document = view.projection.translatableText.find(
      (entry) => entry.origin === "source" && entry.path.at(-1) === "text",
    );

    assert.ok(document);
    assert.equal(
      diagnostics(report).some((entry) =>
        String(entry.code).startsWith("minimessage."),
      ),
      false,
    );
    for (const technicalValue of ["key.jump", "lands.owner", "@a"]) {
      assert.equal(
        document.segments.some(
          (segment) =>
            segment.kind === "text" && segment.value === technicalValue,
        ),
        false,
        `${technicalValue} 不应作为普通可译正文重复提供`,
      );
      assert.ok(
        document.segments.some(
          (segment) =>
            segment.kind === "structure" &&
            segment.value.includes(technicalValue),
        ),
        `${technicalValue} 应保留为结构身份`,
      );
    }
    const fallback = document.segments.find(
      (segment) => segment.kind === "text" && segment.value === "Owner",
    );
    assert.ok(fallback);
    assert.ok(
      fallback.context.some(
        (frame) =>
          frame.kind === "tag-argument" &&
          frame.name === "translate_or:fallback",
      ),
    );
  });

  void it("按 MiniMessage PlainText 后的地图 HTML fallback 检查链接属性", async (t) => {
    const target = "<div><lang_or:lands.key:'<a href=/drop>城镇</a>'></div>";
    const project = await createFormatProject(t, {
      sourceVersion: "8.9.2",
      mapDescription: "<div><lang_or:lands.key:'<a href=/keep>Land</a>'></div>",
      targetMapDescription: target,
    });
    const { checked, report } = initAndCheck(project);
    const view = await inspectFormatProjection(project);
    const finding = diagnostics(report).find(
      (entry) => entry.code === "map-html.behavior-attribute-mismatch",
    );
    const actual = finding?.actual as
      | { readonly position?: { readonly start: number; readonly end: number } }
      | undefined;
    const targetDocument = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "target" &&
        entry.path.join(".").includes("dynmap.land.description") &&
        entry.documentIndex === 0,
    );
    const body = targetDocument?.segments.find(
      (segment) =>
        segment.kind === "text" &&
        segment.value === "城镇" &&
        segment.context.some(
          (frame) =>
            frame.kind === "tag-argument" &&
            frame.name === "translate_or:fallback",
        ),
    );

    assert.equal(checked.status, 1);
    assert.ok(finding, checked.stderr || checked.stdout);
    assert.match(JSON.stringify(finding?.expected), /keep/u);
    assert.match(JSON.stringify(finding?.actual), /drop/u);
    assert.ok(actual?.position);
    assert.equal(
      target.slice(actual.position.start, actual.position.end),
      "href=/drop",
    );
    assert.ok(body);
    assert.equal(
      target.slice(body.position.start, body.position.end),
      body.raw,
    );
  });

  void it("地图 fallback 正文和可译属性可改写而保留行为属性", async (t) => {
    const source =
      "<div><lang_or:lands.key:'<a href=/keep title=Land>Land</a>'></div>";
    const target =
      "<div><lang_or:lands.key:'<a href=/keep title=城镇>城镇</a>'></div>";
    const project = await createFormatProject(t, {
      sourceVersion: "8.9.2",
      mapDescription: source,
      targetMapDescription: target,
    });
    const { checked, report } = initAndCheck(project);
    const view = await inspectFormatProjection(project);
    const targetDocument = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "target" &&
        entry.path.join(".").includes("dynmap.land.description") &&
        entry.documentIndex === 0,
    );
    const body = targetDocument?.segments.find(
      (segment) =>
        segment.kind === "text" &&
        segment.value === "城镇" &&
        segment.context.some(
          (frame) => frame.kind === "html-element" && frame.name === "a",
        ),
    );
    const title = targetDocument?.segments.find(
      (segment) =>
        segment.kind === "text" &&
        segment.value === "城镇" &&
        segment.context.some(
          (frame) => frame.kind === "html-attribute" && frame.name === "title",
        ),
    );

    assert.equal(checked.status, 1);
    assert.equal(
      diagnostics(report).some(
        (entry) => entry.code === "map-html.behavior-attribute-mismatch",
      ),
      false,
      checked.stderr || checked.stdout,
    );
    assert.ok(body);
    assert.ok(title);
    assert.equal(
      target.slice(title.position.start, title.position.end),
      title.raw,
    );
    assert.ok(
      body?.context.some(
        (frame) =>
          frame.kind === "tag-argument" &&
          frame.name === "translate_or:fallback",
      ),
    );
    assert.ok(
      title?.context.some(
        (frame) =>
          frame.kind === "tag-argument" &&
          frame.name === "translate_or:fallback",
      ),
    );
  });

  void it("映射 fallback 转义引号和反斜线后的 HTML 原文位置", async (t) => {
    const source = String.raw`<div><lang_or:lands.key:"<a href=\"/keep\" title=\"Old\\Path\">Land</a>"></div>`;
    const target = String.raw`<div><lang_or:lands.key:"<a href=\"/drop\" title=\"新\\路径\">城镇</a>"></div>`;
    const project = await createFormatProject(t, {
      sourceVersion: "8.9.2",
      mapDescription: source,
      targetMapDescription: target,
    });
    const { checked, report } = initAndCheck(project);
    const view = await inspectFormatProjection(project);
    const finding = diagnostics(report).find(
      (entry) => entry.code === "map-html.behavior-attribute-mismatch",
    );
    const actual = finding?.actual as
      | { readonly position?: { readonly start: number; readonly end: number } }
      | undefined;
    const expected = finding?.expected as
      | { readonly position?: { readonly start: number; readonly end: number } }
      | undefined;
    const sourceDocument = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "source" &&
        entry.path.join(".").includes("dynmap.land.description") &&
        entry.documentIndex === 0,
    );
    const targetDocument = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "target" &&
        entry.path.join(".").includes("dynmap.land.description") &&
        entry.documentIndex === 0,
    );
    const sourceBody = sourceDocument?.segments.find(
      (segment) => segment.kind === "text" && segment.value === "Land",
    );
    const sourceTitle = sourceDocument?.segments.find(
      (segment) =>
        segment.kind === "text" &&
        segment.value === "Old\\Path" &&
        segment.context.some(
          (frame) => frame.kind === "html-attribute" && frame.name === "title",
        ),
    );
    const body = targetDocument?.segments.find(
      (segment) => segment.kind === "text" && segment.value === "城镇",
    );
    const title = targetDocument?.segments.find(
      (segment) =>
        segment.kind === "text" &&
        segment.value === "新\\路径" &&
        segment.context.some(
          (frame) => frame.kind === "html-attribute" && frame.name === "title",
        ),
    );
    const anchor = body?.context.find(
      (frame) => frame.kind === "html-element" && frame.name === "a",
    );
    const sourceAnchor = sourceBody?.context.find(
      (frame) => frame.kind === "html-element" && frame.name === "a",
    );

    assert.equal(checked.status, 1);
    assert.ok(finding, checked.stderr || checked.stdout);
    assert.ok(actual?.position);
    assert.ok(expected?.position);
    assert.equal(
      target.slice(actual.position.start, actual.position.end),
      String.raw`href=\"/drop\"`,
    );
    assert.equal(
      source.slice(expected.position.start, expected.position.end),
      String.raw`href=\"/keep\"`,
    );
    assert.ok(sourceBody);
    assert.ok(sourceTitle);
    assert.ok(sourceAnchor);
    assert.equal(
      source.slice(sourceBody.position.start, sourceBody.position.end),
      "Land",
    );
    assert.equal(
      source.slice(sourceTitle.position.start, sourceTitle.position.end),
      String.raw`title=\"Old\\Path\"`,
    );
    assert.deepEqual(sourceAnchor.position, {
      start: source.indexOf(String.raw`<a href=\"/keep\"`),
      end: source.indexOf("</a>") + "</a>".length,
    });
    assert.ok(body);
    assert.ok(title);
    assert.ok(anchor);
    assert.equal(target.slice(body.position.start, body.position.end), "城镇");
    assert.equal(
      target.slice(title.position.start, title.position.end),
      String.raw`title=\"新\\路径\"`,
    );
    assert.deepEqual(anchor.position, {
      start: target.indexOf(String.raw`<a href=\"/drop\"`),
      end: target.indexOf("</a>") + "</a>".length,
    });
  });

  void it("保留旧地图模板的属性占位符并报告 8.0.1 未供值限制", async (t) => {
    const template = '<div style="color: <v:land_color>;"><v:land></div>';
    const project = await createFormatProject(t, {
      sourceVersion: "8.0.1",
      mapDescription: template,
      targetMapDescription: template,
    });
    const { checked, report } = initAndCheck(project);
    const findings = diagnostics(report);

    assert.equal(
      findings.some((finding) => finding.code === "map-html.variable-unknown"),
      false,
      checked.stderr || checked.stdout,
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.code === "map-html.source-attribute-variable-literal" &&
          JSON.stringify(finding.actual).includes("resolverSuppliesVariable") &&
          JSON.stringify(finding.actual).includes("false"),
      ),
      checked.stderr || checked.stdout,
    );
  });

  void it("指出 8.9.2 虽提供 land_color 但 HTML 属性仍保留字面值", async (t) => {
    const template = '<div style="color: <v:land_color>;"><v:land></div>';
    const project = await createFormatProject(t, {
      sourceVersion: "8.9.2",
      mapDescription: template,
      targetMapDescription: template,
    });
    const { checked, report } = initAndCheck(project);

    assert.ok(
      diagnostics(report).some(
        (finding) =>
          finding.code === "map-html.source-attribute-variable-literal" &&
          JSON.stringify(finding.actual).includes("resolverSuppliesVariable") &&
          JSON.stringify(finding.actual).includes("true"),
      ),
      checked.stderr || checked.stdout,
    );
  });

  void it("诊断地图 HTML 不完整的元素结构", async (t) => {
    const project = await createFormatProject(t, {
      targetMapDescription: '<div class="land">土地：<v:land>',
    });
    const { checked, report } = initAndCheck(project);

    assert.equal(checked.status, 1);
    assert.ok(
      diagnostics(report).some(
        (finding) => finding.code === "map-html.structure-invalid",
      ),
      checked.stderr || checked.stdout,
    );
  });

  void it("拒绝地图正文中未由实际 resolver 提供的 v 变量", async (t) => {
    const project = await createFormatProject(t, {
      targetMapDescription: '<div class="land">领地：<v:person></div>',
    });
    const { checked, report } = initAndCheck(project);

    assert.equal(checked.status, 1);
    assert.ok(
      diagnostics(report).some(
        (finding) => finding.code === "map-html.variable-unknown",
      ),
      checked.stderr || checked.stdout,
    );
  });

  void it("在旧标题变量被 MiniMessage 样式切开时仍按运行时纯文本比较", async (t) => {
    const project = await createFormatProject(t, {
      legacyTitle: "Owned by %own<green>er%",
      targetLegacyTitle: "属于 %own<yellow>er%",
    });
    const { checked, report } = initAndCheck(project);

    assert.equal(
      diagnostics(report).some((finding) =>
        String(finding.code).startsWith("legacy-variable."),
      ),
      false,
      checked.stderr || checked.stdout,
    );
  });

  void it("按官方插入组件纯文本检查旧标题占位符", async (t) => {
    const source = "Owned by <key:'%owner%'>";
    const project = await createFormatProject(t, {
      legacyTitle: source,
      targetLegacyTitle: "属于<key:'某人'>",
    });
    const { checked, report } = initAndCheck(project);
    const view = await inspectFormatProjection(project);
    const finding = diagnostics(report).find(
      (entry) => entry.code === "legacy-variable.missing",
    );
    const expected = finding?.expected as
      | {
          readonly positions?: readonly {
            readonly start: number;
            readonly end: number;
          }[];
        }
      | undefined;
    const sourceDocument = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "source" &&
        entry.path.join(".").includes("land.title.land.normal"),
    );

    assert.equal(checked.status, 1);
    assert.ok(finding, checked.stderr || checked.stdout);
    assert.equal(expected?.positions?.length, 1);
    const position = expected?.positions?.[0];
    assert.ok(position);
    assert.equal(source.slice(position.start, position.end), "%owner%");
    assert.ok(
      sourceDocument?.segments.some(
        (segment) => segment.kind === "variable" && segment.value === "owner",
      ),
    );
  });

  void it("把旧标题 fallback 纳入可译文本并连接跨样式变量", async (t) => {
    const source = "Owned by %own<green><lang_or:lands.key:'er% and property'>";
    const target = "属于%owner%及属性";
    const project = await createFormatProject(t, {
      legacyTitle: source,
      targetLegacyTitle: target,
    });
    const { checked, report } = initAndCheck(project);
    const view = await inspectFormatProjection(project);
    const sourceDocument = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "source" &&
        entry.path.join(".").includes("land.title.land.normal"),
    );
    const targetDocument = view.projection.translatableText.find(
      (entry) =>
        entry.origin === "target" &&
        entry.path.join(".").includes("land.title.land.normal"),
    );
    const sourceVariable = sourceDocument?.segments.find(
      (segment) => segment.kind === "variable" && segment.value === "owner",
    );

    assert.equal(
      diagnostics(report).some((finding) =>
        String(finding.code).startsWith("legacy-variable."),
      ),
      false,
      checked.stderr || checked.stdout,
    );
    assert.ok(sourceVariable);
    assert.equal(
      source.slice(sourceVariable.position.start, sourceVariable.position.end),
      sourceVariable.raw,
    );
    assert.ok(
      sourceDocument?.segments.some(
        (segment) =>
          segment.kind === "text" &&
          segment.value === " and property" &&
          segment.context.some(
            (frame) =>
              frame.kind === "tag-argument" &&
              frame.name === "translate_or:fallback",
          ),
      ),
    );
    assert.ok(
      targetDocument?.segments.some(
        (segment) => segment.kind === "variable" && segment.value === "owner",
      ),
    );
  });

  void it("在旧标题 fallback 遗漏运行时变量时报告准确位置", async (t) => {
    const source = "<lang_or:lands.key:'Owned by %owner%'>";
    const project = await createFormatProject(t, {
      legacyTitle: source,
      targetLegacyTitle: "<lang_or:lands.key:'属于某人'>",
    });
    const { checked, report } = initAndCheck(project);
    const finding = diagnostics(report).find(
      (entry) => entry.code === "legacy-variable.missing",
    );
    const expected = finding?.expected as
      | {
          readonly positions?: readonly {
            readonly start: number;
            readonly end: number;
          }[];
        }
      | undefined;

    assert.equal(checked.status, 1);
    assert.ok(finding, checked.stderr || checked.stdout);
    assert.equal(expected?.positions?.length, 1);
    const position = expected?.positions?.[0];
    assert.ok(position);
    assert.equal(source.slice(position.start, position.end), "%owner%");
  });

  void it("只在已验证的旧标题字段比较占位符且复用变量身份诊断", async (t) => {
    const project = await createFormatProject(t, {
      legacyTitle: "Owned by %owner%, %player%",
      targetLegacyTitle: "属于%owner%，普通文字%person%",
    });
    const { checked, report } = initAndCheck(project);
    const findings = diagnostics(report);

    assert.equal(checked.status, 1);
    assert.ok(
      findings.some((entry) => entry.code === "legacy-variable.missing"),
      checked.stderr || checked.stdout,
    );
    assert.equal(
      findings.some((entry) => JSON.stringify(entry).includes("person")),
      false,
    );
  });

  void it("不因普通聊天字符串含 HTML 或旧占位符外形而套用地图/旧变量规则", async (t) => {
    const project = await createFormatProject(t, {
      unrelatedText: '<div class="note">%owner%</div>',
      targetUnrelatedText: '<div class="note">%owner%</div>',
    });
    const { report } = initAndCheck(project);
    const findings = diagnostics(report);
    const view = await inspectFormatProjection(project);
    const unrelatedMessage = view.messages.find(
      (message) => message.path.join(".") === "general.unrelated.text",
    );
    assert.ok(unrelatedMessage);
    const unrelatedTag = view.projection.syntaxFindings.find(
      (finding) =>
        finding.message?.id === unrelatedMessage?.id &&
        finding.code === "minimessage.tag-unknown",
    );

    assert.ok(unrelatedTag, JSON.stringify(view.projection, null, 2));
    const message = unrelatedTag.message as
      | { readonly path?: unknown }
      | undefined;
    assert.deepEqual(message?.path, ["general", "unrelated", "text"]);
    assert.equal(
      view.projection.mapFindings.some(
        (finding) => finding.message?.id === unrelatedMessage?.id,
      ),
      false,
    );
    assert.equal(
      findings.some((finding) =>
        String(finding.code).startsWith("legacy-variable."),
      ),
      false,
    );
  });

  void it("共享格式投影保留旧颜色码政策与来源版本限制的位置", async (t) => {
    const supported = await createGuiProject(t, {
      name: "工具",
      lore: ["说明"],
      sourceVersion: "8.0.1",
    });
    initialize(supported);
    const supportedTarget = join(supported.directory, "Locale/zh-CN_gui.yml");
    const target = await readFile(supportedTarget, "utf8");
    const modified = target.replace("name: 工具", 'name: "§a工具"');
    assert.notEqual(modified, target);
    await writeFile(supportedTarget, modified);

    const supportedProjection = await inspectFormatProjection(supported);
    const unsupportedColor = supportedProjection.projection.formatFindings.find(
      (finding) =>
        finding.code === "legacy-format.code-unsupported" &&
        finding.origin === "target",
    );
    assert.ok(unsupportedColor, JSON.stringify(supportedProjection, null, 2));
    assert.equal(unsupportedColor.location.file, "Locale/zh-CN_gui.yml");
    assert.deepEqual(unsupportedColor.location.path, [
      "physical",
      "selection",
      "name",
    ]);
    assert.deepEqual(unsupportedColor.position, { start: 0, end: 2 });

    const unknownVersion = await createGuiProject(t, {
      name: "&a工具",
      lore: ["&c说明"],
      sourceVersion: "8.9.3",
    });
    initialize(unknownVersion);
    const unknownProjection = await inspectFormatProjection(unknownVersion);
    assert.ok(
      unknownProjection.projection.formatFindings.some(
        (finding) =>
          finding.code === "legacy-format.source-version-unsupported" &&
          finding.origin === "source",
      ),
    );
    assert.ok(
      unknownProjection.projection.unavailableCapabilities.some((reason) =>
        reason.includes("来源 Lands 版本未受支持"),
      ),
    );
    assert.ok(
      unknownProjection.projection.formatFindings.some((finding) =>
        finding.reason.includes("未知 Lands 版本 8.9.3"),
      ),
    );
  });
});
