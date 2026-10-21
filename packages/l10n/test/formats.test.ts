import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseMiniMessages } from "../src/minimessage.ts";
import type { ObservedMessage } from "../src/model.ts";
import { createFormatProject, readReport, runCli } from "./cli-fixtures.ts";

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

void describe("地图 HTML 与旧格式正式检查", () => {
  void it("向只读译文视图输出分开的正文、变量、命令、结构与换行片段", async () => {
    const input =
      "<div>前 <click:run_command:/lands claim>认领<v:land></click> 后<br/>完成</div>";
    const message: ObservedMessage = {
      id: "map-description",
      sourceFile: "Locale/en-US.yml",
      targetFile: "Locale/zh-CN.yml",
      path: ["general", "integration", "dynmap", "land", "description"],
      category: "chat-string",
      format: "map-html-minimessage",
      source: input,
      target: input,
      targetStatus: "present",
    };
    const parsed = await parseMiniMessages(
      [message],
      [{ path: message.sourceFile, purpose: "chat-language" }],
      undefined,
      "8.9.2",
    );
    const document = parsed.translatableText.find(
      (entry) => entry.origin === "target",
    );
    assert.ok(document);
    const segments = document.segments;
    const commandIndex = segments.findIndex(
      (segment) => segment.kind === "command",
    );
    const commandBody = segments.find(
      (segment) => segment.kind === "text" && segment.value === "认领",
    );

    assert.deepEqual(document.path, message.path);
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
