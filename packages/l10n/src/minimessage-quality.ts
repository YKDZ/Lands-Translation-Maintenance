import {
  defineQualityCheck,
  type FrameworkFacts,
  type QualityCheckInput,
  type QualityCheckOutcome,
  type QualityFinding,
  type QualityIssue,
  type QualityLocation,
  type QualityObject,
} from "@lioni/lioni";
import { z } from "zod";

import type {
  LandsStructureProjection,
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import { readLandsStructureProjection } from "#/lioni/lands-facts";
import type {
  MiniMessageIncompleteFact,
  MiniMessageInputMessage,
  MiniMessageParseProject,
  MiniMessageProjectionInput,
  MiniMessageThemeInput,
} from "#/mini-message-model";
import { parseMiniMessages, usesMiniMessage } from "#/minimessage";
import type { JsonValue, ResourceInventoryEntry } from "#/model";
import {
  pairTranslatableTextDocuments,
  type TranslatableTextPairing,
} from "#/translatable-text-pairing";
import { canonicalJson } from "#/value";

type LandsFacts = FrameworkFacts<
  LandsUnit,
  LandsTranslation,
  LandsJson,
  UnavailableTranslation
>;
type MiniMessageCheckInput = QualityCheckInput<
  LandsUnit,
  LandsTranslation,
  Record<string, never>,
  LandsJson,
  UnavailableTranslation
>;

interface MiniMessageQualityObject extends QualityObject {
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
  readonly landsProjection?: LandsStructureProjection;
  readonly readIssues: readonly MiniMessageIncompleteFact[];
}

const checkConfigurationSchema = z.object({});

function dependenciesOf(value: unknown): MiniMessageQualityDependencies {
  return value as MiniMessageQualityDependencies;
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

function findingForQuality(
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

function issueForQuality(
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

function outcome(
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

function messageForCandidate(
  dependencies: MiniMessageQualityDependencies,
  sourceKey: string,
): MiniMessageInputMessage | undefined {
  return dependencies.messages.find((message) => message.id === sourceKey);
}

function qualityBasis(value: unknown): JsonValue {
  return value as JsonValue;
}

function hasMiniMessageInput(
  input: MiniMessageCheckInput,
  dependencies: MiniMessageQualityDependencies,
): boolean {
  const message = messageForCandidate(dependencies, input.candidate.sourceKey);
  return message !== undefined && usesMiniMessage(message);
}

function relevantSyntaxIssues(
  input: MiniMessageCheckInput,
  dependencies: MiniMessageQualityDependencies,
): readonly MiniMessageIncompleteFact[] {
  const sourceKey = input.candidate.sourceKey;
  return [
    ...dependencies.readIssues,
    ...dependencies.projection.incompleteFacts,
  ].filter(
    (issue) => issue.message === undefined || issue.message.id === sourceKey,
  );
}

function relevantThemeIssues(
  input: MiniMessageCheckInput,
  dependencies: MiniMessageQualityDependencies,
): readonly MiniMessageIncompleteFact[] {
  const sourceKey = input.candidate.sourceKey;
  const projectIssueOwner = primaryThemeSourceKey(dependencies);
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

function primaryThemeSourceKey(
  dependencies: MiniMessageQualityDependencies,
): string | undefined {
  return dependencies.messages
    .filter(usesMiniMessage)
    .map(({ id }) => id)
    .sort()[0];
}

function syntaxFindingsFor(
  input: MiniMessageCheckInput,
  dependencies: MiniMessageQualityDependencies,
) {
  return dependencies.projection.syntaxFindings.filter(
    (finding) => finding.message?.id === input.candidate.sourceKey,
  );
}

function themeFindingsFor(
  input: MiniMessageCheckInput,
  dependencies: MiniMessageQualityDependencies,
) {
  const projectIssueOwner = primaryThemeSourceKey(dependencies);
  return dependencies.projection.themeFindings.filter((finding) => {
    if (finding.message === undefined)
      return input.candidate.sourceKey === projectIssueOwner;
    return finding.message.id === input.candidate.sourceKey;
  });
}

function syntaxBasis(
  input: MiniMessageCheckInput,
  dependencies: MiniMessageQualityDependencies,
): JsonValue {
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
            category: message.category,
            scene: message.scene ?? null,
            format: message.format ?? null,
            source: message.source,
            target:
              input.candidate.content === undefined
                ? { state: "unavailable" }
                : input.candidate.content,
          },
    findings: syntaxFindingsFor(input, dependencies).map((finding) => ({
      code: finding.code,
      origin: finding.origin,
      location: finding.location,
      position: finding.position ?? null,
      reason: finding.reason,
      expected: finding.expected,
      actual: finding.actual,
    })),
    incomplete: relevantSyntaxIssues(input, dependencies).map(
      ({ code, reason, location }) => ({
        code,
        reason,
        location: location ?? null,
      }),
    ),
  });
}

function themeBasis(
  input: MiniMessageCheckInput,
  dependencies: MiniMessageQualityDependencies,
): JsonValue {
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
    themeFindings: themeFindingsFor(input, dependencies).map((finding) => ({
      code: finding.code,
      origin: finding.origin,
      location: finding.location,
      position: finding.position ?? null,
      reason: finding.reason,
      expected: finding.expected,
      actual: finding.actual,
    })),
    incomplete: relevantThemeIssues(input, dependencies).map(
      ({ code, reason, location }) => ({
        code,
        reason,
        location: location ?? null,
      }),
    ),
  });
}

export async function projectMiniMessageQualityInputs(
  input: MiniMessageProjectionInput,
  options: {
    readonly readIssues?: readonly MiniMessageIncompleteFact[];
    readonly landsProjection?: LandsStructureProjection;
  } = {},
): Promise<MiniMessageQualityDependencies> {
  const projection = await parseMiniMessages(input);
  return {
    sourceVersion: input.sourceVersion,
    resources: input.resources,
    messages: input.messages,
    themeInput: input.theme,
    projection,
    pairing: pairTranslatableTextDocuments(projection),
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

export const miniMessageSyntaxCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof checkConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "minimessage-syntax",
  version: "1",
  configurationSchema: checkConfigurationSchema,
  configuration: {},
  fingerprintInput: (input) =>
    syntaxBasis(input, dependenciesOf(input.dependencies)),
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
    const diagnostics = syntaxFindingsFor(input, dependencies).map((finding) =>
      findingForQuality(finding, input.candidate),
    );
    const issues = relevantSyntaxIssues(input, dependencies).map((issue) =>
      issueForQuality(issue, input.candidate),
    );
    return outcome(
      issues.length === 0 ? "complete" : "incomplete",
      diagnostics,
      issues,
    );
  },
});

export const miniMessageThemeCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof checkConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "minimessage-theme",
  version: "1",
  configurationSchema: checkConfigurationSchema,
  configuration: {},
  fingerprintInput: (input) =>
    themeBasis(input, dependenciesOf(input.dependencies)),
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
    const diagnostics = themeFindingsFor(input, dependencies).map((finding) =>
      findingForQuality(finding, input.candidate),
    );
    const issues = relevantThemeIssues(input, dependencies).map((issue) =>
      issueForQuality(issue, input.candidate),
    );
    return outcome(
      issues.length === 0 ? "complete" : "incomplete",
      diagnostics,
      issues,
    );
  },
});

export const miniMessageQualityChecks = [
  miniMessageSyntaxCheck,
  miniMessageThemeCheck,
] as const;

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
  const messages = facts.source.units.map(({ key, unit }) => {
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
    return {
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
    } satisfies MiniMessageInputMessage;
  });
  return { messages, resources };
}

export type { LandsFacts, MiniMessageCheckInput };
