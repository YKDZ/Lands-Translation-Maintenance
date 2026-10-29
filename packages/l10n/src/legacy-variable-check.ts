import { defineQualityCheck } from "@lioni/lioni";

import type { JsonValue } from "#/json-value";
import type {
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import type {
  MiniMessageFinding,
  MiniMessageIncompleteFact,
  TranslatableTextDocument,
} from "#/mini-message-model";
import type {
  VariableContextPart,
  VariableOccurrence,
} from "#/mini-message-model";
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
import { compareVariableOccurrences } from "#/variable-comparison";

const legacyTitleVariables = ["level", "nation", "owner", "player"] as const;
const supportedLegacyTitleVariables = new Set(legacyTitleVariables);

function legacyVariableMessage(input: MiniMessageCheckInput) {
  const dependencies = dependenciesOf(input.dependencies);
  const message = messageForCandidate(dependencies, input.candidate.sourceKey);
  return message?.format === "legacy-variable-minimessage" &&
    hasAvailableMiniMessageTranslation(
      input,
      input.candidate.sourceKey,
      input.candidate.language,
    )
    ? message
    : undefined;
}

function legacyVariableIssues(
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
        code: "legacy-variable.document-unavailable",
        message,
        origin,
        location: {
          file: origin === "source" ? message.sourceFile : message.targetFile,
          path: message.path,
        },
        reason: "旧标题变量" + side + "的官方 MiniMessage 文档缺失或解析未完成",
      },
    ];
  });
  const textProjectionIssues = (["source", "target"] as const).flatMap(
    (origin) => {
      const document = dependencies.projection.translatableText.find(
        (candidate) =>
          candidate.message.id === sourceKey &&
          candidate.origin === origin &&
          candidate.documentIndex === 0 &&
          candidate.context.length === 0,
      );
      if (document !== undefined) return [];
      if (message === undefined) return [];
      const side = origin === "source" ? "原文" : "译文";
      return [
        {
          code: "legacy-variable.text-projection-unavailable",
          message,
          origin,
          location: {
            file: origin === "source" ? message.sourceFile : message.targetFile,
            path: message.path,
          },
          reason: "旧标题变量" + side + "正文投影缺失",
        },
      ];
    },
  );
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
          issue.code === "minimessage.project-input-unavailable")),
  );
  return [
    ...readIssues,
    ...selectedIssues,
    ...documentIssues,
    ...textProjectionIssues,
  ];
}

function textDocumentsForSide(
  input: MiniMessageCheckInput,
  message: NonNullable<ReturnType<typeof messageForCandidate>>,
  origin: "source" | "target",
): readonly TranslatableTextDocument[] {
  const dependencies = dependenciesOf(input.dependencies);
  return dependencies.projection.translatableText.filter(
    (document) =>
      document.message.id === message.id &&
      document.origin === origin &&
      document.documentIndex === 0 &&
      document.context.length === 0,
  );
}

function fieldContext(
  message: NonNullable<ReturnType<typeof messageForCandidate>>,
): VariableContextPart {
  return {
    kind: "field",
    identity: {
      surface: "chat",
      path: [...message.path],
    },
  };
}

function occurrencesForSide(
  input: MiniMessageCheckInput,
  message: NonNullable<ReturnType<typeof messageForCandidate>>,
  origin: "source" | "target",
): readonly VariableOccurrence[] {
  const context = fieldContext(message);
  return textDocumentsForSide(input, message, origin).flatMap((document) =>
    document.segments
      .filter(
        (segment) =>
          segment.kind === "variable" &&
          supportedLegacyTitleVariables.has(
            segment.value as (typeof legacyTitleVariables)[number],
          ),
      )
      .map((segment) => ({
        name: segment.value,
        context: [context, { kind: "body", identity: {} }],
        position: segment.position,
      })),
  );
}

function positionValues(
  positions: readonly NonNullable<VariableOccurrence["position"]>[],
): JsonValue {
  return positions.map(({ start, end }) => ({ start, end }));
}

function legacyVariableFindings(
  input: MiniMessageCheckInput,
  message: NonNullable<ReturnType<typeof messageForCandidate>>,
): readonly MiniMessageFinding[] {
  const source = occurrencesForSide(input, message, "source");
  const target = occurrencesForSide(input, message, "target");
  const findings: MiniMessageFinding[] = [];
  for (const difference of compareVariableOccurrences(source, target)) {
    const base = {
      name: difference.name,
      expectedCount: difference.expectedCount,
      actualCount: difference.actualCount,
      context: difference.context as unknown as JsonValue,
    };
    const location = { file: message.targetFile, path: message.path };
    if (difference.expectedCount > difference.actualCount) {
      findings.push({
        code: "legacy-variable.missing",
        message,
        origin: "target",
        location,
        reason: "旧变量 " + difference.name + " 在译文中遗漏或次数不足",
        expected: {
          ...base,
          remainingCount: difference.expectedCount - difference.actualCount,
          positions: positionValues(difference.expectedPositions),
        },
        actual: {
          ...base,
          positions: positionValues(difference.actualPositions),
        },
      });
    }
    if (difference.actualCount > difference.expectedCount) {
      findings.push({
        code: "legacy-variable.added",
        message,
        origin: "target",
        location,
        reason: "译文新增旧变量 " + difference.name + " 或出现次数过多",
        expected: {
          ...base,
          positions: positionValues(difference.expectedPositions),
        },
        actual: {
          ...base,
          addedCount: difference.actualCount - difference.expectedCount,
          positions: positionValues(difference.actualPositions),
        },
      });
    }
  }
  return findings;
}

function evidencePositions(
  occurrences: readonly VariableOccurrence[],
): JsonValue {
  return occurrences.map((occurrence) => ({
    name: occurrence.name,
    context: occurrence.context as unknown as JsonValue,
    position:
      occurrence.position === undefined
        ? null
        : {
            start: occurrence.position.start,
            end: occurrence.position.end,
          },
  }));
}

function legacyVariableBasis(input: MiniMessageCheckInput): JsonValue {
  const dependencies = dependenciesOf(input.dependencies);
  const message = messageForCandidate(dependencies, input.candidate.sourceKey);
  return qualityBasis({
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
    supportedVariables: legacyTitleVariables,
    sourceVariables:
      message === undefined
        ? []
        : evidencePositions(occurrencesForSide(input, message, "source")),
    targetVariables:
      message === undefined
        ? []
        : evidencePositions(occurrencesForSide(input, message, "target")),
    incomplete: legacyVariableIssues(input, input.candidate.sourceKey).map(
      ({ code, reason, location }) => ({
        code,
        reason,
        location: location ?? null,
      }),
    ),
  });
}

export const legacyVariableCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof miniMessageQualityConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "legacy-variable",
  version: "1",
  configurationSchema: miniMessageQualityConfigurationSchema,
  configuration: {},
  fingerprintInput: legacyVariableBasis,
  check(input) {
    const message = legacyVariableMessage(input);
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

    const issues = legacyVariableIssues(input, message.id);
    const diagnostics = legacyVariableFindings(input, message).map((finding) =>
      findingForQuality(finding, input.candidate),
    );
    return outcome(
      issues.length === 0 ? "complete" : "incomplete",
      diagnostics,
      issues.map((issue) => issueForQuality(issue, input.candidate)),
    );
  },
});
