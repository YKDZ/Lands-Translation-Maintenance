import {
  type FrameworkFacts,
  type QualityCheckInput,
  type QualityCheckOutcome,
  type QualityFinding,
  type QualityIssue,
  type QualityLocation,
  type QualityObject,
} from "@lioni/lioni";
import { z } from "zod";

import type { JsonValue } from "#/json-value";
import type {
  LandsStructureProjection,
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import { readLandsStructureProjection } from "#/lioni/lands-facts";
import type { ResourceInventoryEntry } from "#/lioni/lands-model";
import type {
  MiniMessageIncompleteFact,
  MiniMessageInputMessage,
  MiniMessageParseProject,
  MiniMessageProjectionInput,
  MiniMessageThemeInput,
  ParsedMiniMessageDocument,
  TranslatableTextDocument,
} from "#/mini-message-model";
import { parseMiniMessages, usesMiniMessage } from "#/minimessage";
import {
  analyzeMiniMessageTagQuality,
  type MiniMessageTagAnalysis,
} from "#/minimessage-tag-analysis";
import {
  compareMiniMessageBehavior,
  extractMiniMessageBehavior,
  type MiniMessageBehaviorChecks,
  type MiniMessageBehaviorFinding,
} from "#/minimessage-variables";
import {
  pairTranslatableTextDocuments,
  type TranslatableTextPairing,
} from "#/translatable-text-pairing";
import { canonicalJson } from "#/value";

export type LandsFacts = FrameworkFacts<
  LandsUnit,
  LandsTranslation,
  LandsJson,
  UnavailableTranslation
>;
export type MiniMessageCheckInput = QualityCheckInput<
  LandsUnit,
  LandsTranslation,
  Record<string, never>,
  LandsJson,
  UnavailableTranslation
>;

export interface MiniMessageQualityObject extends QualityObject {
  readonly origin?: string;
  readonly code?: string;
}

export interface MiniMessageQualityDependencies {
  readonly sourceVersion: string;
  readonly resources: readonly ResourceInventoryEntry[];
  readonly messages: readonly MiniMessageInputMessage[];
  readonly themeInput: MiniMessageThemeInput;
  readonly projection: MiniMessageParseProject;
  readonly pairing: TranslatableTextPairing;
  /** 按稳定消息身份查找正式解析投影，不建立跨消息族索引。 */
  readonly miniMessageViews: Readonly<
    Record<string, MiniMessageQualityMessageView>
  >;
  readonly globalProjectionIssues: readonly MiniMessageIncompleteFact[];
  readonly tags: MiniMessageTagAnalysis;
  readonly behaviorChecks: readonly MiniMessageBehaviorChecks[];
  readonly landsProjection?: LandsStructureProjection;
  readonly readIssues: readonly MiniMessageIncompleteFact[];
}

export interface MiniMessageQualityMessageView {
  readonly message: MiniMessageInputMessage;
  readonly documents: readonly ParsedMiniMessageDocument[];
  readonly translatableText: readonly TranslatableTextDocument[];
  readonly pairs: TranslatableTextPairing["pairs"];
  readonly pairingIssues: readonly MiniMessageIncompleteFact[];
  readonly incompleteFacts: readonly MiniMessageIncompleteFact[];
}

export const miniMessageQualityConfigurationSchema = z.object({});

export function dependenciesOf(value: unknown): MiniMessageQualityDependencies {
  return value as MiniMessageQualityDependencies;
}

export function tagAnalysisForMessage(
  dependencies: MiniMessageQualityDependencies,
  sourceKey: string,
): MiniMessageTagAnalysis["byMessage"][number]["analysis"] | undefined {
  return dependencies.tags.byMessage.find(
    (entry) => entry.sourceKey === sourceKey,
  )?.analysis;
}

function objectForFinding(
  finding: MiniMessageQualityDependencies["projection"]["findings"][number],
  candidate: MiniMessageCheckInput["candidate"],
): MiniMessageQualityObject {
  const message = finding.message;
  return {
    kind: message === undefined ? "lands-theme" : "lands-message",
    key:
      message?.id ??
      `${finding.location.file}:${canonicalJson(finding.location.path)}`,
    language: candidate.language,
    ...(finding.origin === "theme" ? {} : { origin: finding.origin }),
    code: finding.code,
  };
}

function locationForFinding(
  finding: MiniMessageQualityDependencies["projection"]["findings"][number],
  language: string,
): QualityLocation {
  return {
    language: finding.origin === "target" ? language : null,
    range: {
      file: finding.location.file,
      path: finding.location.path,
      ...(finding.location.line === undefined
        ? {}
        : { line: finding.location.line }),
      ...(finding.location.column === undefined
        ? {}
        : { column: finding.location.column }),
      ...(finding.position === undefined
        ? {}
        : {
            start: finding.position.start,
            end: finding.position.end,
          }),
    },
  };
}

export function findingForQuality(
  finding: MiniMessageQualityDependencies["projection"]["findings"][number],
  candidate: MiniMessageCheckInput["candidate"],
): QualityFinding<MiniMessageQualityObject> {
  const object = objectForFinding(finding, candidate);
  const location = locationForFinding(finding, candidate.language);
  return {
    severity: "error",
    object,
    location,
    message: finding.reason,
    evidence: [
      { role: "expected", object, location, value: finding.expected },
      { role: "actual", object, location, value: finding.actual },
    ],
  };
}

/** 把变量及交互检查的领域结果映射到原生 QA 诊断位置。 */
export function behaviorFindingForQuality(
  finding: MiniMessageBehaviorFinding,
  candidate: MiniMessageCheckInput["candidate"],
): QualityFinding<MiniMessageQualityObject> {
  const object: MiniMessageQualityObject = {
    kind: "lands-message",
    key: finding.message.id,
    language: candidate.language,
    origin: finding.origin,
    code: finding.code,
  };
  const location: QualityLocation = {
    language: candidate.language,
    range: {
      file: finding.message.targetFile,
      path: finding.message.path,
      ...(finding.position === undefined
        ? {}
        : {
            start: finding.position.start,
            end: finding.position.end,
          }),
    },
  };
  return {
    severity: "error",
    object,
    location,
    message: finding.reason,
    evidence: [
      { role: "expected", object, location, value: finding.expected },
      { role: "actual", object, location, value: finding.actual },
    ],
  };
}

export function behaviorChecksForMessage(
  dependencies: MiniMessageQualityDependencies,
  sourceKey: string,
): MiniMessageBehaviorChecks | undefined {
  return dependencies.behaviorChecks.find(
    (checks) => checks.messageId === sourceKey,
  );
}

export function behaviorIssuesForMessage(
  dependencies: MiniMessageQualityDependencies,
  sourceKey: string,
): readonly MiniMessageIncompleteFact[] {
  return (
    dependencies.behaviorChecks.find((checks) => checks.messageId === sourceKey)
      ?.issues ?? []
  );
}

export function issueForQuality(
  issue: MiniMessageIncompleteFact,
  candidate: MiniMessageCheckInput["candidate"],
): QualityIssue<MiniMessageQualityObject> {
  const object: MiniMessageQualityObject = {
    kind: issue.origin === "theme" ? "lands-theme" : "lands-message",
    key:
      issue.message?.id ??
      (issue.location === undefined
        ? candidate.sourceKey
        : `${issue.location.file}:${canonicalJson(issue.location.path)}`),
    language: candidate.language,
    ...(issue.origin === undefined ? {} : { origin: issue.origin }),
  };
  const location =
    issue.location === undefined
      ? undefined
      : {
          language: issue.origin === "target" ? candidate.language : null,
          range: {
            file: issue.location.file,
            path: issue.location.path,
            ...(issue.location.line === undefined
              ? {}
              : { line: issue.location.line }),
            ...(issue.location.column === undefined
              ? {}
              : { column: issue.location.column }),
          },
        };
  return {
    code: issue.code,
    message: issue.reason,
    object,
    ...(location === undefined ? {} : { location }),
  };
}

export function outcome(
  status: QualityCheckOutcome["status"],
  diagnostics: readonly QualityFinding<MiniMessageQualityObject>[],
  issues: readonly QualityIssue<MiniMessageQualityObject>[],
): QualityCheckOutcome<MiniMessageQualityObject> {
  return {
    status,
    diagnostics,
    issues,
    coverage: {
      selected: 1,
      evaluated: status === "complete" ? 1 : 0,
      notApplicable: status === "not-applicable" ? 1 : 0,
      incomplete: status === "incomplete" ? 1 : 0,
      failed: status === "failed" ? 1 : 0,
    },
  };
}

export function messageForCandidate(
  dependencies: MiniMessageQualityDependencies,
  sourceKey: string,
): MiniMessageInputMessage | undefined {
  return dependencies.messages.find((message) => message.id === sourceKey);
}

export function qualityBasis(value: unknown): JsonValue {
  return value as JsonValue;
}

export function hasMiniMessageInput(
  input: MiniMessageCheckInput,
  dependencies: MiniMessageQualityDependencies,
): boolean {
  const message = messageForCandidate(dependencies, input.candidate.sourceKey);
  if (message === undefined || !usesMiniMessage(message)) return false;
  return hasAvailableMiniMessageTranslation(
    input,
    input.candidate.sourceKey,
    input.candidate.language,
  );
}

/** 仅为已关联到唯一可用译文的候选启用正文检查。 */
export function hasAvailableMiniMessageTranslation(
  input: MiniMessageCheckInput,
  sourceKey: string,
  language: string,
): boolean {
  const association = input.facts.associations.find(
    (candidate) =>
      candidate.sourceKey === sourceKey && candidate.language === language,
  );
  if (
    association?.status !== "matched" ||
    association.translationIndexes.length !== 1
  ) {
    return false;
  }
  const translation = input.facts.translations.records.find(
    ({ index }) => index === association.translationIndexes[0],
  );
  return translation?.bodyAvailability === "available";
}

export async function projectMiniMessageQualityInputs(
  input: MiniMessageProjectionInput,
  options: {
    readonly readIssues?: readonly MiniMessageIncompleteFact[];
    readonly landsProjection?: LandsStructureProjection;
  } = {},
): Promise<MiniMessageQualityDependencies> {
  const projection = await parseMiniMessages(input);
  const pairing = pairTranslatableTextDocuments(projection);
  const miniMessageViews = new Map<
    string,
    {
      readonly message: MiniMessageInputMessage;
      readonly documents: ParsedMiniMessageDocument[];
      readonly translatableText: TranslatableTextDocument[];
      readonly pairs: TranslatableTextPairing["pairs"][number][];
      readonly pairingIssues: MiniMessageIncompleteFact[];
      readonly incompleteFacts: MiniMessageIncompleteFact[];
    }
  >();
  for (const message of input.messages) {
    miniMessageViews.set(message.id, {
      message,
      documents: [],
      translatableText: [],
      pairs: [],
      pairingIssues: [],
      incompleteFacts: [],
    });
  }
  for (const document of projection.documents) {
    miniMessageViews.get(document.message.id)?.documents.push(document);
  }
  for (const document of projection.translatableText) {
    miniMessageViews.get(document.message.id)?.translatableText.push(document);
  }
  for (const pair of pairing.pairs) {
    miniMessageViews.get(pair.sourceDocument.message.id)?.pairs.push(pair);
  }
  for (const issue of pairing.incomplete) {
    if (issue.message !== undefined) {
      miniMessageViews.get(issue.message.id)?.pairingIssues.push(issue);
    }
  }
  for (const issue of projection.incompleteFacts) {
    if (issue.message !== undefined) {
      miniMessageViews.get(issue.message.id)?.incompleteFacts.push(issue);
    }
  }
  return {
    sourceVersion: input.sourceVersion,
    resources: input.resources,
    messages: input.messages,
    themeInput: input.theme,
    projection,
    pairing,
    miniMessageViews: Object.fromEntries(miniMessageViews),
    globalProjectionIssues: projection.incompleteFacts.filter(
      ({ message, origin }) => message === undefined && origin !== "theme",
    ),
    tags: analyzeMiniMessageTagQuality(input.messages, projection),
    behaviorChecks: compareMiniMessageBehavior(
      extractMiniMessageBehavior(projection),
    ),
    ...(options.landsProjection === undefined
      ? {}
      : { landsProjection: options.landsProjection }),
    readIssues: options.readIssues ?? [],
  };
}

function themeInputFrom(
  projection: LandsStructureProjection,
): MiniMessageThemeInput {
  if (projection.theme.status === "available") {
    return {
      theme: {
        file: projection.theme.file,
        source: projection.theme.source,
      },
      issues: [],
    };
  }
  if (projection.theme.status === "missing") return { issues: [] };
  const locationFile = projection.theme.files[0] ?? "theme.yml";
  return {
    issues: [
      {
        code: `minimessage.theme-${projection.theme.status}`,
        origin: "theme",
        location: { file: locationFile, path: [] },
        reason:
          projection.theme.status === "ambiguous"
            ? `主题资源不唯一：${projection.theme.files.join("、")}`
            : `主题资源不可用：${projection.theme.files.join("、")}`,
      },
    ],
  };
}

function factReadIssues(facts: LandsFacts): MiniMessageIncompleteFact[] {
  const issues: MiniMessageIncompleteFact[] = [];
  if (facts.source.read.status !== "complete") {
    issues.push({
      code: "minimessage.source-read-incomplete",
      reason: facts.source.read.error ?? "Lands 原文读取不完整",
    });
  }
  for (const translation of facts.translations.reads) {
    if (translation.status === "complete") continue;
    issues.push({
      code: "minimessage.target-read-incomplete",
      reason:
        translation.error ?? `Lands ${translation.language} 译文读取不完整`,
    });
  }
  return issues;
}

/** 在原生 QA 的依赖加载阶段使用已校验快照和真实 Lands 事实准备共享投影。 */
export async function loadMiniMessageQualityDependencies(
  entryUrl: string | URL,
  facts: LandsFacts,
): Promise<MiniMessageQualityDependencies> {
  const readIssues = factReadIssues(facts);
  let landsProjection: LandsStructureProjection | undefined;
  let sourceVersion = "";
  let theme: MiniMessageThemeInput = { issues: [] };
  try {
    landsProjection = await readLandsStructureProjection(
      entryUrl,
      facts.source.units,
    );
    sourceVersion = landsProjection.sourceVersion;
    theme = themeInputFrom(landsProjection);
  } catch (error) {
    readIssues.push({
      code: "minimessage.project-input-unavailable",
      reason:
        error instanceof Error
          ? `Lands 来源快照或配置不可用：${error.message}`
          : `Lands 来源快照或配置不可用：${String(error)}`,
    });
  }
  const factInputs = miniMessageFactsInput(
    facts,
    landsProjection?.resources ?? [],
  );
  const input: MiniMessageProjectionInput = {
    messages: factInputs.messages,
    resources: factInputs.resources,
    theme,
    sourceVersion,
  };
  const projected = await projectMiniMessageQualityInputs(input, {
    readIssues,
    ...(landsProjection === undefined ? {} : { landsProjection }),
  });
  return projected;
}

export function miniMessageFactsInput(
  facts: LandsFacts,
  resources: readonly ResourceInventoryEntry[],
): {
  readonly messages: readonly MiniMessageInputMessage[];
  readonly resources: readonly ResourceInventoryEntry[];
} {
  const translationByIndex = new Map(
    facts.translations.records.map((record) => [record.index, record]),
  );
  const associations = new Map(
    facts.associations.map((association) => [
      association.sourceKey,
      association,
    ]),
  );
  const messages = facts.source.units.flatMap(({ key, unit }) => {
    if (unit.context.role !== "message") return [];
    const association = associations.get(key);
    const targetRecord =
      association?.status === "matched" &&
      association.translationIndexes.length === 1
        ? translationByIndex.get(association.translationIndexes[0]!)
        : undefined;
    const target =
      targetRecord?.bodyAvailability === "available"
        ? targetRecord.content
        : undefined;
    return [
      {
        id: key,
        sourceFile: unit.context.sourceFile,
        targetFile: unit.context.targetFile,
        path: unit.context.path,
        category: unit.context.category,
        ...(unit.context.scene === undefined
          ? {}
          : { scene: unit.context.scene }),
        ...(unit.context.format === undefined
          ? {}
          : { format: unit.context.format }),
        source: unit.source,
        ...(target === undefined ? {} : { target }),
        targetStatus:
          association?.status === "matched" && target !== undefined
            ? "present"
            : association?.status === "missing"
              ? "missing"
              : "blocked",
      } satisfies MiniMessageInputMessage,
    ];
  });
  return { messages, resources };
}
