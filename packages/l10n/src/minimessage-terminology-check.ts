import {
  compileTerms,
  createTermbase,
  createTermChecker,
  normalizeText,
  requireAllowedTranslation,
  type NormalizedText,
  type QualityLocation,
  type TermBoundaryInput,
  type TermComparisonInput,
  type TermCheckerOptions,
  type TermExpression,
  type TermMatchingPolicy,
  type Termbase,
  type TermbaseData,
  type TermRange,
} from "@lioni/lioni";

import type {
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import type {
  MiniMessageIncompleteFact,
  MiniMessageParseProject,
  TranslatableTextDocument,
} from "#/mini-message-model";
import {
  dependenciesOf,
  hasMiniMessageInput,
  issueForQuality,
  messageForCandidate,
  qualityBasis,
  type MiniMessageCheckInput,
  type MiniMessageQualityDependencies,
} from "#/minimessage-quality";
import {
  miniMessageTextRuns,
  sameTranslatableText,
  textRunReference,
  type MiniMessageTextRun,
} from "#/minimessage-text-runs";
import type { JsonValue } from "#/model";
import { canonicalJson } from "#/value";

const sourceLanguage = "en-US";
const targetLanguage = "zh-CN";
const hostPolicyVersion = "lands-terminology-context-v2";
const englishPolicyId = "lands-en-us-case-and-space-v2";
const chinesePolicyId = "lands-zh-cn-literal-boundary-v2";
const wordCharacter = /[\p{L}\p{N}_]/u;
const directObjectDeterminers = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "my",
  "your",
  "his",
  "her",
  "its",
  "our",
  "their",
]);
const compiledTermsByData = new WeakMap<
  TermbaseData,
  ReturnType<typeof compileTerms>
>();

interface LandsTermDependencies extends MiniMessageQualityDependencies {
  readonly termbaseData: TermbaseData;
}

interface TermCheckerSubject {
  readonly sourceKey: string;
  readonly language: string;
}

type TermFactoryOptions = TermCheckerOptions<
  LandsUnit,
  LandsTranslation,
  TermCheckerSubject,
  LandsJson,
  UnavailableTranslation
>;
type TermSelectionInput = Parameters<TermFactoryOptions["select"]>[0];
type TermProjectInput = Parameters<TermFactoryOptions["project"]>[0];
type TermFingerprintInput = Parameters<
  NonNullable<TermFactoryOptions["fingerprintInput"]>
>[0];
type TermSelectionResult = Awaited<ReturnType<TermFactoryOptions["select"]>>;

interface TextDocumentReference {
  readonly messageId: string;
  readonly documentIndex: number;
  readonly origin: "source" | "target";
  readonly file: string;
  readonly path: readonly (string | number)[];
  readonly documentRange: { readonly start: number; readonly end: number };
  readonly contextKey?: string;
  readonly positions?: readonly {
    readonly start: number;
    readonly end: number;
    readonly position: { readonly start: number; readonly end: number };
  }[];
}

function termDependencies(value: unknown): LandsTermDependencies {
  return value as LandsTermDependencies;
}

function compiledTermsFor(data: TermbaseData): ReturnType<typeof compileTerms> {
  const existing = compiledTermsByData.get(data);
  if (existing !== undefined) return existing;
  const compiled = compileTerms(createTermbase(data), {
    policyFor: landsTermMatchingPolicy,
  });
  compiledTermsByData.set(data, compiled);
  return compiled;
}

function previousWord(text: string, start: number): string | undefined {
  return text
    .slice(0, start)
    .match(/[\p{L}\p{N}_]+\s*$/u)?.[0]
    .trim()
    .toLowerCase();
}

function followingWord(text: string, end: number): string | undefined {
  return text
    .slice(end)
    .match(/^\s*([\p{L}\p{N}_]+)/u)?.[1]
    ?.toLowerCase();
}

function followingWords(text: string, end: number): readonly string[] {
  return [...text.slice(end).matchAll(/[\p{L}\p{N}_'-]+/gu)]
    .slice(0, 2)
    .map(([word]) => word.toLowerCase());
}

function claimSense(text: string, range: TermRange): "verb" | "noun" {
  const token = text.slice(range.start, range.end).toLowerCase();
  if (token.endsWith("ed") || token.endsWith("ing")) return "verb";

  const preceding = previousWord(text, range.start);
  const following = followingWord(text, range.end);
  if (following === "of" || /^(?:is|was|are|were)$/u.test(following ?? "")) {
    return "noun";
  }
  if (
    preceding !== undefined &&
    /^(?:a|an|the|this|that|these|those|new|my|your|their|our|all|some|no|more|many|several)$/u.test(
      preceding,
    )
  ) {
    return "noun";
  }

  if (token === "claims") {
    if (
      preceding !== undefined &&
      /^(?:will|would|can|could|may|might|must|should|do|does|did|to)$/u.test(
        preceding,
      )
    ) {
      return "verb";
    }
    return "noun";
  }
  if (
    preceding !== undefined &&
    /^(?:will|would|can|could|may|might|must|should|do|does|did|to)$/u.test(
      preceding,
    )
  ) {
    return "verb";
  }
  return "verb";
}

function isDirectUntrustEvent(text: string, range: TermRange): boolean {
  const preceding = previousWord(text, range.start);
  const following = followingWord(text, range.end);
  const objectWords = followingWords(text, range.end);
  const actorOrCue = [
    "i",
    "you",
    "we",
    "they",
    "he",
    "she",
    "successfully",
  ].includes(preceding ?? "");
  const hasObjectPhrase =
    objectWords.length >= 2 &&
    directObjectDeterminers.has(objectWords[0] ?? "");
  return (
    ((preceding === "was" || preceding === "were" || preceding === "been") &&
      !["in", "inside", "here", "there", "for", "only"].includes(
        following ?? "",
      )) ||
    (actorOrCue && hasObjectPhrase)
  );
}

function isEnemyRelation(text: string, end: number): boolean {
  const clause = text.slice(end, end + 100).split(/[.!?;\n]/u, 1)[0] ?? "";
  return /^\s+(?:[\p{L}\p{N}_'-]+\s+){0,3}as\s+an\s+enemy\b/iu.test(clause);
}

function isEnglishWordBoundary(text: string, range: TermRange): boolean {
  const before = range.start > 0 ? text[range.start - 1] : undefined;
  const after = range.end < text.length ? text[range.end] : undefined;
  return (
    (before === undefined || !wordCharacter.test(before)) &&
    (after === undefined || !wordCharacter.test(after))
  );
}

function isEnglishContextApplicable(input: TermBoundaryInput): boolean {
  const { text, range, entry } = input;
  if (!isEnglishWordBoundary(text, range)) return false;

  const matched = text.slice(range.start, range.end);
  const lower = matched.toLowerCase();
  const before = previousWord(text, range.start);
  const after = followingWord(text, range.end);

  if (entry.conceptId === "claim-verb" || entry.conceptId === "claim-noun") {
    if (/^claim-worlds-list(?![\p{L}\p{N}_-])/iu.test(text.slice(range.start)))
      return false;
    if (
      claimSense(text, range) !==
      (entry.conceptId === "claim-verb" ? "verb" : "noun")
    ) {
      return false;
    }
  }

  if (entry.conceptId === "trust") {
    if (lower === "trust" && before === "temporary") return false;
    if (
      lower === "trusted" &&
      ((before !== undefined && ["not", "never"].includes(before)) ||
        ["in", "inside", "here", "there", "for", "only"].includes(after ?? ""))
    ) {
      return false;
    }
    if (
      /^trusted\s+players?\b/iu.test(text.slice(range.start)) &&
      entry.conceptId === "trust"
    ) {
      return false;
    }
  }

  if (
    entry.conceptId === "untrust" &&
    lower === "untrusted" &&
    !isDirectUntrustEvent(text, range)
  ) {
    return false;
  }

  if (
    entry.conceptId === "unclaim" &&
    lower === "unclaimed" &&
    after === "location"
  ) {
    return false;
  }

  if (entry.conceptId === "land" && matched === "Lands") {
    if (
      ["from", "to", "of", "about", "plugin", "by"].includes(before ?? "") ||
      [
        "plugin",
        "command",
        "commands",
        "api",
        "server",
        "world",
        "issue",
      ].includes(after ?? "")
    ) {
      return false;
    }
  }

  if (entry.conceptId === "declare-verb" && isEnemyRelation(text, range.end)) {
    return false;
  }

  if (entry.conceptId === "war") {
    if (/^\s+declarations?\b/iu.test(text.slice(range.end))) return false;
    if (/\bdeclares?\s+$/iu.test(text.slice(0, range.start))) return false;
    if (/\bdeclared\s+$/iu.test(text.slice(0, range.start))) return false;
    if (/\bdeclaring\s+$/iu.test(text.slice(0, range.start))) return false;
  }

  return true;
}

function collapseEnglishSpaces(original: string): NormalizedText {
  const nfc = normalizeText(original);
  const output: string[] = [];
  const ranges: TermRange[] = [];
  for (let offset = 0; offset < nfc.text.length;) {
    const codePoint = nfc.text.codePointAt(offset);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const next = offset + character.length;
    const mapped = nfc.mapRange({ start: offset, end: next });
    if (mapped === null) {
      return { original, text: "", mapRange: () => null };
    }

    if (/\s/u.test(character)) {
      let end = next;
      let finalRange = mapped;
      while (end < nfc.text.length) {
        const followingCodePoint = nfc.text.codePointAt(end);
        if (followingCodePoint === undefined) break;
        const following = String.fromCodePoint(followingCodePoint);
        if (!/\s/u.test(following)) break;
        const followingEnd = end + following.length;
        const followingRange = nfc.mapRange({ start: end, end: followingEnd });
        if (followingRange === null) {
          return { original, text: "", mapRange: () => null };
        }
        finalRange = { start: finalRange.start, end: followingRange.end };
        end = followingEnd;
      }
      output.push(" ");
      ranges.push(finalRange);
      offset = end;
      continue;
    }

    output.push(character.replace(/[A-Z]/gu, (letter) => letter.toLowerCase()));
    for (let index = 0; index < character.length; index += 1) {
      ranges.push(mapped);
    }
    offset = next;
  }

  const text = output.join("");
  return {
    original,
    text,
    mapRange(range) {
      if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start ||
        range.end > ranges.length
      ) {
        return null;
      }
      if (range.start === range.end) {
        const prior = ranges[range.start - 1];
        const next = ranges[range.start];
        const point = prior?.end ?? next?.start ?? 0;
        return { start: point, end: point };
      }
      const first = ranges[range.start];
      const last = ranges[range.end - 1];
      if (first === undefined || last === undefined) return null;
      return { start: first.start, end: last.end };
    },
  };
}

const englishPolicy: TermMatchingPolicy = {
  id: englishPolicyId,
  normalize: collapseEnglishSpaces,
  boundary: isEnglishContextApplicable,
};

const chinesePolicy: TermMatchingPolicy = {
  id: chinesePolicyId,
  boundary({ text, range, entry }) {
    if (entry.conceptId === "declare-verb" && text[range.end] === "书")
      return false;
    return true;
  },
};

export function landsTermMatchingPolicy(
  entry: TermExpression,
): TermMatchingPolicy | undefined {
  if (entry.language === sourceLanguage) return englishPolicy;
  if (entry.language === targetLanguage) return chinesePolicy;
  return undefined;
}

function positionsForBrandName(run: MiniMessageTextRun): readonly TermRange[] {
  const ranges: TermRange[] = [];
  for (const match of run.text.matchAll(
    /(?<![\p{L}\p{N}_])Lands(?![\p{L}\p{N}_])/gu,
  )) {
    if (match.index === undefined) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function pathProtectedRanges(
  document: TranslatableTextDocument,
  run: MiniMessageTextRun,
): readonly TermRange[] | undefined {
  if (document.origin !== "source" || !document.path.includes("prefix"))
    return undefined;
  const ranges = positionsForBrandName(run);
  return ranges.length === 0 ? undefined : ranges;
}

function documentReference(
  document: TranslatableTextDocument,
  contextKey?: string,
): JsonValue {
  return {
    messageId: document.message.id,
    documentIndex: document.documentIndex,
    origin: document.origin,
    file: document.file,
    path: [...document.path],
    documentRange: { ...document.range },
    ...(contextKey === undefined ? {} : { contextKey }),
    positions: [],
  };
}

function runOccurrenceKeys(
  runs: readonly MiniMessageTextRun[],
): readonly string[] {
  const counts = new Map<string, number>();
  return runs.map((run) => {
    const occurrence = counts.get(run.contextKey) ?? 0;
    counts.set(run.contextKey, occurrence + 1);
    return `${run.contextKey}\0${occurrence}`;
  });
}

function groupsForPair(
  projection: MiniMessageParseProject,
  source: TranslatableTextDocument,
  target: TranslatableTextDocument,
): readonly TermComparisonInput["groups"][number][] {
  if (sameTranslatableText(source, target)) return [];

  const sourceRuns = miniMessageTextRuns(projection, source);
  const targetRuns = miniMessageTextRuns(projection, target);
  const sourceKeys = runOccurrenceKeys(sourceRuns);
  const targetKeys = runOccurrenceKeys(targetRuns);
  const targets = new Map(
    targetRuns.map((run, index) => [targetKeys[index]!, run]),
  );

  return sourceRuns.map((sourceRun, index) => {
    const runKey = sourceKeys[index]!;
    const targetRun = targets.get(runKey);
    const targetReference =
      targetRun === undefined
        ? documentReference(target, sourceRun.contextKey)
        : textRunReference(target, targetRun);
    const sourceReference = textRunReference(source, sourceRun);
    const sourceProtectedRanges = pathProtectedRanges(source, sourceRun);
    const sourceFragment = {
      ref: sourceReference,
      text: sourceRun.text,
      ...(sourceProtectedRanges === undefined
        ? {}
        : { protectedRanges: sourceProtectedRanges }),
    };
    const targetProtectedRanges =
      targetRun === undefined
        ? undefined
        : pathProtectedRanges(target, targetRun);
    const targetFragment = {
      ref: targetReference,
      text: targetRun?.text ?? "",
      ...(targetProtectedRanges === undefined
        ? {}
        : { protectedRanges: targetProtectedRanges }),
    };
    return {
      ref: {
        sourceKey: source.message.id,
        sourceDocumentIndex: source.documentIndex,
        targetDocumentIndex: target.documentIndex,
        sourceFile: source.file,
        targetFile: target.file,
        sourcePath: [...source.path],
        targetPath: [...target.path],
        contextKey: sourceRun.contextKey,
        occurrence: index,
      },
      source: {
        language: sourceLanguage,
        fragments: [sourceFragment],
      },
      target: {
        language: targetLanguage,
        fragments: [targetFragment],
      },
    };
  });
}

export function matchedMiniMessageTranslation(
  input: MiniMessageCheckInput,
):
  | { readonly status: "matched"; readonly content: LandsJson }
  | { readonly status: "not-matched" }
  | { readonly status: "incomplete"; readonly reason: string } {
  const { candidate, facts } = input;
  const association = facts.associations.find(
    (item) =>
      item.sourceKey === candidate.sourceKey &&
      item.language === candidate.language,
  );
  if (association?.status !== "matched") return { status: "not-matched" };
  if (association.translationIndexes.length !== 1) {
    return {
      status: "incomplete",
      reason: "译文关联未提供唯一的实际匹配记录",
    };
  }
  const record = facts.translations.records.find(
    ({ index }) => index === association.translationIndexes[0],
  );
  if (record === undefined || record.bodyAvailability !== "available") {
    return { status: "incomplete", reason: "实际匹配译文正文不可用" };
  }
  if (
    record.language !== candidate.language ||
    canonicalJson(record.content) !== canonicalJson(candidate.content)
  ) {
    return {
      status: "incomplete",
      reason: "QA 候选与实际匹配译文记录不一致",
    };
  }
  return { status: "matched", content: record.content };
}

function termSelection(input: TermSelectionInput): TermSelectionResult {
  const dependencies = termDependencies(input.dependencies);
  const miniMessageInput = input as unknown as MiniMessageCheckInput;
  if (
    input.candidate.language !== targetLanguage ||
    !hasMiniMessageInput(miniMessageInput, dependencies)
  ) {
    return { status: "not-applicable" };
  }
  const association = matchedMiniMessageTranslation(miniMessageInput);
  if (association.status === "not-matched") return { status: "not-applicable" };
  if (association.status === "incomplete") {
    return {
      status: "incomplete",
      issue: {
        code: "terminology.translation-association-incomplete",
        message: association.reason,
      },
    };
  }
  if (input.sourceUnit === null) {
    return {
      status: "incomplete",
      issue: {
        code: "terminology.source-unit-unavailable",
        message: "原生 QA 候选没有对应 Lands 原文事实",
      },
    };
  }
  return {
    status: "selected",
    subject: {
      sourceKey: input.candidate.sourceKey,
      language: input.candidate.language,
    },
  };
}

function termProjection(input: TermProjectInput):
  | { readonly status: "ready"; readonly value: TermComparisonInput }
  | {
      readonly status: "incomplete";
      readonly issue: ReturnType<typeof issueForQuality>;
    } {
  const miniInput = input as unknown as MiniMessageCheckInput;
  const dependencies = dependenciesOf(miniInput.dependencies);
  const sourceKey = input.candidate.sourceKey;
  const relevantIssue = dependencies.pairing.incomplete.find(
    ({ message }) => message?.id === sourceKey,
  );
  if (relevantIssue !== undefined) {
    return {
      status: "incomplete",
      issue: issueForQuality(relevantIssue, miniInput.candidate),
    };
  }
  const message = messageForCandidate(dependencies, sourceKey);
  if (message === undefined) {
    return {
      status: "incomplete",
      issue: issueForQuality(
        {
          code: "terminology.message-projection-missing",
          reason: "术语检查找不到当前 Lands 正文投影",
        },
        miniInput.candidate,
      ),
    };
  }
  const documents = dependencies.projection.documents.filter(
    ({ message: documentMessage }) => documentMessage.id === sourceKey,
  );
  if (documents.some(({ status }) => status !== "parsed")) {
    const issue: MiniMessageIncompleteFact = {
      code: "terminology.text-projection-incomplete",
      message,
      reason: "原生 MiniMessage 正文未能完整解析",
    };
    return {
      status: "incomplete",
      issue: issueForQuality(issue, miniInput.candidate),
    };
  }
  const pairs = dependencies.pairing.pairs.filter(
    ({ sourceDocument }) => sourceDocument.message.id === sourceKey,
  );
  if (pairs.length === 0) {
    return {
      status: "incomplete",
      issue: issueForQuality(
        {
          code: "terminology.text-pair-missing",
          message,
          reason: "当前 Lands 正文没有唯一的原文与译文配对",
        },
        miniInput.candidate,
      ),
    };
  }
  return {
    status: "ready",
    value: {
      groups: pairs.flatMap(({ sourceDocument, targetDocument }) =>
        groupsForPair(dependencies.projection, sourceDocument, targetDocument),
      ),
    },
  };
}

function termFingerprint(input: TermFingerprintInput): JsonValue {
  const miniInput = input as unknown as MiniMessageCheckInput;
  const dependencies = dependenciesOf(miniInput.dependencies);
  const message = messageForCandidate(dependencies, input.candidate.sourceKey);
  return qualityBasis({
    version: hostPolicyVersion,
    policy: {
      sourceLanguage,
      targetLanguage,
      englishPolicyId,
      chinesePolicyId,
      protectedIdentifier: "claim-worlds-list",
      styleTags: "transparent",
      structureSegments: "separators",
    },
    candidate: {
      sourceKey: input.candidate.sourceKey,
      language: input.candidate.language,
      target: input.candidate.content,
    },
    sourceUnit:
      input.sourceUnit === null
        ? null
        : {
            key: input.sourceUnit.key,
            unit: input.sourceUnit.unit,
          },
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
            target: message.target ?? null,
          },
    projected: input.projected,
    incomplete: dependencies.pairing.incomplete
      .filter(
        ({ message: issueMessage }) =>
          issueMessage?.id === input.candidate.sourceKey,
      )
      .map(({ code, reason, location }) => ({
        code,
        reason,
        location: location ?? null,
      })),
  });
}

function termLocation(input: {
  readonly ref: JsonValue;
  readonly language: string;
  readonly sourceKey: string;
  readonly side: "source" | "target";
  readonly subject: TermCheckerSubject;
}): QualityLocation {
  const reference =
    typeof input.ref === "object" &&
    input.ref !== null &&
    !Array.isArray(input.ref)
      ? (input.ref as unknown as TextDocumentReference)
      : undefined;
  if (reference === undefined || typeof reference.file !== "string") {
    return {
      language: input.side === "target" ? input.language : null,
      range: input.ref,
      key: input.sourceKey,
    };
  }
  return {
    language: input.side === "target" ? input.language : null,
    range: {
      file: reference.file,
      path: reference.path,
      documentIndex: reference.documentIndex,
      document: reference.documentRange,
      textPositions: reference.positions ?? [],
    },
    key: input.sourceKey,
  };
}

export const landsTerminologyCheck = createTermChecker<
  LandsUnit,
  LandsTranslation,
  TermCheckerSubject,
  LandsJson,
  UnavailableTranslation
>({
  id: "terminology",
  hostVersion: hostPolicyVersion,
  terms: (input) =>
    compiledTermsFor(termDependencies(input.dependencies).termbaseData),
  rule: requireAllowedTranslation(),
  select: termSelection,
  project: termProjection,
  fingerprintInput: termFingerprint,
  location: termLocation,
});

/** 供配置加载器校验当前术语库并保留其可序列化原生资料。 */
export function landsTermbaseData(termbase: Termbase): TermbaseData {
  return termbase.data;
}
