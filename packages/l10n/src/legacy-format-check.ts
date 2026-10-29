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
  dependenciesOf,
  findingForQuality,
  hasAvailableMiniMessageTranslation,
  issueForQuality,
  messageForCandidate,
  miniMessageQualityConfigurationSchema,
  outcome,
  qualityBasis,
  type MiniMessageCheckInput,
  type MiniMessageQualityObject,
} from "#/minimessage-quality";

function legacyColorMessage(input: MiniMessageCheckInput) {
  const dependencies = dependenciesOf(input.dependencies);
  const message = messageForCandidate(dependencies, input.candidate.sourceKey);
  return (message?.format?.includes("legacy-color") ?? false) &&
    hasAvailableMiniMessageTranslation(
      input,
      input.candidate.sourceKey,
      input.candidate.language,
    )
    ? message
    : undefined;
}

function legacyFormatIssues(
  input: MiniMessageCheckInput,
  sourceKey: string,
): readonly MiniMessageIncompleteFact[] {
  const dependencies = dependenciesOf(input.dependencies);
  const message = messageForCandidate(dependencies, sourceKey);
  const documentIssues = (["source", "target"] as const).flatMap((origin) => {
    const document = dependencies.projection.documents.find(
      (candidate) =>
        candidate.message.id === sourceKey &&
        candidate.origin === origin &&
        candidate.parent === undefined &&
        candidate.documentIndex === 0,
    );
    if (document !== undefined && document.status === "parsed") return [];
    if (message === undefined) return [];
    const side = origin === "source" ? "原文" : "译文";
    return [
      {
        code: "legacy-format.document-unavailable",
        message,
        origin,
        location: {
          file: origin === "source" ? message.sourceFile : message.targetFile,
          path: message.path,
        },
        reason:
          document === undefined
            ? "旧颜色格式" + side + "的官方 MiniMessage 文档缺失"
            : "旧颜色格式" + side + "的 MiniMessage 解析未完成",
      },
    ];
  });
  const readIssues = dependencies.readIssues.filter(
    (issue) => issue.message === undefined || issue.message.id === sourceKey,
  );
  const selectedIssues = [
    ...dependencies.projection.incompleteFacts,
    ...dependencies.pairing.incomplete,
  ].filter(
    (issue) =>
      issue.message?.id === sourceKey ||
      (issue.message === undefined &&
        (issue.code === "minimessage.java-unavailable" ||
          issue.code === "minimessage.project-input-unavailable" ||
          (issue.code === "minimessage.projection-incomplete" &&
            issue.reason.includes("旧颜色格式")))),
  );
  return [...readIssues, ...selectedIssues, ...documentIssues];
}

function formatFindingsForMessage(
  input: MiniMessageCheckInput,
  sourceKey: string,
) {
  return dependenciesOf(input.dependencies).projection.formatFindings.filter(
    (finding) => finding.message?.id === sourceKey,
  );
}

function legacyFormatBasis(input: MiniMessageCheckInput): JsonValue {
  const dependencies = dependenciesOf(input.dependencies);
  const message = messageForCandidate(dependencies, input.candidate.sourceKey);
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
            format: message.format ?? null,
            source: message.source,
            target: input.candidate.content,
          },
    findings: formatFindingsForMessage(input, input.candidate.sourceKey).map(
      (finding) => ({
        code: finding.code,
        origin: finding.origin,
        location: finding.location,
        position: finding.position ?? null,
        reason: finding.reason,
        expected: finding.expected,
        actual: finding.actual,
      }),
    ),
    incomplete: legacyFormatIssues(input, input.candidate.sourceKey).map(
      ({ code, reason, location }) => ({
        code,
        reason,
        location: location ?? null,
      }),
    ),
  });
}

export const legacyFormatCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof miniMessageQualityConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "legacy-format",
  version: "1",
  configurationSchema: miniMessageQualityConfigurationSchema,
  configuration: {},
  fingerprintInput: legacyFormatBasis,
  check(input) {
    const message = legacyColorMessage(input);
    if (message === undefined) return outcome("not-applicable", [], []);
    if (input.sourceUnit === null) {
      return outcome(
        "incomplete",
        [],
        [
          issueForQuality(
            {
              code: "minimessage.source-unit-unavailable",
              message,
              reason: "原生 QA 候选没有对应 Lands 原文事实",
            },
            input.candidate,
          ),
        ],
      );
    }

    const issues = legacyFormatIssues(input, message.id);
    const diagnostics = formatFindingsForMessage(input, message.id).map(
      (finding) => ({
        ...findingForQuality(finding, input.candidate),
        severity:
          finding.code === "legacy-format.source-version-unsupported" ||
          finding.origin === "source"
            ? ("warning" as const)
            : ("error" as const),
      }),
    );
    return outcome(
      issues.length === 0 ? "complete" : "incomplete",
      diagnostics,
      issues.map((issue) => issueForQuality(issue, input.candidate)),
    );
  },
});
