import { defineQualityCheck, type QualityFinding } from "@lioni/lioni";

import type { JsonValue } from "#/json-value";
import type {
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import type {
  MiniMessageIncompleteFact,
  MiniMessageParseProject,
  MiniMessagePosition,
  TranslatableTextDocument,
} from "#/mini-message-model";
import {
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
import { matchedMiniMessageTranslation } from "#/minimessage-terminology-check";
import {
  miniMessageTextRuns,
  positionsForTextRun,
  sameTranslatableText,
} from "#/minimessage-text-runs";
import { canonicalJson } from "#/value";

const targetLanguage = "zh-CN";
const stylePolicyVersion = "lands-chinese-style-v1";
const styleSource = {
  path: "README.md",
  commit: "b8f6985a4ad2af1b76b05f0f79b718a2234623ad",
  section: "翻译风格",
} as const;
const inheritedPunctuation = new Set(["•", "‹", "›", "«", "»", "·"]);

type StyleCheck = "punctuation" | "honorific";

function checkCode(check: StyleCheck): string {
  return check === "punctuation"
    ? "translation-style.punctuation"
    : "translation-style.honorific";
}

function documentSignature(document: TranslatableTextDocument) {
  return {
    messageId: document.message.id,
    documentIndex: document.documentIndex,
    file: document.file,
    path: document.path,
    range: document.range,
    context: document.context,
    segments: document.segments.map(({ kind, value, position, context }) => ({
      kind,
      value,
      position,
      context,
    })),
  };
}

function styleFingerprint(
  input: MiniMessageCheckInput,
  check: StyleCheck,
): JsonValue {
  const dependencies = dependenciesOf(input.dependencies);
  const sourceKey = input.candidate.sourceKey;
  const message = messageForCandidate(dependencies, sourceKey);
  const pairs = (dependencies.miniMessageViews[sourceKey]?.pairs ?? []).map(
    ({ sourceDocument, targetDocument }) => ({
      source: documentSignature(sourceDocument),
      target: documentSignature(targetDocument),
      sameText: sameTranslatableText(sourceDocument, targetDocument),
      sourceRuns: miniMessageTextRuns(dependencies.projection, sourceDocument),
      targetRuns: miniMessageTextRuns(dependencies.projection, targetDocument),
    }),
  );
  const association = input.facts.associations.find(
    ({ sourceKey: key, language }) =>
      key === sourceKey && language === input.candidate.language,
  );
  const recordIndex =
    association?.status === "matched" &&
    association.translationIndexes.length === 1
      ? association.translationIndexes[0]
      : undefined;
  const record = input.facts.translations.records.find(
    ({ index }) => index === recordIndex,
  );
  return qualityBasis({
    version: stylePolicyVersion,
    check,
    policy:
      check === "punctuation"
        ? {
            source: styleSource,
            allowedAscii: true,
            inherited: [...inheritedPunctuation].sort(),
            inheritedPerContext: true,
          }
        : { source: styleSource, forbiddenCharacters: ["您"] },
    identity: {
      sourceKey,
      language: input.candidate.language,
      translation: record?.identity ?? null,
    },
    sourceUnit:
      input.sourceUnit === null
        ? null
        : { key: input.sourceUnit.key, unit: input.sourceUnit.unit },
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
    pairs,
    incomplete: (
      dependencies.miniMessageViews[sourceKey]?.pairingIssues ?? []
    ).map(({ code, reason, location }) => ({
      code,
      reason,
      location: location ?? null,
    })),
  });
}

function styleFinding(
  input: MiniMessageCheckInput,
  document: TranslatableTextDocument,
  check: StyleCheck,
  character: string,
  occurrenceIndex: number,
  positions: readonly MiniMessagePosition[],
  inheritedCount?: number,
): QualityFinding<MiniMessageQualityObject> {
  const code = checkCode(check);
  const location = {
    language: input.candidate.language,
    range: {
      file: document.file,
      path: document.path,
      ...(positions.length === 1
        ? { start: positions[0]!.start, end: positions[0]!.end }
        : { positions }),
    },
    key: input.candidate.sourceKey,
  };
  const object: MiniMessageQualityObject = {
    kind: "translation",
    key: input.candidate.sourceKey,
    language: input.candidate.language,
    code,
  };
  const actual = {
    character,
    codePoint: `U+${character.codePointAt(0)?.toString(16).toUpperCase()}`,
    documentIndex: document.documentIndex,
    occurrenceIndex,
    positions,
  };
  return {
    severity: "error",
    object,
    location,
    message:
      check === "punctuation"
        ? `标点 ${character} 不是英文半角标点`
        : "翻译风格要求不使用“您”",
    evidence: [
      {
        role: "style-policy",
        object: { kind: "translation-style-policy", key: code },
        location,
        value: {
          source: styleSource,
          policy:
            check === "punctuation"
              ? "使用英文半角标点；装饰符号只继承原文同一上下文中的数量"
              : "不用您",
          ...(inheritedCount === undefined ? {} : { inheritedCount }),
        },
      },
      { role: "actual", object, location, value: actual },
    ],
  };
}

function sameContextPunctuationCounts(
  projection: MiniMessageParseProject,
  document: TranslatableTextDocument,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of miniMessageTextRuns(projection, document)) {
    for (const character of run.text) {
      if (!inheritedPunctuation.has(character)) continue;
      const key = canonicalJson([run.contextKey, character]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function diagnosticsForPair(
  input: MiniMessageCheckInput,
  source: TranslatableTextDocument,
  target: TranslatableTextDocument,
  check: StyleCheck,
): readonly QualityFinding<MiniMessageQualityObject>[] {
  if (sameTranslatableText(source, target)) return [];
  const dependencies = dependenciesOf(input.dependencies);
  const sourceCounts =
    check === "punctuation"
      ? sameContextPunctuationCounts(dependencies.projection, source)
      : new Map<string, number>();
  const targetOccurrences = new Map<string, number>();
  const findings: QualityFinding<MiniMessageQualityObject>[] = [];
  let occurrenceIndex = 0;

  for (const run of miniMessageTextRuns(dependencies.projection, target)) {
    for (let offset = 0; offset < run.text.length;) {
      const codePoint = run.text.codePointAt(offset);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      const end = offset + character.length;
      const positions = positionsForTextRun(run, offset, end);

      if (check === "honorific" && character === "您") {
        findings.push(
          styleFinding(
            input,
            target,
            check,
            character,
            occurrenceIndex,
            positions.length === 0 ? [target.range] : positions,
          ),
        );
        occurrenceIndex += 1;
      }

      if (
        check === "punctuation" &&
        codePoint > 0x7f &&
        /\p{P}/u.test(character)
      ) {
        const contextKey = canonicalJson([run.contextKey, character]);
        let inheritedCount: number | undefined;
        if (inheritedPunctuation.has(character)) {
          const count = (targetOccurrences.get(contextKey) ?? 0) + 1;
          targetOccurrences.set(contextKey, count);
          inheritedCount = sourceCounts.get(contextKey) ?? 0;
          if (count <= inheritedCount) {
            offset = end;
            continue;
          }
        }
        findings.push(
          styleFinding(
            input,
            target,
            check,
            character,
            occurrenceIndex,
            positions.length === 0 ? [target.range] : positions,
            inheritedCount,
          ),
        );
        occurrenceIndex += 1;
      }
      offset = end;
    }
  }
  return findings;
}

function relevantIssue(
  input: MiniMessageCheckInput,
): MiniMessageIncompleteFact | undefined {
  return dependenciesOf(input.dependencies).miniMessageViews[
    input.candidate.sourceKey
  ]?.pairingIssues[0];
}

export function createMiniMessageStyleCheck(check: StyleCheck) {
  return defineQualityCheck<
    LandsUnit,
    LandsTranslation,
    typeof miniMessageQualityConfigurationSchema,
    MiniMessageQualityObject,
    LandsJson,
    UnavailableTranslation
  >({
    id:
      check === "punctuation"
        ? "translation-punctuation"
        : "translation-honorific",
    version: stylePolicyVersion,
    configurationSchema: miniMessageQualityConfigurationSchema,
    configuration: {},
    fingerprintInput: (input) => styleFingerprint(input, check),
    check(input) {
      const dependencies = dependenciesOf(input.dependencies);
      if (
        input.candidate.language !== targetLanguage ||
        !hasMiniMessageInput(input, dependencies)
      ) {
        return outcome("not-applicable", [], []);
      }
      const association = matchedMiniMessageTranslation(input);
      if (association.status === "not-matched")
        return outcome("not-applicable", [], []);
      if (association.status === "incomplete") {
        const issue: MiniMessageIncompleteFact = {
          code: "translation-style.association-incomplete",
          reason: association.reason,
        };
        return outcome(
          "incomplete",
          [],
          [issueForQuality(issue, input.candidate)],
        );
      }
      if (input.sourceUnit === null) {
        const issue: MiniMessageIncompleteFact = {
          code: "translation-style.source-unit-unavailable",
          reason: "原生 QA 候选没有对应 Lands 原文事实",
        };
        return outcome(
          "incomplete",
          [],
          [issueForQuality(issue, input.candidate)],
        );
      }
      const issue = relevantIssue(input);
      if (issue !== undefined) {
        return outcome(
          "incomplete",
          [],
          [issueForQuality(issue, input.candidate)],
        );
      }
      const view = dependencies.miniMessageViews[input.candidate.sourceKey];
      const pairs = view?.pairs ?? [];
      if (pairs.length === 0) {
        const missing: MiniMessageIncompleteFact = {
          code: "translation-style.text-pair-missing",
          reason: "当前 Lands 正文没有唯一的原文与译文配对",
        };
        return outcome(
          "incomplete",
          [],
          [issueForQuality(missing, input.candidate)],
        );
      }
      const parsedDocuments = view?.documents ?? [];
      if (parsedDocuments.some(({ status }) => status !== "parsed")) {
        const incomplete: MiniMessageIncompleteFact = {
          code: "translation-style.text-projection-incomplete",
          reason: "原生 MiniMessage 正文未能完整解析",
        };
        return outcome(
          "incomplete",
          [],
          [issueForQuality(incomplete, input.candidate)],
        );
      }
      const diagnostics = pairs.flatMap(({ sourceDocument, targetDocument }) =>
        diagnosticsForPair(input, sourceDocument, targetDocument, check),
      );
      return outcome("complete", diagnostics, []);
    },
  });
}
