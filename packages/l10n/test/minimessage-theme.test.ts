import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  captureMiniMessageTheme,
  validateMiniMessageThemeYaml,
} from "#/minimessage-theme";

void describe("MiniMessage 主题快照", () => {
  void it("只捕获唯一 theme.yml 的 UTF-8 原文，并只验证 YAML 可读性", () => {
    const source =
      'theme:\n  tokens:\n    unsafe: "<click:run_command:/test>"\n';
    const captured = captureMiniMessageTheme(
      [
        { path: "Locale/theme.yml", purpose: "configuration" },
        { path: "lang/en.yml", purpose: "chat-language" },
      ],
      new Map([["Locale/theme.yml", new TextEncoder().encode(source)]]),
    );

    assert.deepEqual(captured, {
      theme: { file: "Locale/theme.yml", source },
      ambiguousFiles: [],
      unavailableFiles: [],
    });
    assert.deepEqual(validateMiniMessageThemeYaml(captured.theme!), []);
  });

  void it("把重名主题与缺失或非 UTF-8 内容分别报告", () => {
    const resources = [
      { path: "Locale/theme.yml", purpose: "configuration" as const },
      { path: "other/theme.yml", purpose: "configuration" as const },
    ];

    assert.deepEqual(captureMiniMessageTheme(resources, new Map()), {
      ambiguousFiles: ["Locale/theme.yml", "other/theme.yml"],
      unavailableFiles: [],
    });
    assert.deepEqual(captureMiniMessageTheme([resources[0]!], new Map()), {
      ambiguousFiles: [],
      unavailableFiles: ["Locale/theme.yml"],
    });
    assert.deepEqual(
      captureMiniMessageTheme(
        [resources[0]!],
        new Map([["Locale/theme.yml", new Uint8Array([0xff])]]),
      ),
      {
        ambiguousFiles: [],
        unavailableFiles: ["Locale/theme.yml"],
      },
    );
  });

  void it("阻断重复键与语法错误", () => {
    const duplicate = validateMiniMessageThemeYaml({
      file: "Locale/theme.yml",
      source:
        "theme:\n  tokens:\n    regular: '<gray>'\n    regular: '<red>'\n",
    });
    const malformed = validateMiniMessageThemeYaml({
      file: "Locale/theme.yml",
      source: "theme: [\n",
    });

    assert.equal(duplicate[0]?.code, "yaml-duplicate-key");
    assert.equal(malformed[0]?.code, "yaml-invalid");
  });
});
