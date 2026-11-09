import { defineQualityCheck } from "@lioni/lioni";

import type { JsonValue } from "#/json-value";
import type {
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import type { MiniMessageIncompleteFact } from "#/mini-message-model";
import {
  behaviorChecksForMessage,
  behaviorFindingForQuality,
  behaviorIssuesForMessage,
  dependenciesOf,
  hasMiniMessageInput,
  issueForQuality,
  messageForCandidate,
  miniMessageQualityConfigurationSchema,
  outcome,
  qualityBasis,
  type MiniMessageCheckInput,
  type MiniMessageQualityObject,
} from "#/minimessage-quality";

function clickBasis(input: MiniMessageCheckInput): JsonValue {
  const dependencies = dependenciesOf(input.dependencies);
  const message = messageForCandidate(dependencies, input.candidate.sourceKey);
  const checks = behaviorChecksForMessage(
    dependencies,
    input.candidate.sourceKey,
  );
  return qualityBasis({
    message:
      message === undefined
        ? null
        : {
            id: message.id,
            sourceFile: message.sourceFile,
            targetFile: message.targetFile,
            path: message.path,
            source: message.source,
            target: input.candidate.content,
          },
    findings: checks?.clicks ?? [],
    issues: checks?.issues ?? [],
  });
}

export const miniMessageClickBehaviorCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof miniMessageQualityConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "minimessage-click-behavior",
  version: "2",
  configurationSchema: miniMessageQualityConfigurationSchema,
  configuration: {},
  fingerprintInput: clickBasis,
  check(input) {
    const dependencies = dependenciesOf(input.dependencies);
    if (!hasMiniMessageInput(input, dependencies))
      return outcome("not-applicable", [], []);
    if (input.sourceUnit === null) {
      const issue: MiniMessageIncompleteFact = {
        code: "minimessage.source-unit-unavailable",
        reason: "原生 QA 候选没有对应 Lands 原文事实",
      };
      return outcome(
        "incomplete",
        [],
        [issueForQuality(issue, input.candidate)],
      );
    }
    const checks = behaviorChecksForMessage(
      dependencies,
      input.candidate.sourceKey,
    );
    if (checks === undefined) {
      const issue: MiniMessageIncompleteFact = {
        code: "minimessage.behavior-analysis-missing",
        reason: "共享变量及交互分析没有返回当前消息结果",
      };
      return outcome(
        "incomplete",
        [],
        [issueForQuality(issue, input.candidate)],
      );
    }
    const issues = behaviorIssuesForMessage(
      dependencies,
      input.candidate.sourceKey,
    );
    return outcome(
      issues.length === 0 ? "complete" : "incomplete",
      checks.clicks.map((finding) =>
        behaviorFindingForQuality(finding, input.candidate),
      ),
      issues.map((issue) => issueForQuality(issue, input.candidate)),
    );
  },
});
