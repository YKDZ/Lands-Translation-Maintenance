import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adaptLegacyMiniMessageInput } from "../src/legacy-format.ts";

void describe("Lands 旧颜色格式适配", () => {
  void it("转换颜色、格式、重置与十六进制代码", () => {
    const old = adaptLegacyMiniMessageInput("&a绿&l粗&r白 #ff00aa");
    const current = adaptLegacyMiniMessageInput(
      "&a绿&l粗&r白 &x&f&f&0&0&a&a §c红",
    );

    assert.equal(old?.input, "<green>绿<b>粗<!b><white>白 <#ff00aa>");
    assert.equal(
      current?.input,
      "<green>绿<b>粗<!b><white>白 <#ff00aa> <red>红",
    );
  });

  void it("保留旧文本位置边界并区分标签参数中的字面代码", () => {
    const input = '<span style="&a">\uD83D\uDE80 &b天</span>';
    const adapted = adaptLegacyMiniMessageInput(input);

    assert.equal(
      adapted?.input,
      '<span style="&a">\uD83D\uDE80 <aqua>天</span>',
    );
    assert.equal(
      adapted?.sourceOffsets.length,
      (adapted?.input.length ?? 0) + 1,
    );
    assert.equal(adapted?.sourceOffsets[0], 0);
    assert.equal(adapted?.sourceOffsets.at(-1), input.length);
    assert.equal(adapted?.exact, false);
  });

  void it("让旧格式合成的装饰闭合占零宽范围", () => {
    const adapted = adaptLegacyMiniMessageInput("&l&a绿色");

    assert.ok(adapted);
    assert.equal(adapted.input, "<b><!b><green>绿色");
    assert.equal(adapted.sourceOffsets[3], 2);
    assert.equal(adapted.sourceOffsets[7], 2);
    assert.equal(adapted.sourceOffsets[14], 4);
  });

  void it("保留相似普通文本并转换颜色代码", () => {
    const adapted = adaptLegacyMiniMessageInput("§a字面 &z普通");
    const escaped = adaptLegacyMiniMessageInput("\\&a颜色");
    assert.equal(adapted?.input, "<green>字面 &z普通");
    assert.deepEqual(adapted?.issues, []);
    assert.equal(escaped?.input, "\\<green>颜色");
  });
});
