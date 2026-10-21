import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateRules,
  type CheckRule,
  type ProjectView,
} from "@lands-l10n/l10n";

const sampleProject: ProjectView = {
  sourceLanguage: "en-US",
  targetLanguage: "zh-CN",
  resources: [{ path: "lang/en.yml", purpose: "chat-language" }],
  messages: [
    {
      id: "message-id",
      sourceFile: "lang/en.yml",
      targetFile: "lang/zh.yml",
      path: ["messages", "greeting"],
      category: "chat-string",
      source: "Hello",
      target: "你好",
    },
  ],
  targetMessages: [],
  fileIssues: [],
};

function finding(code: string) {
  return {
    code,
    location: { file: "lang/zh.yml", path: ["messages", "greeting"] },
    reason: "测试诊断",
    expected: "Hello",
    actual: "你好",
  } as const;
}

void describe("规则注册契约", () => {
  void it("规则顺序不改变结论，且一个规则不能改写其他规则看到的消息", () => {
    const observed: string[] = [];
    const rewrite: CheckRule = {
      id: "rewrite",
      defaultSeverity: "warning",
      evaluate(project) {
        (project.messages[0] as unknown as { source: string }).source =
          "Changed";
        return [];
      },
    };
    const inspect: CheckRule = {
      id: "inspect",
      defaultSeverity: "info",
      evaluate(project) {
        observed.push(project.messages[0]?.source as string);
        return [finding("sample.observed")];
      },
    };

    const first = evaluateRules(sampleProject, [rewrite, inspect]);
    const firstObservation = [...observed];
    observed.length = 0;
    const second = evaluateRules(sampleProject, [inspect, rewrite]);

    assert.deepEqual(firstObservation, ["Hello"]);
    assert.deepEqual(observed, ["Hello"]);
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.diagnostics.map((entry) => entry.code).sort(),
      ["rule.execution-failed", "sample.observed"].sort(),
    );
    assert.deepEqual(first.coverage.unsupportedRuleIds, ["rewrite"]);
    assert.equal(sampleProject.messages[0]?.source, "Hello");
  });

  void it("把严重级别与参数交给规则，并显式报告禁用及不支持的覆盖", () => {
    let received: unknown;
    const sample: CheckRule = {
      id: "sample",
      defaultSeverity: "error",
      evaluate(_project, context) {
        received = {
          severity: context.severity,
          parameters: context.parameters,
        };
        return [finding("sample.finding")];
      },
    };

    const evaluated = evaluateRules(sampleProject, [sample], {
      configuration: {
        sample: {
          severity: "warning",
          parameters: { maximum: 2 },
        },
        future: { enabled: true },
      },
    });

    assert.deepEqual(received, {
      severity: "warning",
      parameters: { maximum: 2 },
    });
    assert.equal(evaluated.diagnostics[0]?.severity, "warning");
    assert.deepEqual(evaluated.coverage.unsupportedRuleIds, ["future"]);
    assert.equal(evaluated.coverage.complete, false);

    const disabled = evaluateRules(sampleProject, [sample], {
      configuration: { sample: { enabled: false } },
    });
    assert.equal(disabled.diagnostics.length, 0);
    assert.deepEqual(disabled.coverage.disabledRuleIds, ["sample"]);
    assert.equal(disabled.coverage.complete, false);
  });
});
