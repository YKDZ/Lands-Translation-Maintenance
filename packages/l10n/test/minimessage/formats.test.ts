import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  inspectProject,
  type CheckRule,
  type ProjectView,
} from "@lands-l10n/l10n";

import {
  createFormatProject,
  createGuiProject,
  readReport,
  runCli,
} from "../cli-fixtures.ts";

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

async function inspectTranslatableView(projectDirectory: string) {
  let observed: ProjectView | undefined;
  const observer: CheckRule = {
    id: "test-translatable-text-view",
    defaultSeverity: "info",
    requiredInputs: ["minimessage-parse"],
    evaluate(project) {
      observed = project;
      return [];
    },
  };
  const report = await inspectProject(projectDirectory, "check", [observer]);
  assert.equal(report.operation, "check");
  assert.deepEqual(report.coverage?.enabledRuleIds, [observer.id]);
  assert.ok(observed?.miniMessage);
  return observed;
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
    const view = await inspectTranslatableView(project.directory);
    const document = view.miniMessage?.translatableText.find(
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
    const view = await inspectTranslatableView(project.directory);
    const document = view.miniMessage?.translatableText.find(
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
    const targetDocument = view.miniMessage?.translatableText.find(
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
    const argumentDocument = view.miniMessage?.translatableText.find(
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
    const view = await inspectTranslatableView(project.directory);
    const document = view.miniMessage?.translatableText.find(
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
    const targetDocument = view.miniMessage?.translatableText.find(
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
    const view = await inspectTranslatableView(project.directory);
    const finding = diagnostics(report).find(
      (entry) => entry.code === "map-html.behavior-attribute-mismatch",
    );
    const actual = finding?.actual as
      | { readonly position?: { readonly start: number; readonly end: number } }
      | undefined;
    const expected = finding?.expected as
      | { readonly position?: { readonly start: number; readonly end: number } }
      | undefined;
    const sourceDocument = view.miniMessage?.translatableText.find(
      (entry) =>
        entry.origin === "source" && entry.path.at(-1) === "description",
    );
    const targetDocument = view.miniMessage?.translatableText.find(
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
    const view = await inspectTranslatableView(project.directory);
    const sourceDocument = view.miniMessage?.translatableText.find(
      (entry) =>
        entry.origin === "source" && entry.path.at(-1) === "description",
    );
    const targetDocument = view.miniMessage?.translatableText.find(
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

  void it("动态游戏组件明确降低静态可见文本覆盖", async (t) => {
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

  void it("按 MiniMessage PlainText 后的地图 HTML fallback 检查链接属性", async (t) => {
    const target = "<div><lang_or:lands.key:'<a href=/drop>城镇</a>'></div>";
    const project = await createFormatProject(t, {
      sourceVersion: "8.9.2",
      mapDescription: "<div><lang_or:lands.key:'<a href=/keep>Land</a>'></div>",
      targetMapDescription: target,
    });
    const { checked, report } = initAndCheck(project);
    const view = await inspectTranslatableView(project.directory);
    const finding = diagnostics(report).find(
      (entry) => entry.code === "map-html.behavior-attribute-mismatch",
    );
    const actual = finding?.actual as
      | { readonly position?: { readonly start: number; readonly end: number } }
      | undefined;
    const targetDocument = view.miniMessage?.translatableText.find(
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
    const view = await inspectTranslatableView(project.directory);
    const targetDocument = view.miniMessage?.translatableText.find(
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
    const view = await inspectTranslatableView(project.directory);
    const finding = diagnostics(report).find(
      (entry) => entry.code === "map-html.behavior-attribute-mismatch",
    );
    const actual = finding?.actual as
      | { readonly position?: { readonly start: number; readonly end: number } }
      | undefined;
    const expected = finding?.expected as
      | { readonly position?: { readonly start: number; readonly end: number } }
      | undefined;
    const sourceDocument = view.miniMessage?.translatableText.find(
      (entry) =>
        entry.origin === "source" &&
        entry.path.join(".").includes("dynmap.land.description") &&
        entry.documentIndex === 0,
    );
    const targetDocument = view.miniMessage?.translatableText.find(
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
    const view = await inspectTranslatableView(project.directory);
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
    const sourceDocument = view.miniMessage?.translatableText.find(
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
    const view = await inspectTranslatableView(project.directory);
    const sourceDocument = view.miniMessage?.translatableText.find(
      (entry) =>
        entry.origin === "source" &&
        entry.path.join(".").includes("land.title.land.normal"),
    );
    const targetDocument = view.miniMessage?.translatableText.find(
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
    const { checked, report } = initAndCheck(project);
    const findings = diagnostics(report);
    const unrelatedTag = findings.find(
      (finding) => finding.code === "minimessage.tag-unknown",
    );

    assert.ok(unrelatedTag, checked.stderr || checked.stdout);
    const message = unrelatedTag.message as
      | { readonly path?: unknown }
      | undefined;
    assert.deepEqual(message?.path, ["general", "unrelated", "text"]);
    assert.equal(
      findings.some((finding) => String(finding.code).startsWith("map-html.")),
      false,
    );
    assert.equal(
      findings.some((finding) =>
        String(finding.code).startsWith("legacy-variable."),
      ),
      false,
    );
  });
});
