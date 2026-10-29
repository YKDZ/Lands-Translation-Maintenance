import type {
  CheckRule,
  JsonValue,
  MessageIdentity,
  MiniMessageContextFrame,
  MiniMessagePosition,
  ProjectView,
  RuleFinding,
  RuleInputDependency,
  TranslatableTextDocument,
  TranslatableTextSegment,
} from "#/model";
import { pairTranslatableTextDocuments } from "#/translatable-text-pairing";
import { canonicalJson, compareText, toJsonValue } from "#/value";

interface TextRegion {
  readonly role: string;
  readonly roleLabel: string;
  readonly surfaceIdentity: JsonValue;
  readonly segments: readonly TranslatableTextSegment[];
}

interface RegionContent {
  readonly signature: string;
  readonly text: string;
  readonly variables: readonly {
    readonly name: string;
    readonly raw: string;
    readonly position: MiniMessagePosition;
    readonly context: readonly {
      readonly kind: string;
      readonly name: string;
    }[];
  }[];
  readonly tokens: readonly string[];
  readonly positions: readonly MiniMessagePosition[];
}

interface ComparisonRecord {
  readonly message: MessageIdentity;
  readonly role: string;
  readonly roleLabel: string;
  readonly surfaceIdentity: JsonValue;
  readonly sourceDocument: TranslatableTextDocument;
  readonly targetDocument: TranslatableTextDocument;
  readonly source: RegionContent;
  readonly target: RegionContent;
  readonly sourceTechnicalSignature: string;
  readonly sourceContext: JsonValue;
  readonly targetContext: JsonValue;
  readonly sourceTechnical: readonly TranslatableTextSegment[];
  readonly targetTechnical: readonly TranslatableTextSegment[];
}

interface RegionBuilder {
  readonly role: string;
  readonly roleLabel: string;
  readonly surfaceIdentity: JsonValue;
  readonly segments: TranslatableTextSegment[];
}

const defaultMinimumSimilarity = 0.65;
const variableContextKinds = new Set(["tag-argument"]);
const numberPattern = /\p{N}+(?:[,.]\p{N}+)*/gu;
const wordPattern = /[\p{L}\p{N}]+/gu;
const capitalizedWordPattern = /\b[\p{Lu}][\p{L}\p{N}'’.-]*\b/gu;
const negationPattern =
  /\b(?:not|no|never|neither|nor|without|except|cannot|can't|cant|won't|wont|don't|dont|doesn't|doesnt|didn't|didnt|isn't|isnt|aren't|arent|wasn't|wasnt|weren't|werent|couldn't|couldnt|shouldn't|shouldnt|wouldn't|wouldnt|mustn't|mustnt)\b/giu;
const sentenceInitialWords = new Set([
  "a",
  "an",
  "and",
  "but",
  "he",
  "i",
  "if",
  "it",
  "she",
  "the",
  "they",
  "this",
  "we",
  "when",
  "you",
]);

function sameFrameIdentity(
  left: MiniMessageContextFrame,
  right: MiniMessageContextFrame,
): boolean {
  return left.kind === right.kind && left.name === right.name;
}

function segmentContext(
  document: TranslatableTextDocument,
  segment: TranslatableTextSegment,
): readonly MiniMessageContextFrame[] {
  const documentContextIsPrefix = document.context.every((frame, index) => {
    const segmentFrame = segment.context[index];
    return segmentFrame !== undefined && sameFrameIdentity(frame, segmentFrame);
  });
  return documentContextIsPrefix
    ? segment.context
    : [...document.context, ...segment.context];
}

function roleForSegment(
  document: TranslatableTextDocument,
  segment: TranslatableTextSegment,
): { readonly key: string; readonly label: string } {
  const context = segmentContext(document, segment);
  const hover = context
    .filter((frame) => frame.kind === "hover-text")
    .map(({ kind, name }) => ({ kind, name }));
  const arguments_ = context
    .filter((frame) => frame.kind === "tag-argument")
    .map(({ kind, name }) => ({ kind, name }));
  const attributes = context
    .filter((frame) => frame.kind === "html-attribute")
    .map(({ kind, name }) => ({ kind, name }));
  const elements = context
    .filter((frame) => frame.kind === "html-element")
    .map(({ kind, name }) => ({ kind, name }));
  const base = hover.length === 0 ? "body" : `hover:${hover.length}`;
  const key = canonicalJson({
    hover,
    arguments_,
    elements: attributes.length > 0 ? elements : [],
    attributes,
  });
  const label =
    attributes.length > 0
      ? `${base}/HTML 属性 ${elements.map(({ name }) => name).join("/")}.${attributes.map(({ name }) => name).join("/")}`
      : arguments_.length > 0
        ? `${base}/标签参数`
        : base;
  return { key, label };
}

function regionsForDocument(
  document: TranslatableTextDocument,
): ReadonlyMap<string, TextRegion> {
  const regions = new Map<string, RegionBuilder>();
  const elementSurfacesByPosition = new Map<
    string,
    readonly { readonly name: string; readonly occurrence: number }[]
  >();
  const nextOccurrenceByParentAndName = new Map<string, number>();

  for (const segment of document.segments) {
    const { key: role, label: roleLabel } = roleForSegment(document, segment);
    const context = segmentContext(document, segment);
    const hasHtmlAttribute = context.some(
      (frame) => frame.kind === "html-attribute",
    );
    let surface: readonly {
      readonly name: string;
      readonly occurrence: number;
    }[] = [];
    if (hasHtmlAttribute) {
      for (const frame of context) {
        if (frame.kind !== "html-element") continue;
        const positionIdentity =
          frame.position.start < 0 || frame.position.end < frame.position.start
            ? null
            : [frame.position.start, frame.position.end];
        const elementIdentity = canonicalJson([
          surface,
          frame.name,
          positionIdentity,
        ]);
        const existingSurface = elementSurfacesByPosition.get(elementIdentity);
        if (existingSurface !== undefined) {
          surface = existingSurface;
          continue;
        }
        const siblingIdentity = canonicalJson([surface, frame.name]);
        const occurrence =
          nextOccurrenceByParentAndName.get(siblingIdentity) ?? 0;
        nextOccurrenceByParentAndName.set(siblingIdentity, occurrence + 1);
        surface = [...surface, { name: frame.name, occurrence }];
        elementSurfacesByPosition.set(elementIdentity, surface);
      }
    }
    const surfaceIdentity: JsonValue = hasHtmlAttribute ? surface : [];
    const regionIdentity = canonicalJson([role, surfaceIdentity]);

    let region = regions.get(regionIdentity);
    if (region === undefined) {
      region = { role, roleLabel, surfaceIdentity, segments: [] };
      regions.set(regionIdentity, region);
    }
    region.segments.push(segment);
  }

  return new Map([...regions].map(([key, region]) => [key, { ...region }]));
}

function logicalDocumentIdentity(record: ComparisonRecord): string {
  return canonicalJson([
    record.message.id,
    record.sourceDocument.documentIndex,
    record.sourceDocument.path,
  ]);
}

function inputDependencies(
  records: readonly ComparisonRecord[],
): readonly RuleInputDependency[] {
  const dependencies = new Map<string, RuleInputDependency>();
  for (const record of records) {
    for (const document of [record.sourceDocument, record.targetDocument]) {
      const dependency: RuleInputDependency = {
        input: "minimessage-parse",
        messageId: document.message.id,
        origin: document.origin,
        documentIndex: document.documentIndex,
        path: document.path,
      };
      dependencies.set(canonicalJson(dependency), dependency);
    }
  }
  return [...dependencies]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, dependency]) => dependency);
}

function variableContext(
  context: readonly MiniMessageContextFrame[],
): readonly { readonly kind: string; readonly name: string }[] {
  return context
    .filter((frame) => variableContextKinds.has(frame.kind))
    .map(({ kind, name }) => ({ kind, name }));
}

function textTokens(text: string): string[] {
  return [...text.matchAll(wordPattern)].map((match) =>
    match[0]!.toLowerCase(),
  );
}

function contentOf(region: TextRegion): RegionContent {
  const signatureParts: JsonValue[] = [];
  const tokens: string[] = [];
  const textPieces: string[] = [];
  const variables: Array<RegionContent["variables"][number]> = [];
  const positions: MiniMessagePosition[] = [];
  let previousTextPart = -1;

  const appendTextPart = (value: string): void => {
    if (previousTextPart >= 0) {
      const previous = signatureParts[previousTextPart] as {
        readonly kind: "text";
        readonly value: string;
      };
      signatureParts[previousTextPart] = {
        kind: "text",
        value: previous.value + value,
      };
    } else {
      signatureParts.push({ kind: "text", value });
      previousTextPart = signatureParts.length - 1;
    }
    textPieces.push(value);
    tokens.push(...textTokens(value));
  };

  for (const segment of region.segments) {
    if (segment.kind === "text") {
      appendTextPart(segment.value);
      positions.push(segment.position);
    } else if (segment.kind === "boundary") {
      previousTextPart = -1;
      signatureParts.push({ kind: "boundary", value: segment.value });
      textPieces.push(segment.value);
      tokens.push("\u0000line-break");
      positions.push(segment.position);
    } else if (segment.kind === "variable") {
      previousTextPart = -1;
      const context = variableContext(segment.context);
      signatureParts.push({ kind: "variable", name: segment.value, context });
      tokens.push(`\u0000variable:${segment.value}`);
      variables.push({
        name: segment.value,
        raw: segment.raw,
        position: segment.position,
        context,
      });
      positions.push(segment.position);
    }
  }

  return {
    signature: canonicalJson(signatureParts),
    text: textPieces.join(""),
    variables,
    tokens,
    positions,
  };
}

function technicalSegments(
  document: TranslatableTextDocument,
): readonly TranslatableTextSegment[] {
  return document.segments.filter(
    (segment) => segment.kind === "command" || segment.kind === "structure",
  );
}

function technicalSignature(
  segments: readonly TranslatableTextSegment[],
): string {
  return canonicalJson(
    segments.map((segment) => ({
      kind: segment.kind,
      value: segment.value,
      raw: segment.raw,
      context: segment.context.map(({ kind, name }) => ({ kind, name })),
    })),
  );
}

function regionContext(
  document: TranslatableTextDocument,
  region: TextRegion,
): JsonValue {
  const frames = new Map<
    string,
    { readonly kind: string; readonly name: string }
  >();
  for (const segment of region.segments) {
    for (const { kind, name } of segment.context) {
      const key = canonicalJson([kind, name]);
      frames.set(key, { kind, name });
    }
  }
  if (frames.size === 0) {
    for (const { kind, name } of document.context) {
      const key = canonicalJson([kind, name]);
      frames.set(key, { kind, name });
    }
  }
  return [...frames.values()];
}

function hasTranslatableContent(content: RegionContent): boolean {
  return content.text.length > 0 || content.variables.length > 0;
}

function messageIsPendingSeed(
  project: ProjectView,
  sourceDocument: TranslatableTextDocument,
  targetDocument: TranslatableTextDocument,
): boolean {
  const message = project.messages.find(
    (item) => item.id === sourceDocument.message.id,
  );
  const review = message?.translationReview;
  if (
    review?.pendingReason === undefined ||
    review.confirmedSameText ||
    message?.targetStatus !== "present" ||
    message.target === undefined
  ) {
    return false;
  }
  const valueAtPath = (
    value: JsonValue | undefined,
    path: readonly (string | number)[],
  ): JsonValue | undefined => {
    let current = value;
    for (const part of path) {
      if (typeof part === "number") {
        if (!Array.isArray(current)) return undefined;
        current = current[part];
      } else {
        if (
          current === null ||
          typeof current !== "object" ||
          Array.isArray(current) ||
          !Object.hasOwn(current, part)
        ) {
          return undefined;
        }
        current = (current as { readonly [key: string]: JsonValue })[part];
      }
    }
    return current;
  };
  const sourcePath = sourceDocument.path.slice(message.path.length);
  const targetPath = targetDocument.path.slice(message.path.length);
  const sourceValue = valueAtPath(message.source, sourcePath);
  const targetValue = valueAtPath(message.target, targetPath);
  return (
    sourceValue !== undefined &&
    targetValue !== undefined &&
    canonicalJson(sourceValue) === canonicalJson(targetValue)
  );
}

function comparisonRecords(project: ProjectView): ComparisonRecord[] {
  const records: ComparisonRecord[] = [];
  for (const {
    sourceDocument,
    targetDocument,
  } of pairTranslatableTextDocuments(project.miniMessage!).pairs) {
    if (messageIsPendingSeed(project, sourceDocument, targetDocument)) continue;

    const targetRegions = regionsForDocument(targetDocument);
    const sourceRegions = regionsForDocument(sourceDocument);
    const sourceTechnical = technicalSegments(sourceDocument);
    const targetTechnical = technicalSegments(targetDocument);
    for (const [regionIdentity, sourceRegion] of sourceRegions) {
      const targetRegion = targetRegions.get(regionIdentity);
      if (targetRegion === undefined) continue;
      const source = contentOf(sourceRegion);
      const target = contentOf(targetRegion);
      if (!hasTranslatableContent(source) || !hasTranslatableContent(target)) {
        continue;
      }
      records.push({
        message: sourceDocument.message,
        role: sourceRegion.role,
        roleLabel: sourceRegion.roleLabel,
        surfaceIdentity: sourceRegion.surfaceIdentity,
        sourceDocument,
        targetDocument,
        source,
        target,
        sourceTechnicalSignature: technicalSignature(sourceTechnical),
        sourceContext: regionContext(sourceDocument, sourceRegion),
        targetContext: regionContext(targetDocument, targetRegion),
        sourceTechnical,
        targetTechnical,
      });
    }
  }
  return records.sort((left, right) =>
    compareText(
      canonicalJson([
        left.message.id,
        left.sourceDocument.path,
        left.role,
        left.surfaceIdentity,
      ]),
      canonicalJson([
        right.message.id,
        right.sourceDocument.path,
        right.role,
        right.surfaceIdentity,
      ]),
    ),
  );
}

function sequenceDistance(
  left: readonly string[],
  right: readonly string[],
): number {
  let previous = Array.from(
    { length: right.length + 1 },
    (_item, index) => index,
  );
  for (const [leftIndex, leftItem] of left.entries()) {
    const current = [leftIndex + 1];
    for (const [rightIndex, rightItem] of right.entries()) {
      current.push(
        Math.min(
          current[rightIndex]! + 1,
          previous[rightIndex + 1]! + 1,
          previous[rightIndex]! + (leftItem === rightItem ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

function similarity(left: readonly string[], right: readonly string[]): number {
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 1;
  return 1 - sequenceDistance(left, right) / longest;
}

function difference(
  left: readonly string[],
  right: readonly string[],
): { readonly removed: readonly string[]; readonly added: readonly string[] } {
  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();
  for (const value of left)
    leftCounts.set(value, (leftCounts.get(value) ?? 0) + 1);
  for (const value of right)
    rightCounts.set(value, (rightCounts.get(value) ?? 0) + 1);
  const removed: string[] = [];
  const added: string[] = [];
  for (const [value, count] of leftCounts) {
    const extra = count - (rightCounts.get(value) ?? 0);
    for (let index = 0; index < extra; index += 1) removed.push(value);
  }
  for (const [value, count] of rightCounts) {
    const extra = count - (leftCounts.get(value) ?? 0);
    for (let index = 0; index < extra; index += 1) added.push(value);
  }
  return { removed: removed.sort(compareText), added: added.sort(compareText) };
}

function negations(text: string): readonly string[] {
  return [...text.matchAll(negationPattern)].map((match) =>
    match[0]!.toLowerCase(),
  );
}

function numbers(text: string): readonly string[] {
  return [...text.matchAll(numberPattern)].map((match) => match[0]!);
}

function entityCandidates(text: string): readonly string[] {
  return [...text.matchAll(capitalizedWordPattern)]
    .filter((match) => {
      const value = match[0]!.toLowerCase();
      return match.index !== 0 || !sentenceInitialWords.has(value);
    })
    .map((match) => match[0]!);
}

function contextJson(frames: readonly MiniMessageContextFrame[]): JsonValue {
  return frames.map(({ kind, name }) => ({ kind, name }));
}

function positionJson(position: MiniMessagePosition): JsonValue {
  return { start: position.start, end: position.end };
}

function textRange(positions: readonly MiniMessagePosition[]): JsonValue {
  const valid = positions.filter(
    ({ start, end }) => start >= 0 && end >= start,
  );
  if (valid.length === 0) return { state: "position-unavailable" };
  return {
    start: Math.min(...valid.map(({ start }) => start)),
    end: Math.max(...valid.map(({ end }) => end)),
  };
}

function variablesJson(content: RegionContent): JsonValue {
  return content.variables.map((variable) => ({
    name: variable.name,
    raw: variable.raw,
    position: positionJson(variable.position),
    context: variable.context,
  }));
}

function technicalJson(
  segments: readonly TranslatableTextSegment[],
): JsonValue {
  return segments.map((segment) => ({
    kind: segment.kind,
    value: segment.value,
    raw: segment.raw,
    position: positionJson(segment.position),
    context: contextJson(segment.context),
  }));
}

function identityJson(message: MessageIdentity): JsonValue {
  return {
    id: message.id,
    sourceFile: message.sourceFile,
    targetFile: message.targetFile,
    path: [...message.path],
    category: message.category,
    ...(message.scene === undefined ? {} : { scene: message.scene }),
    ...(message.format === undefined ? {} : { format: message.format }),
  };
}

function participantJson(record: ComparisonRecord): JsonValue {
  return {
    message: identityJson(record.message),
    role: record.roleLabel,
    source: {
      file: record.sourceDocument.file,
      path: [...record.sourceDocument.path],
      documentIndex: record.sourceDocument.documentIndex,
      range: textRange(record.source.positions),
      text: record.source.text,
      context: record.sourceContext,
      variables: variablesJson(record.source),
      technical: technicalJson(record.sourceTechnical),
    },
    target: {
      file: record.targetDocument.file,
      path: [...record.targetDocument.path],
      documentIndex: record.targetDocument.documentIndex,
      range: textRange(record.target.positions),
      text: record.target.text,
      context: record.targetContext,
      variables: variablesJson(record.target),
      technical: technicalJson(record.targetTechnical),
    },
  };
}

function stableIdentity(records: readonly ComparisonRecord[]): JsonValue {
  return {
    participants: records
      .map((record) => [
        record.message.id,
        record.sourceDocument.path,
        record.sourceDocument.documentIndex,
        record.role,
        record.surfaceIdentity,
      ])
      .sort((left, right) =>
        compareText(canonicalJson(left), canonicalJson(right)),
      ),
  };
}

function relatedConfiguration(minimumSimilarity: number): JsonValue {
  return { minimumSimilarity };
}

function sameSourceFindings(
  records: readonly ComparisonRecord[],
): RuleFinding[] {
  const groups = new Map<string, ComparisonRecord[]>();
  for (const record of records) {
    const key = canonicalJson([
      record.role,
      record.source.signature,
      record.sourceTechnicalSignature,
    ]);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  const findings: RuleFinding[] = [];
  for (const group of groups.values()) {
    if (
      new Set(group.map(logicalDocumentIdentity)).size < 2 ||
      new Set(group.map((record) => record.target.signature)).size < 2
    ) {
      continue;
    }
    const ordered = [...group].sort((left, right) =>
      compareText(
        canonicalJson([
          logicalDocumentIdentity(left),
          left.role,
          left.surfaceIdentity,
        ]),
        canonicalJson([
          logicalDocumentIdentity(right),
          right.role,
          right.surfaceIdentity,
        ]),
      ),
    );
    const first = ordered[0]!;
    const variants = new Map<string, ComparisonRecord[]>();
    for (const record of ordered) {
      const variant = variants.get(record.target.signature) ?? [];
      variant.push(record);
      variants.set(record.target.signature, variant);
    }
    findings.push({
      code: "translation-consistency.same-source",
      identity: stableIdentity(ordered),
      message: first.message,
      origin: "target",
      location: {
        file: first.targetDocument.file,
        path: first.targetDocument.path,
      },
      reason:
        "多个消息的可译原文相同，但译文不同；请按场景复核是否需要精确例外",
      expected: {
        sourceText: first.source.text,
        sourceVariables: variablesJson(first.source),
        condition: "同原文通常采用一致译文",
      },
      actual: {
        variants: [...variants]
          .sort(([left], [right]) => compareText(left, right))
          .map(([, variant]) => ({
            text: variant[0]!.target.text,
            variables: variablesJson(variant[0]!.target),
            messages: variant.map(participantJson),
          })),
      },
      fingerprint: {
        mode: "same-source",
        format: "translation-consistency-v1",
      },
      requiredInputDependencies: inputDependencies(ordered),
    });
  }
  return findings;
}

function commonIndexTokens(tokens: readonly string[]): readonly string[] {
  return [...new Set(tokens.filter((token) => token.length >= 4))];
}

function candidateIndexKeys(tokens: readonly string[]): readonly string[] {
  const keys = new Set(
    commonIndexTokens(tokens).map((token) => `word:${token}`),
  );
  // 默认 0.65 阈值下，2 对 3 词的单词增删仍可过线；短语限定为 2–6 词，删词签名至少保留两个词。
  if (
    tokens.length < 2 ||
    tokens.length > 6 ||
    tokens.some((token) => token.length >= 4)
  ) {
    return [...keys];
  }
  const phraseSignatures = new Set<string>([canonicalJson(tokens)]);
  if (tokens.length >= 3) {
    for (let index = 0; index < tokens.length; index += 1) {
      phraseSignatures.add(
        canonicalJson(
          tokens.filter((_token, tokenIndex) => tokenIndex !== index),
        ),
      );
    }
  }
  for (const signature of phraseSignatures)
    keys.add(`short-phrase:${signature}`);
  return [...keys];
}

function candidatePairs(
  records: readonly ComparisonRecord[],
): readonly (readonly [ComparisonRecord, ComparisonRecord])[] {
  const postings = new Map<string, number[]>();
  for (const [recordIndex, record] of records.entries()) {
    for (const key of candidateIndexKeys(record.source.tokens)) {
      const posting = postings.get(key) ?? [];
      posting.push(recordIndex);
      postings.set(key, posting);
    }
  }

  const pairIndices = new Set<string>();
  for (const posting of postings.values()) {
    for (let leftIndex = 0; leftIndex < posting.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < posting.length;
        rightIndex += 1
      ) {
        const left = posting[leftIndex]!;
        const right = posting[rightIndex]!;
        pairIndices.add(`${left}\0${right}`);
      }
    }
  }

  return [...pairIndices]
    .map((pair) => pair.split("\0").map(Number))
    .map(
      ([leftIndex, rightIndex]) =>
        [records[leftIndex!]!, records[rightIndex!]!] as const,
    )
    .sort(([leftA, rightA], [leftB, rightB]) =>
      compareText(
        canonicalJson([
          leftA.message.id,
          leftA.sourceDocument.path,
          leftA.role,
          leftA.surfaceIdentity,
          rightA.message.id,
          rightA.sourceDocument.path,
          rightA.role,
          rightA.surfaceIdentity,
        ]),
        canonicalJson([
          leftB.message.id,
          leftB.sourceDocument.path,
          leftB.role,
          leftB.surfaceIdentity,
          rightB.message.id,
          rightB.sourceDocument.path,
          rightB.role,
          rightB.surfaceIdentity,
        ]),
      ),
    );
}

function relatedTextDifferences(
  left: ComparisonRecord,
  right: ComparisonRecord,
): JsonValue {
  const changedWords = difference(
    left.source.tokens.filter((token) => !token.startsWith("\u0000")),
    right.source.tokens.filter((token) => !token.startsWith("\u0000")),
  );
  const leftNegations = negations(left.source.text);
  const rightNegations = negations(right.source.text);
  const leftNumbers = numbers(left.source.text);
  const rightNumbers = numbers(right.source.text);
  const leftVariables = left.source.variables.map((variable) => variable.name);
  const rightVariables = right.source.variables.map(
    (variable) => variable.name,
  );
  const leftEntities = entityCandidates(left.source.text);
  const rightEntities = entityCandidates(right.source.text);
  return {
    changedWords,
    negations: { left: leftNegations, right: rightNegations },
    numbers: { left: leftNumbers, right: rightNumbers },
    variables: { left: leftVariables, right: rightVariables },
    entityCandidates: { left: leftEntities, right: rightEntities },
  };
}

function similarSourceFindings(
  records: readonly ComparisonRecord[],
  minimumSimilarity: number,
): RuleFinding[] {
  const findings: RuleFinding[] = [];
  for (const [initialLeft, initialRight] of candidatePairs(records)) {
    if (
      logicalDocumentIdentity(initialLeft) ===
        logicalDocumentIdentity(initialRight) ||
      initialLeft.role !== initialRight.role ||
      initialLeft.sourceTechnicalSignature !==
        initialRight.sourceTechnicalSignature ||
      initialLeft.source.signature === initialRight.source.signature
    ) {
      continue;
    }
    const [left, right] =
      compareText(
        canonicalJson([
          initialLeft.message.id,
          initialLeft.sourceDocument.path,
          initialLeft.role,
          initialLeft.surfaceIdentity,
        ]),
        canonicalJson([
          initialRight.message.id,
          initialRight.sourceDocument.path,
          initialRight.role,
          initialRight.surfaceIdentity,
        ]),
      ) <= 0
        ? [initialLeft, initialRight]
        : [initialRight, initialLeft];
    const score = similarity(left.source.tokens, right.source.tokens);
    if (score < minimumSimilarity) continue;
    const participants = [left, right];
    findings.push({
      code: "translation-consistency.similar-source-candidate",
      severity: "warning",
      identity: stableIdentity(participants),
      message: left.message,
      origin: "target",
      location: {
        file: left.targetDocument.file,
        path: left.targetDocument.path,
      },
      reason: "原文相似的译文对照候选；相似度不能证明语义相同或译文错误",
      expected: {
        reviewThreshold: minimumSimilarity,
        interpretation: "需人工比较原文含义及可见差别",
      },
      actual: {
        similarity: score,
        sourceDifferences: relatedTextDifferences(left, right),
        translations: participants.map((record) => ({
          text: record.target.text,
          variables: variablesJson(record.target),
        })),
        messages: participants.map(participantJson),
        semanticEquivalence: "unknown",
      },
      fingerprint: {
        mode: "similar-source-candidate",
        minimumSimilarity: relatedConfiguration(minimumSimilarity),
        format: "translation-consistency-v1",
      },
      requiredInputDependencies: inputDependencies(participants),
    });
  }
  return findings;
}

function minimumSimilarity(context: Parameters<CheckRule["evaluate"]>[1]): {
  readonly value: number;
  readonly invalid?: unknown;
} {
  const value = context.parameters.minimumSimilarity;
  if (value === undefined) return { value: defaultMinimumSimilarity };
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  ) {
    return { value };
  }
  return { value: defaultMinimumSimilarity, invalid: value };
}

function invalidParameterFinding(value: unknown): RuleFinding {
  return {
    code: "translation-consistency.invalid-parameters",
    identity: { parameter: "minimumSimilarity" },
    location: {
      file: ".l10n/config.yml",
      path: [
        "rules",
        "translation-consistency",
        "parameters",
        "minimumSimilarity",
      ],
    },
    reason: "相似度阈值必须是 0 到 1 之间的数字",
    expected: { minimumSimilarity: "0 到 1 之间的有限数字" },
    actual: { type: typeof value, value: toJsonValue(value) },
    fingerprint: { parameter: "minimumSimilarity", value: toJsonValue(value) },
  };
}

export const translationConsistencyRule: CheckRule = {
  id: "translation-consistency",
  defaultSeverity: "error",
  requiredInputs: ["minimessage-parse"],
  evaluate(project: ProjectView, context) {
    const threshold = minimumSimilarity(context);
    if (threshold.invalid !== undefined) {
      return [invalidParameterFinding(threshold.invalid)];
    }
    const records = comparisonRecords(project);
    return [
      ...sameSourceFindings(records),
      ...similarSourceFindings(records, threshold.value),
    ];
  },
};
