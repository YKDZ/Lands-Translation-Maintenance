import assert from "node:assert/strict";
import { test } from "node:test";

import type { MiniMessageInputMessage } from "../../src/mini-message-model.ts";
import { inspectMiniMessageSpacing } from "../../src/minimessage-spacing.ts";
import { parseMiniMessages } from "../../src/minimessage.ts";

void test("间隔规则使用正式解析投影，保留变量、可见边界和格式适配语义", async () => {
  const cases = [
    {
      name: "主题标签透明，保留已有空格，发现变量右侧缺失",
      text: "<t:regular>你已成功为城镇<t:entity_land> <v:land></t>占领<t:regular_value>",
      expected: [["variable-boundary", "<v:land>", "占"]],
    },
    {
      name: "中英、数字、变量边界分别检查",
      text: "使用Lands插件, 最多10个区块. 城镇<v:land>占领",
      expected: [
        ["mixed-boundary", "用", "L"],
        ["mixed-boundary", "s", "插"],
        ["mixed-boundary", "多", "1"],
        ["mixed-boundary", "0", "个"],
        ["variable-boundary", "镇", "<v:land>"],
        ["variable-boundary", "<v:land>", "占"],
      ],
    },
    {
      name: "独立变量与字母、数字相邻也需要间隔，变量组合和技术符号不强制拆开",
      text: "A<v:value>1, <v:prefix><v:value>, /<v:cmd>, <v:value>%",
      expected: [
        ["variable-boundary", "A", "<v:value>"],
        ["variable-boundary", "<v:value>", "1"],
      ],
    },
    {
      name: "已有间隔、标点、数值和命令内部合法",
      text: "城镇 <v:land> 占领 10 个区块. 使用 Lands 插件: (<v:land>), <v:value>%; 1.5; 3/5; /<v:cmd>",
      expected: [],
    },
    {
      name: "点击元数据透明，命令参数不参与，悬浮提示独立检查",
      text: '<hover:show_text:"提示<v:player>">中<click:run_command:"/lands <v:cmd>suffix">Lands</click>文</hover>',
      expected: [
        ["mixed-boundary", "中", "L"],
        ["mixed-boundary", "s", "文"],
        ["variable-boundary", "示", "<v:player>"],
      ],
    },
    {
      name: "真实换行、MiniMessage 换行、标题和副标题均切断邻接",
      text: "中文\n10<br>中文<newline>10<title>中文<subtitle>10",
      expected: [],
    },
    {
      name: "Java 可见和隐藏后的邻接分别检查且不重复报告",
      text: "中<java>文</java>Lands",
      expected: [
        ["mixed-boundary", "文", "L"],
        ["mixed-boundary", "中", "L"],
      ],
    },
    {
      name: "旧颜色、格式、十六进制颜色及重置不代替空格",
      text: "&a城镇 &b<v:land>&r已完成. #aabbcc最多&x&f&f&0&0&0&010个区块",
      format: "legacy-color-minimessage" as const,
      expected: [
        ["variable-boundary", "<v:land>", "已"],
        ["mixed-boundary", "多", "1"],
        ["mixed-boundary", "0", "个"],
      ],
    },
    {
      name: "旧等级变量也是整体",
      text: "%level%级",
      format: "legacy-variable-minimessage" as const,
      expected: [["variable-boundary", "%level%", "级"]],
    },
    {
      name: "组合附加符及零宽字符不掩盖真实混排边界",
      text: "中e\u0301文, 中\u200b10",
      expected: [
        ["mixed-boundary", "中", "e"],
        ["mixed-boundary", "e", "文"],
        ["mixed-boundary", "中", "1"],
      ],
    },
    {
      name: "HTML 实体解码后两侧缺失分别保留，不因粗粒度位置而互相覆盖",
      text: "<div>中&#65;文</div>",
      format: "map-html-minimessage" as const,
      expected: [
        ["mixed-boundary", "中", "A"],
        ["mixed-boundary", "A", "文"],
      ],
    },
    {
      name: "HTML 行内样式透明，可译属性独立，结构属性和块间邻接不参与",
      text: '<div>中文<span title="中文English" class="中文English">Lands</span>中文</div><div>10</div>',
      format: "map-html-minimessage" as const,
      expected: [
        ["mixed-boundary", "文", "E"],
        ["mixed-boundary", "文", "L"],
        ["mixed-boundary", "s", "中"],
      ],
    },
  ];
  const messages: MiniMessageInputMessage[] = cases.map((entry, index) => ({
    id: String(index),
    sourceFile: "en.yml",
    targetFile: "zh.yml",
    path: [String(index)],
    category: "chat-string",
    format: entry.format ?? "minimessage",
    source: entry.text,
    target: entry.text,
    targetStatus: "present",
  }));
  const project = await parseMiniMessages({
    messages,
    resources: [],
    theme: {
      issues: [],
      theme: {
        file: "theme.yml",
        source:
          "theme:\n  tokens:\n    regular: '<gray>'\n    regular_value: '<yellow>'\n    entity_land: '<green>'\n",
      },
    },
  });
  for (const [index, entry] of cases.entries()) {
    const findings = project.translatableText
      .filter(
        (document) =>
          document.origin === "target" && document.message.id === String(index),
      )
      .flatMap((document) => {
        const parsed = project.documents.find(
          (candidate) =>
            candidate.origin === "target" &&
            candidate.message.id === document.message.id &&
            candidate.documentIndex === document.documentIndex,
        );
        assert.ok(parsed, entry.name);
        assert.equal(parsed.status, "parsed", entry.name);
        return inspectMiniMessageSpacing(document, parsed);
      });
    assert.deepEqual(
      findings.map(({ code, left, right }) => [code, left.value, right.value]),
      entry.expected,
      entry.name,
    );
    for (const finding of findings) {
      for (const atom of [finding.left, finding.right]) {
        if (atom.exact)
          assert.equal(
            entry.text.slice(atom.position.start, atom.position.end),
            atom.value,
            entry.name,
          );
      }
    }
  }
});
