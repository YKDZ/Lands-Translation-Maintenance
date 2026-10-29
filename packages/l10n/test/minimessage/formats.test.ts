import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { readFacts } from "@lioni/lioni";

import { createLandsConfig } from "../../lioni.config.ts";
import { loadMiniMessageQualityDependencies } from "../../src/minimessage-quality.ts";
import {
  createProject,
  createFormatProject,
  createGuiProject,
  prepareLioniProject,
} from "../lioni-fixtures.ts";

async function inspectFormatProjection(project: {
  readonly directory: string;
  readonly jarFile: string;
}) {
  const configPath = await prepareLioniProject(project);
  const entryUrl = pathToFileURL(configPath);
  const facts = await readFacts(createLandsConfig(entryUrl));
  return loadMiniMessageQualityDependencies(entryUrl, facts);
}

void describe("地图与旧格式官方 MiniMessage 投影", () => {
  void it("正式检查向只读规则提供分开的正文、变量、命令、结构与换行片段", async (t) => {
    const input =
      "<div>前 <click:run_command:/lands claim>认领<v:land></click> 后<br/>完成</div>";
    const project = await createFormatProject(t, {
      mapDescription: input,
      targetMapDescription: input,
      sourceVersion: "8.9.2",
    });
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

  void it("按官方 PlainText 结果检查插入 keybind 的地图 HTML", async (t) => {
    const source = `<div><key:'<a href=/keep title="Old">Land</a>'></div>`;
    const target = `<div><key:'<a href=/drop title="新">领地</a>'></div>`;
    const project = await createFormatProject(t, {
      sourceVersion: "8.9.2",
      mapDescription: source,
      targetMapDescription: target,
    });
    const view = await inspectFormatProjection(project);
    const finding = view.projection.mapFindings.find(
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

    assert.ok(finding, JSON.stringify(view.projection.mapFindings, null, 2));
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
      view.projection.mapFindings.some(
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

  void it("普通聊天只把按键、翻译键和选择器作为结构身份暴露", async (t) => {
    const input =
      "A <key:key.jump> <lang:lands.owner> <selector:@a> <lang_or:lands.owner:'Owner'> label";
    const project = await createFormatProject(t, {
      unrelatedText: input,
      targetUnrelatedText: input,
    });
    const view = await inspectFormatProjection(project);
    const document = view.projection.translatableText.find(
      (entry) => entry.origin === "source" && entry.path.at(-1) === "text",
    );

    assert.ok(document);
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
    const view = await inspectFormatProjection(project);
    const finding = view.projection.mapFindings.find(
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

    assert.ok(finding, JSON.stringify(view.projection.mapFindings, null, 2));
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

    assert.equal(
      view.projection.mapFindings.some(
        (entry) => entry.code === "map-html.behavior-attribute-mismatch",
      ),
      false,
      JSON.stringify(view.projection.mapFindings, null, 2),
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
    const view = await inspectFormatProjection(project);
    const finding = view.projection.mapFindings.find(
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

    assert.ok(finding, JSON.stringify(view.projection.mapFindings, null, 2));
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

  void it("把旧标题 fallback 纳入可译文本并连接跨样式变量", async (t) => {
    const source = "Owned by %own<green><lang_or:lands.key:'er% and property'>";
    const target = "属于%owner%及属性";
    const project = await createFormatProject(t, {
      legacyTitle: source,
      targetLegacyTitle: target,
    });
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

  void it("共享格式投影保留旧颜色码政策与来源版本限制的位置", async (t) => {
    const supported = await createGuiProject(t, {
      name: "工具",
      lore: ["说明"],
      sourceVersion: "8.0.1",
    });
    const supportedTarget = join(supported.directory, "Locale/zh-CN_gui.yml");
    const target = await readFile(supportedTarget, "utf8");
    const modified = target.replace('name: "工具"', 'name: "§a工具"');
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
