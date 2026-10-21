import type {
  CheckRule,
  MiniMessageContextFrame,
  MiniMessagePosition,
  TranslatableTextDocument,
  TranslatableTextSegment,
} from "#/model";
import { terminologyEntries, terminologyStyleSource } from "#/terminology-data";
import { canonicalJson } from "#/value";

interface TextPart {
  readonly start: number;
  readonly end: number;
  readonly position: MiniMessagePosition;
}

interface TextRun {
  readonly text: string;
  readonly parts: readonly TextPart[];
  readonly contextKey: string;
}

interface TermMatch {
  readonly entry: (typeof terminologyEntries)[number];
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly ordinal: number;
}

interface TranslationMatch {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly positions: readonly MiniMessagePosition[];
}

function positionValues(positions: readonly MiniMessagePosition[]) {
  return positions.map(({ start, end }) => ({ start, end }));
}

const wordBoundary = "[\\p{L}\\p{N}_]";
const ruleFingerprintVersion = "legacy-readme-terminology-v1";
const styleFingerprintVersion = "legacy-readme-translation-style-v1";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sourcePattern(forms: readonly string[]): RegExp {
  const alternatives = [...forms]
    .sort((left, right) => right.length - left.length)
    .map((form) => form.split(/\s+/u).map(escapeRegExp).join("\\s+"));
  return new RegExp(
    `(?<!${wordBoundary})(?:${alternatives.join("|")})(?!${wordBoundary})`,
    "giu",
  );
}

const sourcePatterns = new Map(
  terminologyEntries.map((entry) => [
    entry.id,
    sourcePattern(entry.source.forms),
  ]),
);

function sourcePositions(run: TextRun, start: number, end: number) {
  return run.parts.flatMap((part) => {
    const overlapStart = Math.max(part.start, start);
    const overlapEnd = Math.min(part.end, end);
    if (overlapStart >= overlapEnd) return [];
    const sourceLength = part.position.end - part.position.start;
    const textLength = part.end - part.start;
    if (sourceLength !== textLength) return [part.position];
    return [
      {
        start: part.position.start + overlapStart - part.start,
        end: part.position.start + overlapEnd - part.start,
      },
    ];
  });
}

function textRuns(
  segments: readonly TranslatableTextSegment[],
): readonly TextRun[] {
  const elementFrames = new Map<
    string,
    { readonly frame: MiniMessageContextFrame; parentKey?: string }
  >();
  for (const segment of segments) {
    for (const frame of segment.context) {
      if (frame.kind !== "html-element") continue;
      const key = `${frame.position.start}:${frame.position.end}:${frame.name}`;
      elementFrames.set(key, { frame });
    }
  }
  const orderedElements = [...elementFrames.entries()].sort(
    ([leftKey, left], [rightKey, right]) =>
      left.frame.position.start - right.frame.position.start ||
      right.frame.position.end - left.frame.position.end ||
      leftKey.localeCompare(rightKey),
  );
  for (const [, element] of orderedElements) {
    const parents = orderedElements.filter(([, candidate]) => {
      const parent = candidate.frame.position;
      const child = element.frame.position;
      return (
        parent.start <= child.start &&
        parent.end >= child.end &&
        (parent.start < child.start || parent.end > child.end)
      );
    });
    const parent = parents.sort(
      ([leftKey, left], [rightKey, right]) =>
        left.frame.position.end -
          left.frame.position.start -
          (right.frame.position.end - right.frame.position.start) ||
        leftKey.localeCompare(rightKey),
    )[0];
    if (parent !== undefined) element.parentKey = parent[0];
  }

  const elementIdentities = new Map<string, string>();
  const siblingOrdinals = new Map<string, number>();
  for (const [key, element] of orderedElements) {
    const parentIdentity =
      element.parentKey === undefined
        ? "root"
        : (elementIdentities.get(element.parentKey) ?? "root");
    const siblingKey = `${parentIdentity}\0${element.frame.name}`;
    const ordinal = siblingOrdinals.get(siblingKey) ?? 0;
    siblingOrdinals.set(siblingKey, ordinal + 1);
    elementIdentities.set(
      key,
      `${parentIdentity}/${element.frame.name}[${ordinal}]`,
    );
  }

  const clickFrames = new Map<string, MiniMessageContextFrame>();
  for (const segment of segments) {
    for (const frame of segment.context) {
      if (frame.kind !== "tag" || frame.name !== "click") continue;
      clickFrames.set(
        `${frame.position.start}:${frame.position.end}:${frame.name}`,
        frame,
      );
    }
  }
  const clickIdentities = new Map<string, string>();
  [...clickFrames.entries()]
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        left.position.start - right.position.start ||
        left.position.end - right.position.end ||
        leftKey.localeCompare(rightKey),
    )
    .forEach(([key], index) => clickIdentities.set(key, `click[${index}]`));

  const contextKey = (context: readonly MiniMessageContextFrame[]): string => {
    const frames: string[] = [];
    for (const [index, frame] of context.entries()) {
      if (frame.kind === "tag") {
        if (frame.name === "click") {
          const key = `${frame.position.start}:${frame.position.end}:${frame.name}`;
          frames.push(`tag:${clickIdentities.get(key) ?? "click"}`);
        }
        continue;
      }
      if (frame.kind === "html-element") {
        const key = `${frame.position.start}:${frame.position.end}:${frame.name}`;
        frames.push(`html-element:${elementIdentities.get(key) ?? frame.name}`);
        continue;
      }
      if (frame.kind === "html-attribute") {
        const owner = context
          .slice(0, index)
          .findLast((candidate) => candidate.kind === "html-element");
        const ownerIdentity =
          owner === undefined
            ? "root"
            : (elementIdentities.get(
                `${owner.position.start}:${owner.position.end}:${owner.name}`,
              ) ?? owner.name);
        frames.push(`html-attribute:${ownerIdentity}:${frame.name}`);
        continue;
      }
      frames.push(`${frame.kind}:${frame.name}`);
    }
    return canonicalJson(frames);
  };

  const runs: TextRun[] = [];
  let text = "";
  let parts: TextPart[] = [];
  let currentContextKey: string | undefined;

  const flush = () => {
    if (text !== "" && currentContextKey !== undefined) {
      runs.push({ text, parts, contextKey: currentContextKey });
    }
    text = "";
    parts = [];
  };

  for (const segment of segments) {
    const nextContextKey = contextKey(segment.context);
    if (segment.kind !== "text") {
      flush();
      currentContextKey = nextContextKey;
      continue;
    }
    if (
      currentContextKey !== undefined &&
      currentContextKey !== nextContextKey
    ) {
      flush();
    }
    currentContextKey = nextContextKey;
    const start = text.length;
    text += segment.value;
    parts.push({
      start,
      end: text.length,
      position: segment.position,
    });
  }
  flush();
  return runs;
}

function claimSense(text: string, start: number, end: number): "verb" | "noun" {
  const token = text.slice(start, end).toLowerCase();
  if (token.endsWith("ed") || token.endsWith("ing")) return "verb";

  const before = text.slice(Math.max(0, start - 40), start);
  const after = text.slice(end, Math.min(text.length, end + 40));
  const precedingWord = before
    .match(/[\p{L}\p{N}_]+\s*$/u)?.[0]
    .trim()
    .toLowerCase();
  const followingWord = after
    .match(/^\s*([\p{L}\p{N}_]+)/u)?.[1]
    ?.toLowerCase();
  if (
    followingWord === "of" ||
    /^(?:is|was|are|were)$/u.test(followingWord ?? "")
  ) {
    return "noun";
  }
  if (
    precedingWord !== undefined &&
    /^(?:a|an|the|this|that|these|those|new|my|your|their|our|all|some|no|more|many|several)$/u.test(
      precedingWord,
    )
  ) {
    return "noun";
  }

  if (token === "claims") {
    if (
      precedingWord !== undefined &&
      /^(?:will|would|can|could|may|might|must|should|do|does|did|to)$/u.test(
        precedingWord,
      )
    ) {
      return "verb";
    }
    return "noun";
  }
  if (
    precedingWord !== undefined &&
    /^(?:will|would|can|could|may|might|must|should|do|does|did|to)$/u.test(
      precedingWord,
    )
  ) {
    return "verb";
  }
  return "verb";
}

function notApplicableContext(
  entry: (typeof terminologyEntries)[number],
  text: string,
  start: number,
  matchedText: string,
  path: readonly (string | number)[],
): boolean {
  const precedingWord = text
    .slice(0, start)
    .match(/[\p{L}\p{N}_]+\s*$/u)?.[0]
    .trim()
    .toLowerCase();
  const followingWord = text
    .slice(start + matchedText.length)
    .match(/^\s*([\p{L}\p{N}_]+)/u)?.[1]
    ?.toLowerCase();
  return (
    entry.notApplicableContext?.some(
      (context) =>
        context.form === matchedText &&
        ((context.precedingWords?.includes(precedingWord ?? "") ?? false) ||
          (context.followingWords?.includes(followingWord ?? "") ?? false) ||
          (context.pathSegments?.some((segment) => path.includes(segment)) ??
            false)),
    ) ?? false
  );
}

function termMatches(
  text: string,
  path: readonly (string | number)[],
): readonly TermMatch[] {
  const unsuppressed = terminologyEntries.flatMap((entry) => {
    const matcher = entry.source;
    const results: TermMatch[] = [];
    const pattern = sourcePatterns.get(entry.id);
    if (pattern === undefined)
      throw new Error(`术语缺少来源匹配器：${entry.id}`);
    pattern.lastIndex = 0;
    let ordinal = 0;
    for (const match of text.matchAll(pattern)) {
      const matchedText = match[0];
      const start = match.index;
      if (matchedText === undefined || start === undefined) continue;
      const end = start + matchedText.length;
      if (notApplicableContext(entry, text, start, matchedText, path)) continue;
      if (
        matcher.kind === "claim-sense" &&
        claimSense(text, start, end) !== matcher.sense
      ) {
        continue;
      }
      results.push({ entry, text: matchedText, start, end, ordinal });
      ordinal += 1;
    }
    return results;
  });

  return unsuppressed.filter(
    (match) =>
      !unsuppressed.some(
        (specific) =>
          specific !== match &&
          specific.entry.suppressOverlaps?.includes(match.entry.id) === true &&
          specific.start < match.end &&
          match.start < specific.end,
      ),
  );
}

function translationOverrides(
  parameters: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, readonly string[]> {
  for (const key of Object.keys(parameters)) {
    if (key !== "translations") {
      throw new Error(`不支持术语规则参数：${key}`);
    }
  }
  const configured = parameters.translations;
  if (configured === undefined) return new Map();
  if (
    typeof configured !== "object" ||
    configured === null ||
    Array.isArray(configured)
  ) {
    throw new Error("术语规则 translations 参数必须是术语 ID 到译法的映射");
  }

  const entriesById = new Map(
    terminologyEntries.map((entry) => [entry.id, entry]),
  );
  const overrides = new Map<string, readonly string[]>();
  for (const [id, raw] of Object.entries(configured)) {
    if (!entriesById.has(id)) throw new Error(`未知术语 ID：${id}`);
    const values = typeof raw === "string" ? [raw] : raw;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value) => typeof value !== "string" || value.trim() === "")
    ) {
      throw new Error(`术语 ${id} 的译法必须是非空字符串或字符串列表`);
    }
    const translations = [...new Set(values.map((value) => value.trim()))];
    overrides.set(id, translations);
  }
  return overrides;
}

function allowedTranslations(
  entry: (typeof terminologyEntries)[number],
  overrides: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  return overrides.get(entry.id) ?? entry.allowedTranslations;
}

function positionsForMatch(run: TextRun, start: number, end: number) {
  return sourcePositions(run, start, end);
}

function translationMatches(
  runs: readonly TextRun[],
  translations: readonly string[],
  competingTranslations: readonly string[] = [],
): readonly TranslationMatch[] {
  const matches: TranslationMatch[] = [];
  for (const run of runs) {
    for (const translation of translations) {
      let offset = 0;
      while (offset < run.text.length) {
        const start = run.text.indexOf(translation, offset);
        if (start < 0) break;
        const end = start + translation.length;
        const isPartOfCompetingTranslation = competingTranslations.some(
          (competing) =>
            competing.length > translation.length &&
            competing.startsWith(translation) &&
            run.text.slice(start, start + competing.length) === competing,
        );
        if (!isPartOfCompetingTranslation) {
          matches.push({
            text: translation,
            start,
            end,
            positions: positionsForMatch(run, start, end),
          });
        }
        offset = end;
      }
    }
  }
  return matches;
}

function oppositeEntry(
  entry: (typeof terminologyEntries)[number],
): (typeof terminologyEntries)[number] | undefined {
  const source = entry.source;
  if (source.kind !== "claim-sense" && source.kind !== "declare-sense")
    return undefined;
  return terminologyEntries.find((candidate) => {
    const candidateSource = candidate.source;
    return (
      candidateSource.kind === source.kind &&
      candidateSource.sense !== source.sense
    );
  });
}

function documentKey(document: TranslatableTextDocument): string {
  return `${document.message.id}\0${canonicalJson(document.path)}\0${document.origin}\0${document.documentIndex}`;
}

function exactSeed(
  project: Parameters<CheckRule["evaluate"]>[0],
  document: TranslatableTextDocument,
): boolean {
  const message = project.messages.find(
    (candidate) => candidate.id === document.message.id,
  );
  return (
    message?.targetStatus === "present" &&
    canonicalJson(message.source) === canonicalJson(message.target)
  );
}

function termFinding(
  project: Parameters<CheckRule["evaluate"]>[0],
  document: TranslatableTextDocument,
  run: TextRun,
  match: TermMatch,
  runIndex: number,
  occurrenceIndex: number,
  overrides: ReadonlyMap<string, readonly string[]>,
  targetRuns: readonly TextRun[],
): ReturnType<CheckRule["evaluate"]>[number] | undefined {
  const entry = match.entry;
  const allowed = allowedTranslations(entry, overrides);
  const opposite = oppositeEntry(entry);
  const oppositeTranslations =
    opposite === undefined ? [] : allowedTranslations(opposite, overrides);
  const matchingTargetRuns = targetRuns.filter(
    (targetRun) => targetRun.contextKey === run.contextKey,
  );
  const found = translationMatches(
    matchingTargetRuns,
    allowed,
    oppositeTranslations,
  );
  if (found.length > 0) return undefined;

  const wrong =
    opposite === undefined
      ? []
      : translationMatches(matchingTargetRuns, oppositeTranslations, allowed);
  const message = project.messages.find(
    (candidate) => candidate.id === document.message.id,
  );
  if (message === undefined) return undefined;
  const sourceRange = { start: match.start, end: match.end };
  const targetSegments = matchingTargetRuns.map((targetRun) => targetRun.text);
  const ruleFingerprint = {
    version: ruleFingerprintVersion,
    sourceVersion: project.miniMessage?.sourceVersion ?? "unknown",
    term: {
      id: entry.id,
      matcher: entry.source,
      allowedTranslations: allowed,
      context: entry.context,
      sourceReference: entry.sourceReference,
    },
    ...(opposite === undefined || wrong.length === 0
      ? {}
      : {
          opposite: {
            id: opposite.id,
            allowedTranslations: allowedTranslations(opposite, overrides),
            sourceReference: opposite.sourceReference,
          },
        }),
  };

  return {
    code:
      wrong.length > 0
        ? "terminology.opposite-sense"
        : "terminology.translation-missing",
    identity: {
      documentIndex: document.documentIndex,
      termId: entry.id,
      runIndex,
      occurrenceIndex,
      sourceRange,
    },
    fingerprint: ruleFingerprint,
    message: document.message,
    origin: "target",
    location: { file: document.file, path: document.path },
    reason:
      wrong.length > 0
        ? `术语 ${match.text} 使用了相反词义；${entry.context}`
        : `术语 ${match.text} 缺少 README 规定的译法；${entry.context}`,
    expected: {
      termId: entry.id,
      source: match.text,
      sense:
        entry.source.kind === "claim-sense" ||
        entry.source.kind === "declare-sense"
          ? entry.source.sense
          : null,
      translations: allowed,
      sourcePositions: positionValues(
        sourcePositions(run, match.start, match.end),
      ),
    },
    actual:
      wrong.length > 0
        ? {
            state: "opposite-sense-used",
            translations: wrong.map((item) => item.text),
            positions: wrong.map((item) => positionValues(item.positions)),
            textSegments: targetSegments,
          }
        : {
            state: "allowed-translation-missing",
            textSegments: targetSegments,
          },
  };
}

export const terminologyRule: CheckRule = {
  id: "terminology",
  defaultSeverity: "error",
  requiredInputs: ["minimessage-parse"],
  evaluate(project, context) {
    const parsed = project.miniMessage;
    if (parsed === undefined) return [];
    const overrides = translationOverrides(context.parameters);
    const documentsByKey = new Map(
      parsed.translatableText.map((document) => [
        documentKey(document),
        document,
      ]),
    );
    const findings: ReturnType<CheckRule["evaluate"]>[number][] = [];

    for (const source of parsed.translatableText) {
      if (source.origin !== "source") continue;
      const target = documentsByKey.get(
        `${source.message.id}\0${canonicalJson(source.path)}\0target\0${source.documentIndex}`,
      );
      if (target === undefined || exactSeed(project, source)) continue;
      const sourceDocument = parsed.documents.find(
        (document) =>
          document.message.id === source.message.id &&
          document.origin === "source" &&
          document.documentIndex === source.documentIndex &&
          document.file === source.file &&
          canonicalJson(document.path) === canonicalJson(source.path),
      );
      const targetDocument = parsed.documents.find(
        (document) =>
          document.message.id === target.message.id &&
          document.origin === "target" &&
          document.documentIndex === target.documentIndex &&
          document.file === target.file &&
          canonicalJson(document.path) === canonicalJson(target.path),
      );
      if (
        sourceDocument?.status === "parser-failed" ||
        targetDocument?.status === "parser-failed"
      ) {
        continue;
      }
      const sourceRuns = textRuns(source.segments);
      const targetRuns = textRuns(target.segments);
      for (const [runIndex, run] of sourceRuns.entries()) {
        const matches = termMatches(run.text, source.path);
        for (const match of matches) {
          const finding = termFinding(
            project,
            target,
            run,
            match,
            runIndex,
            match.ordinal,
            overrides,
            targetRuns,
          );
          if (finding !== undefined) findings.push(finding);
        }
      }
    }
    return findings;
  },
};

function styleFinding(
  document: TranslatableTextDocument,
  code: string,
  character: string,
  occurrenceIndex: number,
  position: MiniMessagePosition,
) {
  const punctuation = code === "translation-style.punctuation";
  return {
    code,
    identity: {
      documentIndex: document.documentIndex,
      code,
      occurrenceIndex,
      position: { start: position.start, end: position.end },
    },
    fingerprint: {
      version: styleFingerprintVersion,
      sourceReference: terminologyStyleSource,
      policy: punctuation ? "ASCII punctuation only" : "avoid 您",
    },
    message: document.message,
    origin: "target" as const,
    location: { file: document.file, path: document.path },
    reason: punctuation
      ? `标点 ${character} 不是英文半角标点`
      : "翻译风格要求不使用“您”",
    expected: punctuation
      ? { character: "ASCII 半角标点", codePoint: "ASCII" }
      : { character: "不使用“您”" },
    actual: {
      character,
      codePoint: `U+${character.codePointAt(0)?.toString(16).toUpperCase()}`,
    },
  };
}

export const translationStyleRule: CheckRule = {
  id: "translation-style",
  defaultSeverity: "error",
  requiredInputs: ["minimessage-parse"],
  evaluate(project, context) {
    if (Object.keys(context.parameters).length > 0) {
      throw new Error(
        `不支持翻译风格规则参数：${Object.keys(context.parameters).sort().join(", ")}`,
      );
    }
    const parsed = project.miniMessage;
    if (parsed === undefined) return [];
    const findings: ReturnType<CheckRule["evaluate"]>[number][] = [];
    for (const document of parsed.translatableText) {
      if (document.origin !== "target") continue;
      const parsedDocument = parsed.documents.find(
        (candidate) =>
          candidate.message.id === document.message.id &&
          candidate.origin === "target" &&
          candidate.documentIndex === document.documentIndex &&
          candidate.file === document.file &&
          canonicalJson(candidate.path) === canonicalJson(document.path),
      );
      if (parsedDocument?.status === "parser-failed") continue;
      let occurrenceIndex = 0;
      for (const run of textRuns(document.segments)) {
        for (let offset = 0; offset < run.text.length;) {
          const codePoint = run.text.codePointAt(offset);
          if (codePoint === undefined) break;
          const character = String.fromCodePoint(codePoint);
          const end = offset + character.length;
          const position =
            sourcePositions(run, offset, end)[0] ?? document.range;
          if (character === "您") {
            findings.push(
              styleFinding(
                document,
                "translation-style.honorific",
                character,
                occurrenceIndex,
                position,
              ),
            );
            occurrenceIndex += 1;
          }
          if (codePoint > 0x7f && /\p{P}/u.test(character)) {
            findings.push(
              styleFinding(
                document,
                "translation-style.punctuation",
                character,
                occurrenceIndex,
                position,
              ),
            );
            occurrenceIndex += 1;
          }
          offset = end;
        }
      }
    }
    return findings;
  },
};
