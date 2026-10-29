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
  type MiniMessageCheckInput,
  type MiniMessageQualityObject,
} from "#/minimessage-quality";
import type { JsonValue } from "#/json-value";

function relevantSyntaxIssues(
  input: MiniMessageCheckInput,
): readonly MiniMessageIncompleteFact[] {
  const dependencies = dependenciesOf(input.dependencies);
  const sourceKey = input.candidate.sourceKey;
  return [
    ...dependencies.readIssues,
    ...dependencies.projection.incompleteFacts,
  ].filter(
    (issue) => issue.message === undefined || issue.message.id === sourceKey,
  );
}

function syntaxBasis(input: MiniMessageCheckInput): JsonValue {
  const dependencies = dependenciesOf(input.dependencies);
  const message = messageForCandidate(dependencies, input.candidate.sourceKey);
  const syntaxFindings = dependencies.projection.syntaxFindings.filter(
    (finding) => finding.message?.id === input.candidate.sourceKey,
  );
  return qualityBasis({
    sourceVersion: dependencies.sourceVersion,
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
            target:
              input.candidate.content === undefined
                ? { state: "unavailable" }
                : input.candidate.content,
          },
    findings: syntaxFindings.map((finding) => ({
      code: finding.code,
      origin: finding.origin,
      location: finding.location,
      position: finding.position ?? null,
      reason: finding.reason,
      expected: finding.expected,
      actual: finding.actual,
    })),
    incomplete: relevantSyntaxIssues(input).map(
      ({ code, reason, location }) => ({
        code,
        reason,
        location: location ?? null,
      }),
    ),
  });
}

export const miniMessageSyntaxCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof miniMessageQualityConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "minimessage-syntax",
  version: "1",
  configurationSchema: miniMessageQualityConfigurationSchema,
  configuration: {},
  fingerprintInput: syntaxBasis,
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
    const diagnostics = dependencies.projection.syntaxFindings
      .filter((finding) => finding.message?.id === input.candidate.sourceKey)
      .map((finding) => findingForQuality(finding, input.candidate));
    const issues = relevantSyntaxIssues(input).map((issue) =>
      issueForQuality(issue, input.candidate),
    );
    return outcome(
      issues.length === 0 ? "complete" : "incomplete",
      diagnostics,
      issues,
    );
  },
});
