import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonValue } from "../src/json-value.ts";
import {
  inspectLandsLanguageLoad,
  type LandsLanguageLoadResource,
} from "../src/lands-language-load.ts";

function gui(
  target: JsonValue,
  source: JsonValue = { gui: { main: {} } },
  definitions?: JsonValue,
): LandsLanguageLoadResource {
  return {
    file: "Locale/zh-CN_gui.yml",
    kind: "gui",
    status: "available",
    source,
    target,
    ...(definitions === undefined ? {} : { definitions }),
  };
}

void test("聊天加载按完整键集识别旧空壳和非空废弃字段，不展开列表或误删原文空映射", () => {
  const result = inspectLandsLanguageLoad([
    {
      file: "Locale/zh-CN.yml",
      kind: "chat",
      status: "available",
      source: { help: { current: "Help" }, entries: ["One"], optional: {} },
      target: {
        help: { current: "帮助", old: { nested: {} } },
        entries: ["第一项", "第二项"],
        optional: {},
        obsolete: "旧译文",
      },
    },
  ]);
  assert.deepEqual(
    result.findings.map(({ path, code }) => [path, code]),
    [
      [["help", "old"], "unused-value"],
      [["help", "old", "nested"], "unused-value"],
      [["obsolete"], "unused-value"],
    ],
  );
  assert.deepEqual(result.issues, []);
});

void test("GUI 重现废弃菜单、空物品与仅剩 Bedrock 覆盖的无槽位警告", () => {
  const result = inspectLandsLanguageLoad([
    gui({
      gui: {
        main: {
          items: {
            default: {
              refresh_removed: {},
              tribute: { bedrock: { detail: true } },
            },
          },
        },
        old_menu: { items: { default: { removed: {} } } },
      },
    }),
  ]);
  assert.deepEqual(
    result.findings.map(({ path, code }) => [path, code]),
    [
      [["gui", "main", "items", "default", "refresh_removed"], "invalid-slots"],
      [["gui", "main", "items", "default", "tribute"], "invalid-slots"],
      [["gui", "old_menu"], "unused-menu"],
    ],
  );
});

void test("槽位复用定义、公共模板与 patch 默认值，动态条目和合法自定义物品通过", () => {
  const root = gui(
    {
      common: { size: 45, items: { default: { refresh_back: { slots: 37 } } } },
      gui: {
        main: {
          items: {
            default: {
              refresh_back: {},
              entry_land: {},
              child_failure: {},
              button: { name: "按钮" },
            },
            custom: { own: { slots: 2 } },
            patches: { basic: { button: { material: "STONE" } } },
          },
        },
      },
    },
    { gui: { main: {} } },
    {
      gui: {
        main: {
          items: { default: { button: { slots: 1 } }, patches: { basic: {} } },
        },
      },
    },
  );
  const module: LandsLanguageLoadResource = {
    file: "Locale/Wars/zh-CN_gui.yml",
    kind: "gui",
    status: "available",
    source: { gui: { war: {} } },
    target: {
      gui: {
        war: { items: { default: { refresh_back: { slots: "invalid" } } } },
      },
    },
  };
  assert.deepEqual(inspectLandsLanguageLoad([root, module]).findings, []);
});

void test("槽位使用 1 起始的数值、列表、逗号分号和闭区间，混合输入中有有效段即可", () => {
  for (const slots of [
    1,
    45,
    "1-45",
    "1;2,3",
    [1, "3-5"],
    "bad;2",
    ["bad", 2],
  ]) {
    const result = inspectLandsLanguageLoad([
      gui({ gui: { main: { items: { custom: { button: { slots } } } } } }),
    ]);
    assert.deepEqual(result.findings, [], JSON.stringify(slots));
  }
  for (const slots of [
    0,
    46,
    "3-2",
    "0-1",
    "1-46",
    "",
    [],
    "bad",
    { order: "last" },
  ]) {
    const result = inspectLandsLanguageLoad([
      gui({ gui: { main: { items: { custom: { button: { slots } } } } } }),
    ]);
    assert.deepEqual(
      result.findings.map(({ code }) => code),
      ["invalid-slots"],
      JSON.stringify(slots),
    );
  }
});

void test("菜单大小向上归整为 9 的倍数并限制在 9 至 54", () => {
  const result = inspectLandsLanguageLoad([
    gui({
      gui: {
        main: {
          size: 10,
          items: {
            custom: {
              in_range: { slots: 18 },
              out_of_range: { slots: 19 },
            },
          },
        },
      },
    }),
  ]);
  assert.deepEqual(
    result.findings.map(({ path }) => path.at(-1)),
    ["out_of_range"],
  );
  assert.deepEqual(
    inspectLandsLanguageLoad([
      gui({
        gui: {
          main: { size: 100, items: { custom: { button: { slots: 54 } } } },
        },
      }),
    ]).findings,
    [],
  );
});

void test("资源读取失败报告未完成，缺少目标交给现有漏译职责，不猜测废弃项", () => {
  const resource: LandsLanguageLoadResource = {
    file: "Locale/zh-CN_gui.yml",
    kind: "gui",
    status: "unavailable",
    reason: "YAML 无法解析",
  };
  const result = inspectLandsLanguageLoad([
    resource,
    { file: "Locale/zh-CN.yml", kind: "chat", status: "missing" },
  ]);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.issues, [resource]);
});
