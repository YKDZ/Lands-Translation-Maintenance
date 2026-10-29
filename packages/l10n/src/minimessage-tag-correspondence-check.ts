import { defineQualityCheck } from "@lioni/lioni";

import type {
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import type { MiniMessageIncompleteFact } from "#/mini-message-model";
import {
  dependenciesOf,
  findingForQuality,
  hasMiniMessageInput,
  issueForQuality,
  messageForCandidate,
  miniMessageQualityConfigurationSchema,
  outcome,
  qualityBasis,
  tagAnalysisForMessage,
  type MiniMessageCheckInput,
  type MiniMessageQualityObject,
} from "#/minimessage-quality";
import type { JsonValue } from "#/model";

function correspondenceBasis(input: MiniMessageCheckInput): JsonValue {
  const dependencies = dependenciesOf(input.dependencies);
  const message = messageForCandidate(dependencies, input.candidate.sourceKey);
  const analysis = tagAnalysisForMessage(
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
            category: message.category,
            scene: message.scene ?? null,
            format: message.format ?? null,
            source: message.source,
            target: input.candidate.content,
          },
    sourceVersion: analysis?.hasControls ? dependencies.sourceVersion : null,
    contexts: analysis?.controlContexts ?? [],
    themes: analysis?.themes ?? [],
    findings: analysis?.correspondence ?? [],
  });
}

function correspondenceIssues(
  input: MiniMessageCheckInput,
): readonly MiniMessageIncompleteFact[] {
  const dependencies = dependenciesOf(input.dependencies);
  const analysis = tagAnalysisForMessage(
    dependencies,
    input.candidate.sourceKey,
  );
  return [
    ...dependencies.readIssues,
    ...(analysis?.projectionIssues ?? []),
    ...(analysis?.controlIssues ?? []),
  ].filter(
    (issue) =>
      issue.message === undefined ||
      issue.message.id === input.candidate.sourceKey,
  );
}

export const miniMessageTagCorrespondenceCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof miniMessageQualityConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "minimessage-tag-correspondence",
  version: "1",
  configurationSchema: miniMessageQualityConfigurationSchema,
  configuration: {},
  fingerprintInput: correspondenceBasis,
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
    const analysis = tagAnalysisForMessage(
      dependencies,
      input.candidate.sourceKey,
    );
    if (analysis === undefined) {
      const message = messageForCandidate(
        dependencies,
        input.candidate.sourceKey,
      );
      const issue: MiniMessageIncompleteFact = {
        code: "minimessage.tag-analysis-missing",
        ...(message === undefined ? {} : { message }),
        reason: "源译标签对应分析没有返回当前消息结果",
      };
      return outcome(
        "incomplete",
        [],
        [issueForQuality(issue, input.candidate)],
      );
    }
    const issues = correspondenceIssues(input);
    return outcome(
      issues.length === 0 ? "complete" : "incomplete",
      analysis.correspondence.map((finding) =>
        findingForQuality(finding, input.candidate),
      ),
      issues.map((issue) => issueForQuality(issue, input.candidate)),
    );
  },
});
