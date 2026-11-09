import { defineQualityCheck } from "@lioni/lioni";

import type { JsonValue } from "#/json-value";
import type {
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import type { MiniMessageIncompleteFact } from "#/mini-message-model";
import { usesMiniMessage } from "#/minimessage";
import {
  dependenciesOf,
  findingForQuality,
  hasAvailableMiniMessageTranslation,
  hasMiniMessageDocuments,
  hasMiniMessageInput,
  issueForQuality,
  messageForCandidate,
  miniMessageQualityConfigurationSchema,
  outcome,
  qualityBasis,
  type MiniMessageCheckInput,
  type MiniMessageQualityObject,
} from "#/minimessage-quality";

function choosePrimaryThemeSourceKey(
  input: MiniMessageCheckInput,
): string | undefined {
  return dependenciesOf(input.dependencies)
    .messages.filter(usesMiniMessage)
    .filter(hasMiniMessageDocuments)
    .filter((message) =>
      hasAvailableMiniMessageTranslation(
        input,
        message.id,
        input.candidate.language,
      ),
    )
    .map(({ id }) => id)
    .sort()[0];
}

/** 缓存键覆盖实际读取的事实快照、依赖对象身份和目标语言，不按候选消息拆分。 */
function primaryThemeSourceKeyMemoKey(
  input: MiniMessageCheckInput,
): readonly unknown[] {
  return [input.facts, input.dependencies, input.candidate.language];
}

/** 借用 Lioni 提供的 QA 本轮缓存，在各检查和候选间复用选择，由框架于本轮结束时释放。 */
function primaryThemeSourceKey(
  input: MiniMessageCheckInput,
): string | undefined {
  return input.memo.memo(choosePrimaryThemeSourceKey, {
    key: primaryThemeSourceKeyMemoKey,
  })(input);
}

function relevantThemeIssues(
  input: MiniMessageCheckInput,
): readonly MiniMessageIncompleteFact[] {
  const dependencies = dependenciesOf(input.dependencies);
  const sourceKey = input.candidate.sourceKey;
  const projectIssueOwner = primaryThemeSourceKey(input);
  return [
    ...dependencies.readIssues,
    ...dependencies.projection.incompleteFacts,
  ].filter(
    (issue) =>
      (issue.message === undefined
        ? sourceKey === projectIssueOwner
        : issue.message.id === sourceKey) &&
      (issue.origin === "theme" ||
        issue.code.startsWith("minimessage.theme-") ||
        issue.code === "minimessage.java-unavailable" ||
        issue.code === "minimessage.result-missing" ||
        issue.code === "minimessage.parser-failed" ||
        issue.code === "minimessage.project-input-unavailable"),
  );
}

function themeBasis(input: MiniMessageCheckInput): JsonValue {
  const dependencies = dependenciesOf(input.dependencies);
  const message = messageForCandidate(dependencies, input.candidate.sourceKey);
  const projectIssueOwner = primaryThemeSourceKey(input);
  const themeFindings = dependencies.projection.themeFindings.filter(
    (finding) =>
      finding.message === undefined
        ? input.candidate.sourceKey === projectIssueOwner
        : finding.message.id === input.candidate.sourceKey,
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
    theme:
      dependencies.themeInput.theme === undefined
        ? null
        : {
            file: dependencies.themeInput.theme.file,
            source: dependencies.themeInput.theme.source,
          },
    themeFindings: themeFindings.map((finding) => ({
      code: finding.code,
      origin: finding.origin,
      location: finding.location,
      position: finding.position ?? null,
      reason: finding.reason,
      expected: finding.expected,
      actual: finding.actual,
    })),
    incomplete: relevantThemeIssues(input).map(
      ({ code, reason, location }) => ({
        code,
        reason,
        location: location ?? null,
      }),
    ),
  });
}

export const miniMessageThemeCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof miniMessageQualityConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "minimessage-theme",
  version: "2",
  configurationSchema: miniMessageQualityConfigurationSchema,
  configuration: {},
  fingerprintInput: themeBasis,
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
    const projectIssueOwner = primaryThemeSourceKey(input);
    const diagnostics = dependencies.projection.themeFindings
      .filter((finding) =>
        finding.message === undefined
          ? input.candidate.sourceKey === projectIssueOwner
          : finding.message.id === input.candidate.sourceKey,
      )
      .map((finding) => findingForQuality(finding, input.candidate));
    const issues = relevantThemeIssues(input).map((issue) =>
      issueForQuality(issue, input.candidate),
    );
    return outcome(
      issues.length === 0 ? "complete" : "incomplete",
      diagnostics,
      issues,
    );
  },
});
