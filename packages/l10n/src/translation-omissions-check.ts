import {
  defineQualityCheck,
  type QualityFinding,
  type QualityIssue,
  type SemanticEditCandidate,
} from "@lioni/lioni";

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
  hasAvailableMiniMessageTranslation,
  issueForQuality,
  messageForCandidate,
  miniMessageQualityConfigurationSchema,
  outcome,
  qualityBasis,
  type LandsFacts,
  type MiniMessageCheckInput,
  type MiniMessageQualityDependencies,
  type MiniMessageQualityObject,
} from "#/minimessage-quality";
import {
  miniMessageTextRuns,
  positionsForTextRun,
  type MiniMessageTextRun,
} from "#/minimessage-text-runs";
import { hasExplicitEmptyTranslation } from "#/translatable-text-pairing";
import { canonicalJson } from "#/value";

type LandsCandidate = SemanticEditCandidate<LandsJson>;

function associationFor(
  input: MiniMessageCheckInput,
): LandsFacts["associations"][number] | undefined {
  return input.facts.associations.find(
    ({ sourceKey, language }) =>
      sourceKey === input.candidate.sourceKey &&
      language === input.candidate.language,
  );
}

function sourceUnitFor(
  facts: LandsFacts,
  sourceKey: string,
): LandsFacts["source"]["units"][number] | undefined {
  return facts.source.units.find(({ key }) => key === sourceKey);
}

function matchedCandidateAssociation(
  facts: LandsFacts,
): LandsFacts["associations"][number] | undefined {
  return facts.associations.find((association) => {
    if (
      association.status !== "matched" ||
      association.translationIndexes.length !== 1
    ) {
      return false;
    }
    const translation = facts.translations.records.find(
      ({ index }) => index === association.translationIndexes[0],
    );
    return translation?.bodyAvailability === "available";
  });
}

function missingCandidateAssociation(
  facts: LandsFacts,
): LandsFacts["associations"][number] | undefined {
  return facts.associations.find((association) => {
    if (
      association.status !== "missing" ||
      association.coverageStatus !== "complete"
    ) {
      return false;
    }
    return (
      sourceUnitFor(facts, association.sourceKey)?.bodyAvailability ===
      "available"
    );
  });
}

/** 只为框架已确认缺失且原文正文可用的真实单元补充只读 QA 候选。 */
export function buildTranslationOmissionCandidates(input: {
  readonly facts: LandsFacts;
  readonly defaultCandidates: readonly LandsCandidate[];
}): readonly LandsCandidate[] {
  const units = new Map(
    input.facts.source.units.map((unit) => [unit.key, unit]),
  );
  const missingCandidates = input.facts.associations.flatMap((association) => {
    if (
      association.status !== "missing" ||
      association.coverageStatus !== "complete"
    ) {
      return [];
    }
    const sourceUnit = units.get(association.sourceKey);
    if (sourceUnit?.bodyAvailability !== "available") return [];
    return [
      {
        sourceKey: association.sourceKey,
        language: association.language,
        content: sourceUnit.unit.source,
      },
    ];
  });
  return [...input.defaultCandidates, ...missingCandidates];
}

function objectForCandidate(
  candidate: MiniMessageCheckInput["candidate"],
  role: LandsUnit["context"]["role"] = "message",
  code?: string,
): MiniMessageQualityObject {
  return {
    kind: role === "structure" ? "lands-structure" : "lands-message",
    key: candidate.sourceKey,
    language: candidate.language,
    ...(code === undefined ? {} : { code }),
  };
}

function finding(
  input: MiniMessageCheckInput,
  code: string,
  reason: string,
  file: string,
  path: readonly (string | number)[],
  expected: JsonValue,
  actual: JsonValue,
  position?: { readonly start: number; readonly end: number },
  role: LandsUnit["context"]["role"] = "message",
): QualityFinding<MiniMessageQualityObject> {
  const object = objectForCandidate(input.candidate, role, code);
  const location = {
    language: input.candidate.language,
    range: {
      file,
      path,
      ...(position === undefined ? {} : position),
    },
  };
  return {
    severity: code === "translation.missing" ? "error" : "warning",
    object,
    location,
    message: reason,
    evidence: [
      { role: "expected", object, location, value: expected },
      { role: "actual", object, location, value: actual },
    ],
  };
}

function associationIssues(
  input: MiniMessageCheckInput,
): readonly QualityIssue<MiniMessageQualityObject>[] {
  const owner =
    matchedCandidateAssociation(input.facts) ??
    missingCandidateAssociation(input.facts);
  if (
    owner?.sourceKey !== input.candidate.sourceKey ||
    owner.language !== input.candidate.language
  ) {
    return [];
  }
  return input.facts.associations.flatMap((association) => {
    if (
      association.status !== "conflict" &&
      association.status !== "unavailable"
    ) {
      return [];
    }
    const source = sourceUnitFor(input.facts, association.sourceKey);
    const location =
      source === undefined
        ? undefined
        : {
            language: association.language,
            range: {
              file: source.unit.context.targetFile,
              path: source.unit.context.path,
            },
          };
    const code =
      association.status === "conflict"
        ? "translation.association-conflict"
        : "translation.body-unavailable";
    const object = {
      kind:
        source?.unit.context.role === "structure"
          ? "lands-structure"
          : "lands-message",
      key: association.sourceKey,
      language: association.language,
    } satisfies MiniMessageQualityObject;
    const message =
      association.status === "conflict"
        ? "同一原文存在多个译文关联，无法判断漏译或执行正文检查"
        : "已关联的译文正文不可用，无法完成质量检查";
    return [
      {
        code,
        message,
        object,
        ...(location === undefined ? {} : { location }),
      },
    ];
  });
}

function documentRuns(
  dependencies: MiniMessageQualityDependencies,
  document: Parameters<typeof miniMessageTextRuns>[1],
): readonly MiniMessageTextRun[] {
  return miniMessageTextRuns(dependencies.projection, document);
}

function indexedRuns(runs: readonly MiniMessageTextRun[]) {
  const occurrences = new Map<string, number>();
  return runs.map((run) => {
    const occurrence = occurrences.get(run.contextKey) ?? 0;
    occurrences.set(run.contextKey, occurrence + 1);
    return { key: `${run.contextKey}\0${occurrence}`, run };
  });
}

function runPosition(
  run: MiniMessageTextRun,
): { readonly start: number; readonly end: number } | undefined {
  const positions = positionsForTextRun(run, 0, run.text.length);
  if (positions.length === 0) return undefined;
  return {
    start: Math.min(...positions.map(({ start }) => start)),
    end: Math.max(...positions.map(({ end }) => end)),
  };
}

function isTranslatableBody(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function relatedPairingIssues(
  dependencies: MiniMessageQualityDependencies,
  sourceKey: string,
): readonly MiniMessageIncompleteFact[] {
  return dependencies.pairing.incomplete.filter(
    ({ message }) => message?.id === sourceKey,
  );
}

function omissionsBasis(input: MiniMessageCheckInput): JsonValue {
  const dependencies = dependenciesOf(input.dependencies);
  const sourceKey = input.candidate.sourceKey;
  const pairs = dependencies.pairing.pairs
    .filter(({ sourceDocument }) => sourceDocument.message.id === sourceKey)
    .map(({ sourceDocument, targetDocument }) => ({
      source: sourceDocument,
      target: targetDocument,
    }));
  const issues = [
    ...relatedPairingIssues(dependencies, sourceKey),
    ...dependencies.projection.incompleteFacts.filter(
      ({ message }) => message?.id === sourceKey,
    ),
  ];
  return qualityBasis({
    candidate: input.candidate,
    sourceUnit: input.sourceUnit,
    association: associationFor(input) ?? null,
    pairs,
    issues,
    associationIssues: associationIssues(input).map(
      ({ code, message, object, location }) => ({
        code,
        message,
        object,
        location: location ?? null,
      }),
    ),
  });
}

function candidateProjectIssues(
  input: MiniMessageCheckInput,
  dependencies: MiniMessageQualityDependencies,
): readonly MiniMessageIncompleteFact[] {
  const candidateAssociation = input.facts.associations.find((association) => {
    if (
      association.status !== "matched" ||
      association.translationIndexes.length !== 1
    ) {
      return false;
    }
    const source = sourceUnitFor(input.facts, association.sourceKey);
    const message =
      source?.unit.context.role === "message"
        ? dependencies.messages.find(({ id }) => id === association.sourceKey)
        : undefined;
    const translation = input.facts.translations.records.find(
      ({ index }) => index === association.translationIndexes[0],
    );
    return (
      message !== undefined &&
      usesMiniMessage(message) &&
      translation?.bodyAvailability === "available"
    );
  });
  if (
    candidateAssociation?.sourceKey !== input.candidate.sourceKey ||
    candidateAssociation.language !== input.candidate.language
  ) {
    return [];
  }
  return dependencies.projection.incompleteFacts.filter(
    ({ message, code }) =>
      message === undefined &&
      (code === "minimessage.java-unavailable" ||
        code === "minimessage.project-input-unavailable"),
  );
}

export const translationOmissionsCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof miniMessageQualityConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "translation-omissions",
  version: "2",
  configurationSchema: miniMessageQualityConfigurationSchema,
  configuration: {},
  fingerprintInput: omissionsBasis,
  check(input) {
    const dependencies = dependenciesOf(input.dependencies);
    const globalIssues = associationIssues(input);
    if (input.sourceUnit === null) {
      const issue: MiniMessageIncompleteFact = {
        code: "translation.source-unit-unavailable",
        reason: "原生 QA 候选没有对应 Lands 原文事实",
      };
      return outcome(
        "incomplete",
        [],
        [issueForQuality(issue, input.candidate), ...globalIssues],
      );
    }

    const source = input.sourceUnit.unit;
    const association = associationFor(input);
    if (association === undefined) {
      return outcome(
        "incomplete",
        [],
        [
          {
            code: "translation.association-unavailable",
            message: "原生 QA 候选没有对应的译文关联事实",
            object: objectForCandidate(input.candidate, source.context.role),
          },
          ...globalIssues,
        ],
      );
    }

    if (association.status === "missing") {
      if (
        association.coverageStatus !== "complete" ||
        input.sourceUnit.bodyAvailability !== "available"
      ) {
        return outcome(
          "incomplete",
          [],
          [
            {
              code: "translation.missing-not-confirmed",
              message: "译文缺失尚未通过完整读取确认",
              object: objectForCandidate(input.candidate, source.context.role),
            },
            ...globalIssues,
          ],
        );
      }
      const diagnostic = finding(
        input,
        "translation.missing",
        "原文存在，但目标译文字段缺失",
        source.context.targetFile,
        source.context.path,
        source.source,
        null,
        undefined,
        source.context.role,
      );
      return outcome(
        globalIssues.length === 0 ? "complete" : "incomplete",
        [diagnostic],
        globalIssues,
      );
    }

    if (association.status !== "matched") {
      const issue: MiniMessageIncompleteFact = {
        code: `translation.association-${association.status}`,
        reason:
          association.status === "conflict"
            ? "同一原文存在多个译文关联，不能将其视为译文缺失"
            : association.status === "unavailable"
              ? "已关联的译文正文不可用，不能将其视为译文缺失"
              : "译文关联状态未知，不能将其视为译文缺失",
        location: {
          file: source.context.targetFile,
          path: source.context.path,
        },
        origin: "target",
      };
      return outcome(
        "incomplete",
        [],
        [issueForQuality(issue, input.candidate)],
      );
    }

    if (
      !hasAvailableMiniMessageTranslation(
        input,
        input.candidate.sourceKey,
        input.candidate.language,
      )
    ) {
      return outcome(
        "incomplete",
        [],
        [
          {
            code: "translation.matched-body-unavailable",
            message: "已匹配译文正文不可用，不能跳过本次检查",
            object: objectForCandidate(input.candidate, source.context.role),
          },
          ...globalIssues,
        ],
      );
    }

    const message = messageForCandidate(
      dependencies,
      input.candidate.sourceKey,
    );
    if (
      source.context.role !== "message" ||
      message === undefined ||
      !usesMiniMessage(message)
    ) {
      return outcome(
        globalIssues.length === 0 ? "not-applicable" : "incomplete",
        [],
        globalIssues,
      );
    }

    const pairingIssues = relatedPairingIssues(dependencies, message.id);
    const diagnostics: QualityFinding<MiniMessageQualityObject>[] = [];
    const pairedSources = new Set(
      dependencies.pairing.pairs
        .filter(
          ({ sourceDocument }) => sourceDocument.message.id === message.id,
        )
        .map(({ sourceDocument }) => sourceDocument),
    );
    for (const sourceDocument of dependencies.projection.translatableText) {
      if (
        sourceDocument.message.id !== message.id ||
        sourceDocument.origin !== "source" ||
        pairedSources.has(sourceDocument) ||
        !hasExplicitEmptyTranslation(sourceDocument) ||
        dependencies.pairing.incomplete.some(
          (issue) =>
            issue.message?.id === message.id &&
            issue.origin === "source" &&
            issue.location?.file === sourceDocument.file &&
            canonicalJson(issue.location.path) ===
              canonicalJson(sourceDocument.path),
        )
      ) {
        continue;
      }
      for (const sourceRun of documentRuns(dependencies, sourceDocument)) {
        if (!isTranslatableBody(sourceRun.text)) continue;
        diagnostics.push(
          finding(
            input,
            "translation.empty-text",
            "原文包含可译正文，但对应译文正文为空",
            message.targetFile,
            sourceDocument.path,
            sourceRun.text,
            "",
          ),
        );
      }
    }
    for (const { sourceDocument, targetDocument } of dependencies.pairing
      .pairs) {
      if (sourceDocument.message.id !== message.id) continue;
      const targetByKey = new Map(
        indexedRuns(documentRuns(dependencies, targetDocument)).map(
          ({ key, run }) => [key, run],
        ),
      );
      for (const { key, run: sourceRun } of indexedRuns(
        documentRuns(dependencies, sourceDocument),
      )) {
        if (!isTranslatableBody(sourceRun.text)) continue;
        const targetRun = targetByKey.get(key);
        if (targetRun === undefined || !isTranslatableBody(targetRun.text)) {
          diagnostics.push(
            finding(
              input,
              "translation.empty-text",
              "原文包含可译正文，但对应译文正文为空",
              targetDocument.file,
              targetDocument.path,
              sourceRun.text,
              "",
              targetRun === undefined ? undefined : runPosition(targetRun),
            ),
          );
        } else if (sourceRun.text === targetRun.text) {
          diagnostics.push(
            finding(
              input,
              "translation.same-text",
              "原文与译文正文相同，仍需翻译或明确接受",
              targetDocument.file,
              targetDocument.path,
              sourceRun.text,
              targetRun.text,
              runPosition(targetRun),
            ),
          );
        }
      }
    }

    const relevantIssues = [
      ...pairingIssues,
      ...dependencies.projection.incompleteFacts.filter(
        ({ message: issueMessage }) => issueMessage?.id === message.id,
      ),
      ...candidateProjectIssues(input, dependencies),
    ];
    const issues = relevantIssues.map((issue) =>
      issueForQuality(issue, input.candidate),
    );
    return outcome(
      globalIssues.length + issues.length === 0 ? "complete" : "incomplete",
      diagnostics,
      [...globalIssues, ...issues],
    );
  },
});
