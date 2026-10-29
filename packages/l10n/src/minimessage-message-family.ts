import {
  asciiNumbers,
  createTextAnalysis,
  regexTokens,
  type MessageFamilyCheckerOptions,
  type MessageFamilyInput,
  type MessageFamilyIssue,
  type MessageFamilySubject,
} from "@lioni/lioni";

import type {
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import type {
  MiniMessageIncompleteFact,
  MiniMessageInputMessage,
  MiniMessageParseProject,
  MiniMessagePosition,
  TranslatableTextDocument,
} from "#/mini-message-model";
import { parseMiniMessages, usesMiniMessage } from "#/minimessage";
import {
  dependenciesOf,
  hasMiniMessageInput,
  messageForCandidate,
  qualityBasis,
  type MiniMessageCheckInput,
  type MiniMessageQualityDependencies,
} from "#/minimessage-quality";
import {
  miniMessageTextContextKeyResolver,
  miniMessageTextRuns,
  textRunReference,
} from "#/minimessage-text-runs";
import type { JsonValue } from "#/model";
import { pairTranslatableTextDocuments } from "#/translatable-text-pairing";
import { canonicalJson } from "#/value";

const sourceLanguage = "en-US";
const landsMessageFamilyVersion = "lands-message-family-v1";

export interface LandsMessageFamilySubject extends MessageFamilySubject<
  LandsUnit,
  LandsJson
> {
  readonly projected: MessageFamilyInput;
}

export type LandsMessageFamilyOptions = MessageFamilyCheckerOptions<
  LandsUnit,
  LandsTranslation,
  LandsUnit,
  LandsJson,
  UnavailableTranslation,
  LandsMessageFamilySubject
>;

type SelectionInput = Parameters<LandsMessageFamilyOptions["select"]>[0];
type ProjectionInput = Parameters<LandsMessageFamilyOptions["project"]>[0];
type ReferenceProjectionInput = Extract<ProjectionInput, { kind: "reference" }>;
type CandidateInput = Parameters<
  NonNullable<LandsMessageFamilyOptions["projectCandidate"]>
>[0];
type FingerprintInput = Parameters<
  NonNullable<LandsMessageFamilyOptions["fingerprintInput"]>
>[0];
type SelectionResult = Awaited<ReturnType<LandsMessageFamilyOptions["select"]>>;

interface MessageFamilyRun {
  readonly contextKey: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly ref: JsonValue;
}

interface MessageFamilyEvent extends MessageFamilyRun {}

interface ProjectedDocument {
  readonly groups: ReadonlyMap<string, readonly MessageFamilyFragment[]>;
  readonly complete: boolean;
  readonly issues: readonly MessageFamilyIssue[];
}

interface MessageFamilyFragment {
  readonly ref: JsonValue;
  readonly text: string;
}

const landsVariableRecognizer = regexTokens({
  kind: "lands-variable",
  pattern: /<v:([A-Za-z0-9_.-]+)>|%(owner|player|nation|level)%/gu,
  identity: (match) => match[1] ?? match[2]!,
  protect: true,
});

/** 消息族只抽象 Lands 动态变量和数字槽；普通词语及其顺序保持原样。 */
export const landsMessageFamilyAnalysis = createTextAnalysis({
  recognizers: [landsVariableRecognizer, asciiNumbers()],
});

/** 同模板只忽略动态槽的具体取值，变量对应仍由独立变量检查负责。 */
export const landsMessageTemplate = {
  abstract(token: { readonly kind: string }) {
    if (token.kind === "lands-variable") {
      return { kind: "lands-variable", identity: "value" };
    }
    if (token.kind === "number") {
      return { kind: "number", identity: "value" };
    }
    return undefined;
  },
};

function sourceKeyFor(input: SelectionInput): string {
  return input.candidate.sourceKey;
}

function messageWithCandidate(
  message: MiniMessageInputMessage,
  content: LandsJson,
): MiniMessageInputMessage {
  return { ...message, target: content, targetStatus: "present" };
}

function messageWithReference(
  message: MiniMessageInputMessage,
  content: LandsJson | undefined,
): MiniMessageInputMessage {
  const { target: _target, ...sourceOnly } = message;
  return content === undefined
    ? { ...sourceOnly, targetStatus: "blocked" }
    : { ...message, target: content, targetStatus: "present" };
}

function positionRange(
  position: MiniMessagePosition,
): { readonly start: number; readonly end: number } | undefined {
  return position.start < 0 || position.end < position.start
    ? undefined
    : position;
}

function runRange(
  run: ReturnType<typeof miniMessageTextRuns>[number],
): { readonly start: number; readonly end: number } | undefined {
  const positions = run.parts
    .map(({ position }) => positionRange(position))
    .filter((position) => position !== undefined);
  if (positions.length !== run.parts.length || positions.length === 0) {
    return undefined;
  }
  return {
    start: Math.min(...positions.map(({ start }) => start)),
    end: Math.max(...positions.map(({ end }) => end)),
  };
}

function segmentReference(
  document: TranslatableTextDocument,
  contextKey: string,
  position: MiniMessagePosition,
): JsonValue {
  return {
    messageId: document.message.id,
    documentIndex: document.documentIndex,
    origin: document.origin,
    file: document.file,
    path: [...document.path],
    contextKey,
    position: { ...position },
  };
}

function projectDocument(
  project: MiniMessageParseProject,
  document: TranslatableTextDocument,
): ProjectedDocument {
  const parsedRuns = miniMessageTextRuns(project, document);
  const contextKeyFor = miniMessageTextContextKeyResolver(project, document);
  const runs = parsedRuns
    .map((run) => {
      const range = runRange(run);
      if (range === undefined) return undefined;
      return {
        contextKey: run.contextKey,
        ...range,
        text: run.text,
        ref: textRunReference(document, run),
      } satisfies MessageFamilyRun;
    })
    .filter((run) => run !== undefined);
  const events: MessageFamilyEvent[] = [...runs];
  const issues: MessageFamilyIssue[] = [];
  let complete = runs.length === parsedRuns.length;

  for (const segment of document.segments) {
    if (segment.kind !== "variable" && segment.kind !== "boundary") continue;
    const contextKey = contextKeyFor(segment.context);
    const range = positionRange(segment.position);
    if (range === undefined) {
      complete = false;
      issues.push({
        code: "message-family.segment-position-unavailable",
        message: "动态变量或正文边界缺少可回映到原文的位置。",
        sourceKey: document.message.id,
        language: document.origin === "target" ? "zh-CN" : sourceLanguage,
        ref: {
          file: document.file,
          path: [...document.path],
          position: { ...segment.position },
        },
      });
      continue;
    }
    events.push({
      contextKey,
      start: range.start,
      end: range.end,
      text: segment.kind === "variable" ? segment.raw : segment.value,
      ref: segmentReference(document, contextKey, segment.position),
    });
  }

  const groups = new Map<string, MessageFamilyFragment[]>();
  events
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .forEach(({ contextKey, text, ref }) => {
      const fragments = groups.get(contextKey) ?? [];
      fragments.push({ ref, text });
      groups.set(contextKey, fragments);
    });

  return { groups, complete, issues };
}

function issueForIncompleteFact(
  issue: MiniMessageIncompleteFact,
  sourceKey: string,
  language: string,
): MessageFamilyIssue {
  return {
    code: issue.code,
    message: issue.reason,
    sourceKey,
    language: issue.origin === "source" ? sourceLanguage : language,
    ...(issue.location === undefined
      ? {}
      : { ref: { file: issue.location.file, path: [...issue.location.path] } }),
  };
}

function familyScope(
  document: TranslatableTextDocument,
  contextKey: string,
): string {
  const technical = document.segments
    .filter(
      (segment) => segment.kind === "command" || segment.kind === "structure",
    )
    .map(({ kind, value, raw, context }) => ({
      kind,
      value,
      raw,
      context: context.map(({ kind: contextKind, name }) => ({
        kind: contextKind,
        name,
      })),
    }));
  return canonicalJson({ contextKey, technical });
}

function familyGroup(
  sourceDocument: TranslatableTextDocument,
  targetDocument: TranslatableTextDocument | undefined,
  language: string,
  contextKey: string,
  source: readonly MessageFamilyFragment[],
  target: readonly MessageFamilyFragment[] | undefined,
  targetIssues: readonly MessageFamilyIssue[],
  targetKnownEmpty = false,
): MessageFamilyInput["groups"][number] {
  const sourceRef: JsonValue = {
    messageId: sourceDocument.message.id,
    documentIndex: sourceDocument.documentIndex,
    file: sourceDocument.file,
    path: [...sourceDocument.path],
    contextKey,
    fragments: source.map(({ ref }) => ref),
  };
  const targetRef: JsonValue =
    targetDocument === undefined
      ? targetKnownEmpty
        ? {
            messageId: sourceDocument.message.id,
            file: sourceDocument.message.targetFile,
            path: [...sourceDocument.path],
            state: "target-empty",
          }
        : { messageId: sourceDocument.message.id, state: "target-unavailable" }
      : {
          messageId: targetDocument.message.id,
          documentIndex: targetDocument.documentIndex,
          file: targetDocument.file,
          path: [...targetDocument.path],
          contextKey,
          fragments: (target ?? []).map(({ ref }) => ref),
        };
  const targetComplete = targetDocument !== undefined || targetKnownEmpty;
  return {
    ref: { source: sourceRef, target: targetRef },
    scope: familyScope(sourceDocument, contextKey),
    source: {
      language: sourceLanguage,
      fragments: source,
    },
    target: {
      language,
      fragments: target ?? [],
      ...(!targetComplete || targetIssues.length > 0
        ? { complete: false, issues: targetIssues }
        : {}),
    },
  };
}

function issueAppliesToDocument(
  issue: MessageFamilyIssue,
  document: TranslatableTextDocument,
): boolean {
  const reference = issue.ref;
  if (
    reference === null ||
    reference === undefined ||
    typeof reference !== "object" ||
    Array.isArray(reference)
  ) {
    return true;
  }
  const { file, path } = reference as {
    readonly [key: string]: JsonValue;
  };
  if (typeof file !== "string" || !Array.isArray(path)) return true;
  return (
    (file === document.file || file === document.message.targetFile) &&
    canonicalJson(path) === canonicalJson(document.path)
  );
}

function isExplicitlyEmptyTarget(
  message: MiniMessageInputMessage,
  document: TranslatableTextDocument,
): boolean {
  // 已知空译文可形成空签名；读取或配对缺口仍由后续完整性标记保留。
  if (message.targetStatus !== "present") return false;
  if (Array.isArray(message.target)) {
    const itemIndex = document.path.at(-1);
    return (
      document.path.length === message.path.length + 1 &&
      canonicalJson(document.path.slice(0, message.path.length)) ===
        canonicalJson(message.path) &&
      typeof itemIndex === "number" &&
      (itemIndex >= message.target.length || message.target[itemIndex] === "")
    );
  }
  return (
    canonicalJson(document.path) === canonicalJson(message.path) &&
    message.target === ""
  );
}

async function projectMessage(
  dependencies: MiniMessageQualityDependencies,
  message: MiniMessageInputMessage,
  language: string,
): Promise<MessageFamilyInput> {
  const sourceKey = message.id;
  const sharedView = dependencies.miniMessageViews[sourceKey];
  const useSharedProjection =
    sharedView !== undefined &&
    canonicalJson(sharedView.message) === canonicalJson(message);
  const parsed = useSharedProjection
    ? dependencies.projection
    : await parseMiniMessages({
        messages: [message],
        resources: dependencies.resources,
        theme: dependencies.themeInput,
        sourceVersion: dependencies.sourceVersion,
      });
  const documents = useSharedProjection
    ? sharedView.translatableText
    : parsed.translatableText.filter(
        (document) => document.message.id === sourceKey,
      );
  const sourceDocuments = documents.filter(({ origin }) => origin === "source");
  const targetDocuments = documents.filter(({ origin }) => origin === "target");
  const computedPairing = useSharedProjection
    ? undefined
    : pairTranslatableTextDocuments(parsed);
  const paired = useSharedProjection
    ? sharedView.pairs
    : computedPairing!.pairs.filter(
        ({ sourceDocument }) => sourceDocument.message.id === sourceKey,
      );
  const pairingIssues = useSharedProjection
    ? sharedView.pairingIssues
    : computedPairing!.incomplete.filter(
        ({ message: issueMessage }) => issueMessage?.id === sourceKey,
      );
  const pairedSources = new Set(
    paired.map(({ sourceDocument }) => sourceDocument),
  );
  const globalIssues: MessageFamilyIssue[] = [];
  const sourceIssues: MessageFamilyIssue[] = [];
  const targetIssues: MessageFamilyIssue[] = [];
  const projectionIssues = useSharedProjection
    ? [...sharedView.incompleteFacts, ...dependencies.globalProjectionIssues]
    : parsed.incompleteFacts.filter(
        (issue) =>
          issue.message?.id === sourceKey ||
          (issue.message === undefined && issue.origin !== "theme"),
      );
  const issuesForSide = (origin: "source" | "target") =>
    projectionIssues
      .filter((issue) => issue.origin === origin || issue.origin === undefined)
      .map((issue) => issueForIncompleteFact(issue, sourceKey, language));
  sourceIssues.push(...issuesForSide("source"));
  targetIssues.push(...issuesForSide("target"));

  if (parsed.unavailableCapabilities.length > 0) {
    globalIssues.push(
      ...parsed.unavailableCapabilities.map((capability) => ({
        code: "message-family-parser-unavailable",
        message: capability,
        sourceKey,
        language,
      })),
    );
  }
  for (const document of parsed.documents.filter(
    ({ message }) => message.id === sourceKey,
  )) {
    if (document.status === "parsed") continue;
    const issue = {
      code: `message-family-${document.status}`,
      message: `${document.origin === "source" ? "原文" : "译文"} MiniMessage 文档未能完整解析。`,
      sourceKey,
      language: document.origin === "source" ? sourceLanguage : language,
      ref: {
        file: document.file,
        path: [...document.path],
        range: { ...document.range },
      },
    } satisfies MessageFamilyIssue;
    (document.origin === "source" ? sourceIssues : targetIssues).push(issue);
  }
  for (const issue of pairingIssues) {
    const projectedIssue = issueForIncompleteFact(issue, sourceKey, language);
    if (
      issue.code === "minimessage.text-owner-unknown" &&
      issue.origin === "source"
    ) {
      sourceIssues.push(projectedIssue);
    } else {
      // 正文身份已知但没有唯一译文配对时仍保留原文族签名。
      targetIssues.push(projectedIssue);
    }
  }

  const groups: MessageFamilyInput["groups"][number][] = [];
  const projectSide = (document: TranslatableTextDocument): ProjectedDocument =>
    projectDocument(parsed, document);
  for (const sourceDocument of sourceDocuments) {
    const pair = paired.find(
      (candidate) => candidate.sourceDocument === sourceDocument,
    );
    const targetDocument = pair?.targetDocument;
    const sourceProjection = projectSide(sourceDocument);
    const targetProjection =
      targetDocument === undefined ? undefined : projectSide(targetDocument);
    sourceIssues.push(...sourceProjection.issues);
    if (targetProjection !== undefined) {
      targetIssues.push(...targetProjection.issues);
    }
    const documentTargetIssues = targetIssues.filter((issue) =>
      issueAppliesToDocument(issue, sourceDocument),
    );
    const explicitEmptyTarget = isExplicitlyEmptyTarget(
      message,
      sourceDocument,
    );
    const extraTargetContexts =
      targetProjection === undefined
        ? []
        : [...targetProjection.groups.keys()].filter(
            (contextKey) => !sourceProjection.groups.has(contextKey),
          );
    if (extraTargetContexts.length > 0) {
      documentTargetIssues.push({
        code: "message-family-source-context-missing",
        message: "译文包含无法与原文配对的正文上下文。",
        sourceKey,
        language,
        ref: { file: targetDocument!.file, path: [...targetDocument!.path] },
      });
    }

    for (const [contextKey, sourceFragments] of sourceProjection.groups) {
      const targetFragments = targetProjection?.groups.get(contextKey);
      const contextIssues = [...documentTargetIssues];
      if (targetFragments === undefined && !explicitEmptyTarget) {
        contextIssues.push({
          code: "message-family-target-context-missing",
          message: "译文没有提供与该原文上下文对应的正文。",
          sourceKey,
          language,
          ref: {
            file: sourceDocument.file,
            path: [...sourceDocument.path],
            contextKey,
          },
        });
      }
      if (targetProjection?.complete === false)
        contextIssues.push(...targetProjection.issues);
      groups.push(
        familyGroup(
          sourceDocument,
          targetDocument,
          language,
          contextKey,
          sourceFragments,
          targetFragments,
          contextIssues,
          explicitEmptyTarget,
        ),
      );
    }
  }

  for (const sourceDocument of sourceDocuments) {
    if (pairedSources.has(sourceDocument)) continue;
    if (isExplicitlyEmptyTarget(message, sourceDocument)) continue;
    const sourceProjection = projectSide(sourceDocument);
    sourceIssues.push(...sourceProjection.issues);
    for (const [contextKey, sourceFragments] of sourceProjection.groups) {
      groups.push(
        familyGroup(
          sourceDocument,
          undefined,
          language,
          contextKey,
          sourceFragments,
          undefined,
          [
            ...targetIssues.filter((issue) =>
              issueAppliesToDocument(issue, sourceDocument),
            ),
            {
              code: "message-family-target-unpaired",
              message: "原文正文没有唯一的译文对应范围。",
              sourceKey,
              language,
              ref: {
                file: sourceDocument.file,
                path: [...sourceDocument.path],
              },
            },
          ],
        ),
      );
    }
  }

  for (const targetDocument of targetDocuments) {
    if (
      paired.some(
        ({ targetDocument: pairedTarget }) => pairedTarget === targetDocument,
      )
    ) {
      continue;
    }
    targetIssues.push({
      code: "message-family-target-unpaired",
      message: "译文正文没有唯一的原文对应范围。",
      sourceKey,
      language,
      ref: { file: targetDocument.file, path: [...targetDocument.path] },
    });
  }

  const complete = sourceIssues.length === 0 && globalIssues.length === 0;
  return {
    groups,
    complete,
    issues: [...globalIssues, ...sourceIssues, ...targetIssues],
  };
}

// sourceUnit 参与 MemoScope 默认键，避免同键原文事实误共享；内容来自保存记录。
async function projectSavedMessageFamilyReference(
  dependencies: MiniMessageQualityDependencies,
  _sourceUnit: ReferenceProjectionInput["sourceUnit"],
  sourceKey: string,
  translation: ReferenceProjectionInput["translation"],
  language: string,
): Promise<MessageFamilyInput> {
  const message = messageForCandidate(dependencies, sourceKey);
  if (message === undefined || !usesMiniMessage(message)) return { groups: [] };
  const content =
    translation.bodyAvailability === "available"
      ? translation.content
      : undefined;
  return projectMessage(
    dependencies,
    messageWithReference(message, content),
    language,
  );
}

export async function selectLandsMessageFamilyCandidate(
  input: SelectionInput,
): Promise<SelectionResult> {
  const dependencies = dependenciesOf(input.dependencies);
  if (!hasMiniMessageInput(input as MiniMessageCheckInput, dependencies)) {
    return { status: "not-applicable" };
  }
  if (input.sourceUnit === null) return { status: "not-applicable" };
  const message = messageForCandidate(dependencies, sourceKeyFor(input));
  if (message === undefined) {
    return { status: "not-applicable" };
  }
  const projected = await projectMessage(
    dependencies,
    messageWithCandidate(message, input.candidate.content),
    input.candidate.language,
  );
  if (projected.groups.length === 0 && projected.complete !== false) {
    return { status: "not-applicable" };
  }
  return {
    status: "selected",
    subject: {
      sourceUnit: input.sourceUnit,
      sourceKey: input.candidate.sourceKey,
      language: input.candidate.language,
      content: input.candidate.content,
      projected,
    },
  };
}

export function projectLandsMessageFamilyCandidate(
  input: CandidateInput,
): MessageFamilyInput {
  return input.subject.projected;
}

export async function projectLandsMessageFamilyReference(
  input: ProjectionInput,
  context: Parameters<LandsMessageFamilyOptions["project"]>[1],
): Promise<MessageFamilyInput> {
  if (input.kind !== "reference") {
    return input.subject.projected;
  }
  if (input.sourceUnit.unit.context.role !== "message") {
    return { groups: [] };
  }
  const dependencies = dependenciesOf(context.dependencies);
  // 同一 QA 本轮的两个检查共享此保存参照投影；候选草稿走上方独立路径。
  return context.memo.memo(projectSavedMessageFamilyReference)(
    dependencies,
    input.sourceUnit,
    input.sourceKey,
    input.translation,
    input.language,
  );
}

export function landsMessageFamilyFingerprint(
  input: FingerprintInput,
): JsonValue {
  const dependencies = dependenciesOf(input.dependencies);
  return qualityBasis({
    sourceVersion: dependencies.sourceVersion,
    projectionVersion: landsMessageFamilyVersion,
  });
}
