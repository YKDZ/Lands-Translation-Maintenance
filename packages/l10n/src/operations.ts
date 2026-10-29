import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, join } from "node:path";

import { isMap, type Document } from "yaml";

import {
  parseConfiguration,
  syncConfigurationFingerprint,
} from "#/configuration";
import {
  emptyExceptionRecords,
  parseExceptionRecords,
  serializeExceptionRecords,
  type ExceptionRecords,
} from "#/exceptions";
import { readJarResources } from "#/jar";
import { collectMessages } from "#/messages";
import type { MiniMessageThemeSnapshot } from "#/mini-message-model";
import { parseMiniMessages } from "#/minimessage";
import { miniMessageTagCoverageUnavailable } from "#/minimessage-tags";
import { captureMiniMessageTheme } from "#/minimessage-theme";
import type {
  CheckCoverage,
  CheckRule,
  ConsumerConfiguration,
  Diagnostic,
  DiagnosticLocation,
  CheckConclusion,
  ConclusionSubject,
  ExceptionRecord,
  SameTextPendingReason,
  JsonValue,
  KnownExcludedResource,
  KnownOutOfScopeVisibleText,
  ObservedMessage,
  ProjectFileIssue,
  ProjectReport,
  ProjectSummary,
  ProjectStructure,
  ProjectView,
  ResourceInventoryDifference,
  RuleInput,
  RuleInputDependency,
  ResourceInventoryEntry,
  Severity,
} from "#/model";
import {
  builtInRules,
  evaluateRules,
  inputDependenciesForDiagnostic,
} from "#/rules";
import {
  baselineFileName,
  baselineDirectoryName,
  configurationFileName,
  lockFileName,
  readState,
  resourceSetFingerprint,
  syncLockIntegrity,
  serializeBaseline,
  serializeLock,
  stateDirectoryName,
  transactionFileName,
  type MappingSnapshot,
  type ReleasedTranslationPath,
  type ResourceSnapshot,
  type SameTextCandidate,
  type SourceBaseline,
  type SyncLock,
  type TranslationSeed,
  exceptionsFileName,
} from "#/state";
import {
  assertFileSnapshots,
  captureFileSnapshots,
  ConcurrentEditError,
  recoverInterruptedTransaction,
  writeFilesAtomically,
  type FileSnapshot,
  type FileWrite,
} from "#/transaction";
import { pairTranslatableTextDocuments } from "#/translatable-text-pairing";
import { translationReviewRule } from "#/translation-review";
import { canonicalJson, compareText, sameValue, sha256 } from "#/value";
import { parseYaml, setDocumentPath, valueAtPath } from "#/yaml-data";

export class ProjectOperationError extends Error {
  readonly diagnosticCode: string;
  readonly location: DiagnosticLocation;

  constructor(
    message: string,
    diagnosticCode = "state.invalid",
    location: DiagnosticLocation = { file: stateDirectoryName, path: [] },
  ) {
    super(message);
    this.name = "ProjectOperationError";
    this.diagnosticCode = diagnosticCode;
    this.location = location;
  }
}

export interface InitializationOptions {
  readonly beforeApply?: () => Promise<void>;
}

export interface ExceptionRecordingOptions {
  readonly beforeApply?: () => Promise<void>;
}

export interface ExceptionReceipt {
  readonly id: string;
  readonly contentFingerprint: string;
  readonly reason: string;
}

interface ReadBytes {
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly sha256: string;
}

interface TargetFileInput {
  readonly originalSha256: string | undefined;
  readonly document: Document;
  readonly value: JsonValue;
}

function missingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function readBytes(path: string, label: string): Promise<ReadBytes> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (missingError(error))
      throw new ProjectOperationError(`找不到${label}：${path}`);
    throw error;
  }
  return {
    bytes,
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    sha256: sha256(bytes),
  };
}

async function readBinary(path: string, label: string) {
  try {
    const bytes = await readFile(path);
    return { bytes, sha256: sha256(bytes) };
  } catch (error) {
    if (missingError(error))
      throw new ProjectOperationError(`找不到${label}：${path}`);
    throw error;
  }
}

async function readOptionalBytes(path: string): Promise<ReadBytes | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (missingError(error)) return undefined;
    throw error;
  }
  if (!info.isFile()) {
    throw new ProjectOperationError(
      `项目文件必须是普通文件：${path}`,
      "structure.not-regular-file",
      { file: path, path: [] },
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (missingError(error)) return undefined;
    throw error;
  }
  return {
    bytes,
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    sha256: sha256(bytes),
  };
}

async function assertNoSymlinkPath(
  projectDirectory: string,
  relativePath: string,
): Promise<void> {
  let current = projectDirectory;
  const parts = relativePath.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (missingError(error)) return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new ProjectOperationError(
        `项目维护路径不能经过符号链接：${current}`,
        "structure.symlink-path",
        { file: relativePath, path: [] },
      );
    }
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new ProjectOperationError(`项目路径中间部分不是目录：${current}`);
    }
  }
}

function resolveProjectFile(
  projectDirectory: string,
  relativePath: string,
): string {
  const projectPath = resolve(projectDirectory);
  const filePath = resolve(projectPath, relativePath);
  const pathFromProject = relative(projectPath, filePath);
  if (
    pathFromProject === ".." ||
    pathFromProject.startsWith(`..${sep}`) ||
    isAbsolute(pathFromProject)
  ) {
    throw new ProjectOperationError(`项目文件路径越界：${relativePath}`);
  }
  return filePath;
}

function requireConfiguration(source: string) {
  const result = parseConfiguration(source);
  if (!result.ok) {
    const detail = result.issues
      .map((issue) => `${issue.code}：${issue.reason}（${issue.actual}）`)
      .join("；");
    throw new ProjectOperationError(
      `维护清单无效：${detail}`,
      "configuration.invalid",
      { file: configurationFileName, path: [] },
    );
  }
  return result.value;
}

function miniMessageThemeForBaseline(
  resources: readonly ResourceInventoryEntry[],
  resourceBytes: ReadonlyMap<string, Uint8Array>,
): MiniMessageThemeSnapshot | undefined {
  return captureMiniMessageTheme(resources, resourceBytes).theme;
}

function readYaml(bytes: Uint8Array, file: string) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = parseYaml(source, file);
  if (!parsed.ok) {
    const detail = parsed.issues
      .map(
        (issue) =>
          `${issue.code}：${issue.reason}${issue.line === undefined ? "" : `（第 ${issue.line} 行）`}`,
      )
      .join("；");
    throw new ProjectOperationError(`${file} 无法无歧义解析：${detail}`);
  }
  return parsed.parsed;
}

function knownOutOfScopeVisibleTexts(
  resources: readonly ResourceInventoryEntry[],
  jarByPath: ReadonlyMap<string, Uint8Array>,
): KnownOutOfScopeVisibleText[] {
  const fields = [
    { file: "config.yml", path: ["camp", "default-name"] },
    { file: "web.yml", path: ["map", "general", "layer"] },
  ] as const;
  const declaredConfiguration = new Set(
    resources
      .filter((resource) => resource.purpose === "configuration")
      .map((resource) => resource.path),
  );
  const visibleTexts: KnownOutOfScopeVisibleText[] = [];
  for (const field of fields) {
    if (!declaredConfiguration.has(field.file)) continue;
    const bytes = jarByPath.get(field.file);
    if (bytes === undefined) continue;
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      continue;
    }
    const parsed = parseYaml(source, field.file);
    if (!parsed.ok) continue;
    const value = valueAtPath(parsed.parsed.value, field.path);
    if (typeof value !== "string") continue;
    visibleTexts.push({ ...field, value });
  }
  return visibleTexts;
}

function readMappingSnapshot(
  mapping: ConsumerConfiguration["translationScope"]["mappings"][number],
  jarResources: ReadonlyMap<string, Uint8Array>,
): MappingSnapshot {
  const sourceBytes = jarResources.get(mapping.source);
  if (sourceBytes === undefined) {
    throw new ProjectOperationError(`映射原文不在 JAR 中：${mapping.source}`);
  }
  const sourceValue = readYaml(sourceBytes, mapping.source).value;
  const definitionsSource = mapping.definitionsSource;
  if (definitionsSource === undefined || definitionsSource === mapping.source) {
    return {
      mapping,
      sourceValue,
      sourceSha256: sha256(canonicalJson(sourceValue)),
    };
  }
  const definitionsBytes = jarResources.get(definitionsSource);
  if (definitionsBytes === undefined) {
    throw new ProjectOperationError(
      `结构定义不在 JAR 中：${definitionsSource}`,
      "configuration.mapping-definitions-missing",
      { file: definitionsSource, path: [] },
    );
  }
  const definitionsValue = readYaml(definitionsBytes, definitionsSource).value;
  return {
    mapping,
    sourceValue,
    sourceSha256: sha256(canonicalJson(sourceValue)),
    definitionsValue,
    definitionsSha256: sha256(canonicalJson(definitionsValue)),
  };
}

function resourceMismatches(
  declared: readonly ResourceInventoryEntry[],
  actual: readonly { readonly path: string }[],
  duplicates: readonly string[],
): string | undefined {
  const difference = compareResourceInventory(declared, actual, duplicates);
  const differences = [
    ...(difference.missing.length === 0
      ? []
      : [`声明中不存在的资源：${difference.missing.join("、")}`]),
    ...(difference.undeclared.length === 0
      ? []
      : [`尚未登记的新资源：${difference.undeclared.join("、")}`]),
    ...(difference.duplicates.length === 0
      ? []
      : [`JAR 中有重复路径：${difference.duplicates.join("、")}`]),
  ];
  return differences.length === 0 ? undefined : differences.join("；");
}

function compareResourceInventory(
  declared: readonly ResourceInventoryEntry[],
  actual: readonly { readonly path: string }[],
  duplicates: readonly string[],
): ResourceInventoryDifference {
  const declaredPaths = declared.map((entry) => entry.path).sort(compareText);
  const actualPaths = actual.map((entry) => entry.path).sort(compareText);
  const declaredSet = new Set(declaredPaths);
  const actualSet = new Set(actualPaths);
  return {
    undeclared: actualPaths.filter((path) => !declaredSet.has(path)),
    missing: declaredPaths.filter((path) => !actualSet.has(path)),
    duplicates: [...duplicates].sort(compareText),
  };
}

function sourceMessageIssues(
  mappings: readonly MappingSnapshot[],
  resources: readonly ResourceSnapshot[],
): readonly ProjectFileIssue[] {
  return collectMessages(
    mappings.map(({ mapping, sourceValue }) => ({ mapping, sourceValue })),
    new Map(),
    resources,
  ).issues.filter((issue) =>
    mappings.some((mapping) => mapping.mapping.source === issue.file),
  );
}

function isValidTargetValue(
  category: ObservedMessage["category"],
  target: JsonValue | undefined,
): boolean {
  if (
    category === "chat-string" ||
    category === "gui-string" ||
    category === "dialog-string" ||
    category === "dialog-label-format" ||
    category === "configuration-string"
  ) {
    return typeof target === "string";
  }
  if (category === "gui-lore") {
    return (
      typeof target === "string" ||
      (Array.isArray(target) &&
        target.every((item) => typeof item === "string"))
    );
  }
  if (Array.isArray(target)) {
    return target.every((item) => typeof item === "string");
  }
  return false;
}

function updateDocumentValue(
  document: TargetFileInput["document"],
  path: readonly string[],
  value: JsonValue,
): void {
  setDocumentPath(document, path, value);
}

function addTargetIssue(
  issues: ProjectFileIssue[],
  file: string,
  code: string,
  reason: string,
  actual?: JsonValue,
): void {
  issues.push({
    file,
    code,
    reason,
    path: [],
    expected: { state: "mapping" },
    actual: actual === undefined ? { issue: code } : actual,
  });
}

async function readTargets(
  projectDirectory: string,
  baseline: SourceBaseline,
): Promise<{
  readonly targets: ReadonlyMap<string, TargetFileInput>;
  readonly snapshots: readonly FileSnapshot[];
  readonly issues: readonly ProjectFileIssue[];
}> {
  const inputs = new Map<string, TargetFileInput>();
  const snapshots: FileSnapshot[] = [];
  const issues: ProjectFileIssue[] = [];
  const targetPaths = [
    ...new Set(baseline.mappings.map((entry) => entry.mapping.target)),
  ];

  for (const relativePath of targetPaths) {
    await assertNoSymlinkPath(projectDirectory, relativePath);
    const targetPath = resolveProjectFile(projectDirectory, relativePath);
    const original = await readOptionalBytes(targetPath);
    snapshots.push({ path: targetPath, sha256: original?.sha256 });
    let parsed;
    if (original === undefined) {
      parsed = readYaml(new TextEncoder().encode("{}\n"), relativePath);
      addTargetIssue(
        issues,
        relativePath,
        "target-missing",
        "目标译文文件不存在",
      );
    } else {
      const parseResult = parseYaml(original.text, relativePath);
      if (!parseResult.ok) {
        issues.push(...parseResult.issues);
        continue;
      }
      parsed = parseResult.parsed;
    }
    if (!isMap(parsed.document.contents)) {
      addTargetIssue(
        issues,
        relativePath,
        "yaml-root-invalid",
        "目标 YAML 根节点必须是映射",
        parsed.value,
      );
      continue;
    }
    inputs.set(relativePath, {
      originalSha256: original?.sha256,
      document: parsed.document,
      value: parsed.value,
    });
  }
  return { targets: inputs, snapshots, issues };
}

function stateSummary(project: ProjectView, lock: SyncLock): ProjectSummary {
  const messages = new Map(
    project.messages.map((message) => [message.id, message]),
  );
  let pendingTranslations = 0;
  let sameTextCandidates = 0;
  let confirmedSameText = 0;
  let modifiedTranslations = 0;
  let missingTranslations = 0;

  for (const message of project.messages) {
    if (message.targetStatus === "missing") missingTranslations += 1;
  }
  for (const seed of lock.translationSeeds) {
    const message = messages.get(seed.id);
    if (
      message === undefined ||
      message.targetStatus !== "present" ||
      message.target === undefined
    )
      continue;
    if (sameValue(message.target, message.source)) {
      if (message.translationReview?.confirmedSameText === true)
        confirmedSameText += 1;
      else pendingTranslations += 1;
    } else modifiedTranslations += 1;
  }
  for (const candidate of lock.sameTextCandidates) {
    const message = messages.get(candidate.id);
    if (
      message !== undefined &&
      message.targetStatus === "present" &&
      message.target !== undefined &&
      sameValue(message.target, message.source)
    ) {
      if (message.translationReview?.confirmedSameText === true)
        confirmedSameText += 1;
      else sameTextCandidates += 1;
    }
  }

  return {
    resourceFiles: project.resources.length,
    messages: project.messages.length,
    pendingTranslations,
    sameTextCandidates,
    confirmedSameText,
    modifiedTranslations,
    missingTranslations,
  };
}

function diagnostic(
  ruleId: string,
  code: string,
  severity: Severity,
  reason: string,
  location: DiagnosticLocation,
  expected: JsonValue,
  actual: JsonValue,
): Diagnostic {
  const objectId = sha256(
    canonicalJson({
      ruleId,
      code,
      location: { file: location.file, path: location.path },
    }),
  );
  const contentFingerprint = sha256(
    canonicalJson({ ruleId, severity, expected, actual }),
  );
  const diagnosticId = sha256(
    canonicalJson({ ruleId, code, objectId, contentFingerprint }),
  );
  return {
    diagnosticId,
    objectId,
    contentFingerprint,
    ruleId,
    severity,
    code,
    location,
    reason,
    expected,
    actual,
  };
}

function checkConclusion(finding: Diagnostic): CheckConclusion {
  const { diagnosticId, severity, reason, ...subject } = finding;
  void severity;
  const requiredInputDependencies = inputDependenciesForDiagnostic(finding);
  return {
    ...subject,
    id: diagnosticId,
    description: reason,
    ...(requiredInputDependencies === undefined
      ? {}
      : { requiredInputDependencies }),
  };
}

function makeReport(
  operation: ProjectReport["operation"],
  project: ProjectView,
  lock: SyncLock,
  diagnostics: readonly Diagnostic[],
  coverage?: CheckCoverage,
  exceptionCandidates: readonly CheckConclusion[] = [],
): ProjectReport {
  const state = diagnostics.some((item) => item.severity === "error")
    ? "issues"
    : coverage?.complete === false
      ? "incomplete"
      : "ready";
  return {
    operation,
    state,
    summary: stateSummary(project, lock),
    diagnostics: [...diagnostics].sort((left, right) =>
      compareText(canonicalJson(left), canonicalJson(right)),
    ),
    exceptionCandidates,
    knownExcludedResources: project.resources
      .filter(
        (resource): resource is KnownExcludedResource =>
          resource.purpose === "bedrock-excluded" ||
          resource.purpose === "other-excluded",
      )
      .map(({ path, purpose }) => ({ path, purpose }))
      .sort((left, right) => compareText(left.path, right.path)),
    knownOutOfScopeVisibleTexts: project.knownOutOfScopeVisibleTexts,
    ...(coverage === undefined ? {} : { coverage }),
  };
}

function emptyView(): ProjectView {
  return {
    sourceLanguage: "",
    targetLanguage: "",
    resources: [],
    messages: [],
    targetMessages: [],
    structures: [],
    knownOutOfScopeVisibleTexts: [],
    fileIssues: [],
  };
}

function isRecord(value: JsonValue | undefined): value is {
  readonly [key: string]: JsonValue;
} {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structureValueType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "列表";
  if (isRecord(value)) return "映射";
  if (typeof value === "string") return "字符串";
  if (typeof value === "number") return "数字";
  return "布尔值";
}

function definitionsValueOf(mapping: MappingSnapshot): JsonValue | undefined {
  if (mapping.mapping.definitionsSource === undefined) return undefined;
  return mapping.mapping.definitionsSource === mapping.mapping.source
    ? mapping.sourceValue
    : mapping.definitionsValue;
}

function makeProjectStructures(
  mappings: readonly MappingSnapshot[],
  targets: ReadonlyMap<string, TargetFileInput>,
  messages: readonly ObservedMessage[],
  releasedTranslationPaths: readonly ReleasedTranslationPath[],
): ProjectStructure[] {
  const structures: ProjectStructure[] = [];
  for (const snapshot of mappings) {
    const definitionsSource = snapshot.mapping.definitionsSource;
    const definitions = definitionsValueOf(snapshot);
    if (definitionsSource === undefined || definitions === undefined) continue;
    structures.push({
      sourceFile: snapshot.mapping.source,
      definitionsSource,
      targetFile: snapshot.mapping.target,
      definitions,
      target: targets.get(snapshot.mapping.target)?.value,
      translationPaths: messages
        .filter(
          (message) =>
            message.sourceFile === snapshot.mapping.source &&
            message.targetFile === snapshot.mapping.target,
        )
        .map((message) => message.path)
        .concat(
          releasedTranslationPaths
            .filter(
              (released) =>
                released.sourceFile === snapshot.mapping.source &&
                released.targetFile === snapshot.mapping.target,
            )
            .map((released) => released.path),
        ),
    });
  }
  return structures;
}

function emptyLock(): SyncLock {
  return {
    schemaVersion: 1,
    sourceVersion: "",
    translationHistory: "",
    jarSha256: "0".repeat(64),
    syncConfigurationSha256: "0".repeat(64),
    sourceBaselineSha256: "0".repeat(64),
    resourcesSha256: "0".repeat(64),
    translationSeeds: [],
    sameTextCandidates: [],
    integritySha256: "0".repeat(64),
  };
}

function invalidStateReport(
  operation: ProjectReport["operation"],
  reason: string,
  code: string,
  location: DiagnosticLocation,
): ProjectReport {
  const problem = diagnostic(
    "structure",
    code,
    "error",
    reason,
    location,
    { state: "consistent" },
    { state: "invalid" },
  );
  return makeReport(operation, emptyView(), emptyLock(), [problem]);
}

function projectView(
  baseline: SourceBaseline,
  targets: ReadonlyMap<string, TargetFileInput>,
  extraIssues: readonly ProjectFileIssue[],
): ProjectView {
  const targetValues = new Map<string, JsonValue | undefined>();
  for (const mapping of baseline.mappings) {
    const target = targets.get(mapping.mapping.target);
    if (target !== undefined)
      targetValues.set(mapping.mapping.target, target.value);
  }
  const collected = collectMessages(
    baseline.mappings,
    targetValues,
    baseline.resources,
  );
  const structures = makeProjectStructures(
    baseline.mappings,
    targets,
    collected.messages,
    baseline.releasedTranslationPaths ?? [],
  );
  return {
    sourceVersion: baseline.source.version,
    sourceLanguage: baseline.translationScope.sourceLanguage,
    targetLanguage: baseline.translationScope.targetLanguage,
    resources: baseline.resources.map(({ path, purpose }) => ({
      path,
      purpose,
    })),
    messages: collected.messages,
    targetMessages: collected.targetMessages,
    structures,
    knownOutOfScopeVisibleTexts: baseline.knownOutOfScopeVisibleTexts ?? [],
    fileIssues: [
      ...extraIssues,
      ...collected.issues,
      ...structureFindingIssues(structures),
    ],
  };
}

interface StructurePlanChange {
  readonly sourceFile: string;
  readonly definitionsSource: string;
  readonly targetFile: string;
  readonly path: readonly string[];
  readonly action: "preserve" | "update" | "delete";
  readonly previous?: JsonValue;
  readonly expected?: JsonValue;
}

interface StructurePlanResult {
  readonly changes: readonly StructurePlanChange[];
  readonly blockers: readonly {
    readonly code: string;
    readonly reason: string;
  }[];
}

function selectedAt(
  paths: readonly (readonly string[])[],
  path: readonly string[],
): boolean {
  return paths.some((selected) => samePath(selected, path));
}

function pathStartsWith(
  path: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    path.length >= prefix.length &&
    prefix.every((segment, index) => path[index] === segment)
  );
}

function selectedBelow(
  paths: readonly (readonly string[])[],
  path: readonly string[],
): boolean {
  return paths.some(
    (selected) =>
      selected.length > path.length && pathStartsWith(selected, path),
  );
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sortedKeys(...values: readonly (JsonValue | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    if (isRecord(value)) {
      for (const key of Object.keys(value)) keys.add(key);
    }
  }
  return [...keys].sort(compareText);
}

function planStructureChanges(
  previousMappings: readonly MappingSnapshot[],
  currentMappings: readonly MappingSnapshot[],
  targets: ReadonlyMap<string, TargetFileInput>,
  currentMessages: readonly ObservedMessage[],
  releasedTranslationPaths: readonly ReleasedTranslationPath[],
): StructurePlanResult {
  const previousBySource = new Map(
    previousMappings.map((snapshot) => [snapshot.mapping.source, snapshot]),
  );
  const changes: StructurePlanChange[] = [];
  const blockers: { code: string; reason: string }[] = [];

  for (const snapshot of currentMappings) {
    const mapping = snapshot.mapping;
    const definitionsSource = mapping.definitionsSource;
    const currentDefinitions = definitionsValueOf(snapshot);
    if (definitionsSource === undefined || currentDefinitions === undefined)
      continue;
    const previousSnapshot = previousBySource.get(mapping.source);
    const previousDefinitions =
      previousSnapshot?.mapping.definitionsSource === definitionsSource
        ? definitionsValueOf(previousSnapshot)
        : undefined;
    const target = targets.get(mapping.target);
    if (target === undefined) continue;
    const currentTranslationPaths = currentMessages
      .filter(
        (message) =>
          message.sourceFile === mapping.source &&
          message.targetFile === mapping.target,
      )
      .map((message) => message.path);
    const releasedPaths = releasedTranslationPaths
      .filter(
        (released) =>
          released.sourceFile === mapping.source &&
          released.targetFile === mapping.target,
      )
      .map((released) => released.path);
    const translationPaths = [...currentTranslationPaths, ...releasedPaths];

    if (!isRecord(currentDefinitions)) {
      blockers.push({
        code: "init.structure-source-shape",
        reason: `${definitionsSource} 的结构根节点必须是映射`,
      });
      continue;
    }
    if (previousDefinitions !== undefined && !isRecord(previousDefinitions)) {
      blockers.push({
        code: "init.structure-source-shape",
        reason: `${definitionsSource} 的旧结构根节点不是映射`,
      });
      continue;
    }
    for (const message of currentMessages) {
      if (message.sourceFile !== mapping.source) continue;
      for (let depth = 1; depth < message.path.length; depth += 1) {
        const definitionParent = valueAtPath(
          currentDefinitions,
          message.path.slice(0, depth),
        );
        if (definitionParent !== undefined && !isRecord(definitionParent)) {
          blockers.push({
            code: "init.structure-source-shape",
            reason: `${definitionsSource}:${message.path.slice(0, depth).join(".")} 无法与已选择的译文路径对应`,
          });
          break;
        }
      }
    }

    const update = (
      path: readonly string[],
      current: JsonValue,
      actual: JsonValue | undefined,
    ): void => {
      changes.push({
        sourceFile: mapping.source,
        definitionsSource,
        targetFile: mapping.target,
        path,
        action: "update",
        ...(actual === undefined ? {} : { previous: actual }),
        expected: current,
      });
    };
    const blockTargetType = (
      path: readonly string[],
      actual: JsonValue,
      expected: JsonValue,
    ): void => {
      blockers.push({
        code: "init.structure-target-path-type",
        reason: `${mapping.target}:${path.join(".")} 的目标类型为${structureValueType(actual)}，上游结构类型为${structureValueType(expected)}`,
      });
    };
    const canDeleteManagedSubtree = (
      path: readonly string[],
      previous: JsonValue,
      actual: JsonValue,
    ): boolean => {
      if (
        selectedAt(translationPaths, path) ||
        selectedBelow(translationPaths, path)
      ) {
        return false;
      }
      const previousIsMap = isRecord(previous);
      const actualIsMap = isRecord(actual);
      if (previousIsMap || actualIsMap) {
        if (!previousIsMap || !actualIsMap) return false;
        return Object.keys(actual).every(
          (key) =>
            Object.prototype.hasOwnProperty.call(previous, key) &&
            canDeleteManagedSubtree(
              [...path, key],
              previous[key]!,
              actual[key]!,
            ),
        );
      }
      return structureValueType(previous) === structureValueType(actual);
    };
    const visit = (
      path: readonly string[],
      previous: JsonValue | undefined,
      current: JsonValue | undefined,
      actual: JsonValue | undefined,
    ): void => {
      if (selectedAt(translationPaths, path)) return;

      const previousIsMap = isRecord(previous);
      const currentIsMap = isRecord(current);
      const actualIsMap = isRecord(actual);
      const hasSelectedDescendant = selectedBelow(translationPaths, path);

      if (current === undefined) {
        if (previous === undefined) {
          if (hasSelectedDescendant) return;
          if (actual !== undefined) {
            changes.push({
              sourceFile: mapping.source,
              definitionsSource,
              targetFile: mapping.target,
              path,
              action: "preserve",
              previous: actual,
            });
          }
          return;
        }
        if (actual === undefined) return;
        if (previousIsMap) {
          if (!actualIsMap) {
            blockTargetType(path, actual, previous);
            return;
          }
          if (canDeleteManagedSubtree(path, previous, actual)) {
            changes.push({
              sourceFile: mapping.source,
              definitionsSource,
              targetFile: mapping.target,
              path,
              action: "delete",
              previous: actual,
            });
            return;
          }
          for (const key of sortedKeys(previous, actual)) {
            visit([...path, key], previous[key], undefined, actual[key]);
          }
          return;
        }
        if (structureValueType(actual) !== structureValueType(previous)) {
          blockTargetType(path, actual, previous);
          return;
        }
        changes.push({
          sourceFile: mapping.source,
          definitionsSource,
          targetFile: mapping.target,
          path,
          action: "delete",
          previous: actual,
        });
        return;
      }

      if (currentIsMap) {
        if (actual !== undefined && !actualIsMap) {
          if (previous !== undefined && sameValue(actual, previous)) {
            update(path, current, actual);
          } else {
            blockTargetType(path, actual, current);
          }
          return;
        }
        if (actual === undefined && Object.keys(current).length === 0) {
          update(path, current, undefined);
          return;
        }
        for (const key of sortedKeys(previous, current, actual)) {
          visit(
            [...path, key],
            previousIsMap ? previous[key] : undefined,
            current[key],
            actualIsMap ? actual[key] : undefined,
          );
        }
        return;
      }

      if (hasSelectedDescendant) {
        blockers.push({
          code: "init.structure-source-shape",
          reason: `${definitionsSource}:${path.join(".")} 无法与已选择的译文路径对应`,
        });
        return;
      }

      if (actual === undefined) {
        update(path, current, undefined);
        return;
      }

      if (structureValueType(actual) !== structureValueType(current)) {
        if (previous !== undefined && sameValue(actual, previous)) {
          update(path, current, actual);
        } else {
          blockTargetType(path, actual, current);
        }
        return;
      }

      if (!sameValue(actual, current)) update(path, current, actual);
    };

    visit([], previousDefinitions, currentDefinitions, target.value);
  }

  changes.sort((left, right) =>
    compareText(
      `${left.targetFile}:${canonicalJson(left.path)}:${left.action}`,
      `${right.targetFile}:${canonicalJson(right.path)}:${right.action}`,
    ),
  );
  blockers.sort((left, right) =>
    compareText(`${left.code}:${left.reason}`, `${right.code}:${right.reason}`),
  );
  return { changes, blockers };
}

function applyStructureChanges(
  targets: ReadonlyMap<string, TargetFileInput>,
  changes: readonly StructurePlanChange[],
  changedTargetPaths: Set<string>,
): void {
  const applicable = changes
    .filter((change) => change.action !== "preserve")
    .sort((left, right) => {
      const leftDepth = left.path.length;
      const rightDepth = right.path.length;
      if (left.action === "delete" && right.action === "delete") {
        return rightDepth - leftDepth;
      }
      if (left.action === "update" && right.action === "update") {
        return leftDepth - rightDepth;
      }
      return left.action === "delete" ? -1 : 1;
    });
  for (const change of applicable) {
    const target = targets.get(change.targetFile);
    if (target === undefined) {
      throw new ProjectOperationError(
        `无法准备结构目标文件：${change.targetFile}`,
      );
    }
    if (change.action === "update") {
      if (change.expected === undefined) {
        throw new ProjectOperationError("结构更新缺少上游定义值");
      }
      updateDocumentValue(target.document, change.path, change.expected);
    } else {
      target.document.deleteIn(change.path);
    }
    changedTargetPaths.add(change.targetFile);
  }
}

function structureFindingIssues(
  structures: readonly ProjectStructure[],
): readonly ProjectFileIssue[] {
  const issues: ProjectFileIssue[] = [];
  for (const structure of structures) {
    const expected = new Map<
      string,
      { path: readonly string[]; value: JsonValue }
    >();
    const visit = (value: JsonValue, path: readonly string[]): void => {
      if (selectedAt(structure.translationPaths, path)) return;
      if (isRecord(value)) {
        if (Object.keys(value).length === 0) {
          expected.set(canonicalJson(path), { path, value });
          return;
        }
        for (const key of Object.keys(value).sort(compareText)) {
          visit(value[key]!, [...path, key]);
        }
        return;
      }
      expected.set(canonicalJson(path), { path, value });
    };
    visit(structure.definitions, []);
    for (const { path, value } of expected.values()) {
      const actual = valueAtPath(structure.target, path);
      if (
        isRecord(value) &&
        Object.keys(value).length === 0 &&
        isRecord(actual)
      ) {
        continue;
      }
      if (actual !== undefined && sameValue(actual, value)) continue;
      issues.push({
        file: structure.targetFile,
        code: "structure.definition-mismatch",
        reason: "目标结构字段与已登记的上游定义不一致",
        path,
        expected: value,
        actual: actual === undefined ? { state: "missing" } : actual,
      });
    }
  }
  return issues;
}

function translatableTextCoverageUnavailable(
  view: ProjectView,
): readonly string[] {
  const parsed = view.miniMessage;
  if (parsed === undefined) return [];
  const expectedTextKeys = new Set<string>();
  for (const document of parsed.documents) {
    const listItems = document.listItems;
    const paths =
      listItems === undefined
        ? [document.path]
        : document.parent === undefined
          ? listItems.map(({ path }) => path)
          : listItems
              .filter(
                ({ position }) =>
                  position.start <= document.range.start &&
                  document.range.end <= position.end,
              )
              .map(({ path }) => path);
    for (const path of paths) {
      expectedTextKeys.add(
        canonicalJson({
          messageId: document.message.id,
          path,
          documentIndex: document.documentIndex,
          origin: document.origin,
        }),
      );
    }
  }
  const actualTextKeys = new Set(
    parsed.translatableText.map((document) =>
      canonicalJson({
        messageId: document.message.id,
        path: document.path,
        documentIndex: document.documentIndex,
        origin: document.origin,
      }),
    ),
  );
  const sourceKeys = new Set(
    parsed.translatableText
      .filter((document) => document.origin === "source")
      .map((document) =>
        canonicalJson({
          messageId: document.message.id,
          path: document.path,
          documentIndex: document.documentIndex,
        }),
      ),
  );
  const targetKeys = new Set(
    parsed.translatableText
      .filter((document) => document.origin === "target")
      .map((document) =>
        canonicalJson({
          messageId: document.message.id,
          path: document.path,
          documentIndex: document.documentIndex,
        }),
      ),
  );
  const pairing = pairTranslatableTextDocuments(parsed);
  if (
    expectedTextKeys.size !== actualTextKeys.size ||
    [...expectedTextKeys].some((key) => !actualTextKeys.has(key)) ||
    parsed.incompleteFacts.length > 0 ||
    pairing.incomplete.length > 0 ||
    parsed.documents.some((document) => document.status !== "parsed") ||
    [...sourceKeys].some((key) => !targetKeys.has(key)) ||
    [...targetKeys].some((key) => !sourceKeys.has(key))
  ) {
    return ["术语和风格检查所需的可译文本片段不完整"];
  }
  return [];
}

function coverageUnavailable(
  view: ProjectView,
  configuration: ConsumerConfiguration,
): readonly string[] {
  const unavailable: string[] = [];
  unavailable.push(...(view.miniMessage?.unavailableCapabilities ?? []));
  unavailable.push(...translatableTextCoverageUnavailable(view));
  if (configuration.rules?.["minimessage-tags"]?.enabled !== false) {
    unavailable.push(...miniMessageTagCoverageUnavailable(view));
  }
  return unavailable;
}

function evaluateProject(
  view: ProjectView,
  configuration: ConsumerConfiguration,
  registeredRules: readonly CheckRule[],
) {
  return evaluateRules(view, registeredRules, {
    configuration: configuration.rules,
    unavailableCapabilities: coverageUnavailable(view, configuration),
  });
}

function issueCount(report: ProjectReport): number {
  return report.diagnostics.filter((item) => item.severity === "error").length;
}

export async function initializeProject(
  projectDirectory: string,
  jarPath: string,
  options: InitializationOptions = {},
): Promise<ProjectReport> {
  const project = await realpath(resolve(projectDirectory));
  const configFile = join(project, configurationFileName);
  await assertNoSymlinkPath(project, configurationFileName);
  const transactionRelativePath = `${stateDirectoryName}/${transactionFileName}`;
  await assertNoSymlinkPath(project, transactionRelativePath);
  try {
    await recoverInterruptedTransaction(project, transactionRelativePath);
  } catch (error) {
    throw new ProjectOperationError(
      `发现未完成的维护事务且无法安全恢复：${error instanceof Error ? error.message : String(error)}`,
      "transaction.recovery-failed",
      { file: transactionRelativePath, path: [] },
    );
  }
  const jarFile = resolve(jarPath);
  const [configInput, jarInput] = await Promise.all([
    readBytes(configFile, "维护清单"),
    readBinary(jarFile, "JAR"),
  ]);
  const configuration = requireConfiguration(configInput.text);
  const resourcesDir = join(project, stateDirectoryName);
  const baselinePath = join(
    resourcesDir,
    baselineDirectoryName,
    baselineFileName,
  );
  const lockPath = join(resourcesDir, lockFileName);
  const stateSnapshots = await captureFileSnapshots([baselinePath, lockPath]);
  if (stateSnapshots.some((snapshot) => snapshot.sha256 !== undefined)) {
    throw new ProjectOperationError(
      "项目已初始化，拒绝覆盖已有原文基线或同步锁文件",
    );
  }

  const jar = await readJarResources(jarInput.bytes);
  const mismatch = resourceMismatches(
    configuration.resources,
    jar.resources,
    jar.duplicatePaths,
  );
  if (mismatch !== undefined)
    throw new ProjectOperationError(`JAR 资源清单不匹配：${mismatch}`);
  const jarByPath = new Map(
    jar.resources.map((resource) => [resource.path, resource.bytes]),
  );
  const miniMessageTheme = miniMessageThemeForBaseline(
    configuration.resources,
    jarByPath,
  );
  const resources: ResourceSnapshot[] = configuration.resources
    .map((resource) => ({
      ...resource,
      sha256: sha256(jarByPath.get(resource.path)!),
    }))
    .sort((left, right) => compareText(left.path, right.path));

  const mappings: MappingSnapshot[] = [];
  for (const mapping of configuration.translationScope.mappings) {
    mappings.push(readMappingSnapshot(mapping, jarByPath));
  }
  const invalidSourceIssues = sourceMessageIssues(mappings, resources);
  if (invalidSourceIssues.length > 0) {
    const detail = invalidSourceIssues
      .map((issue) => `${issue.file} ${issue.path.join(".")}: ${issue.reason}`)
      .join("；");
    throw new ProjectOperationError(`原文不符合已声明的字段类型：${detail}`);
  }

  const targetInput = await readTargets(project, {
    schemaVersion: 1,
    source: configuration.source,
    translationScope: configuration.translationScope,
    jarSha256: jarInput.sha256,
    resources,
    mappings,
  });
  if (
    targetInput.issues.some(
      (issue) =>
        issue.code === "yaml-invalid" ||
        issue.code === "yaml-duplicate-key" ||
        issue.code === "yaml-root-invalid",
    )
  ) {
    const details = targetInput.issues
      .map((issue) => `${issue.file}：${issue.reason}`)
      .join("；");
    throw new ProjectOperationError(`现有目标 YAML 无法安全读取：${details}`);
  }

  const targetValues = new Map(
    [...targetInput.targets].map(
      ([path, target]) => [path, target.value] as const,
    ),
  );
  const initialCollection = collectMessages(mappings, targetValues, resources);
  const initialStructures = planStructureChanges(
    [],
    mappings,
    targetInput.targets,
    initialCollection.messages,
    [],
  );
  if (initialStructures.blockers.length > 0) {
    const detail = initialStructures.blockers
      .map(({ code, reason }) => `${code}：${reason}`)
      .join("；");
    throw new ProjectOperationError(
      `无法安全合并上游结构：${detail}`,
      initialStructures.blockers[0]!.code,
    );
  }
  const seeds: TranslationSeed[] = [];
  const sameTextCandidates: SameTextCandidate[] = [];
  const messagesNeedingSeed = new Set<string>();
  for (const message of initialCollection.messages) {
    if (message.targetStatus === "missing") {
      seeds.push({
        id: message.id,
        sourceSha256: sha256(canonicalJson(message.source)),
        reason: "missing",
      });
      messagesNeedingSeed.add(message.id);
    } else if (!isValidTargetValue(message.category, message.target)) {
      continue;
    } else if (sameValue(message.target, message.source)) {
      sameTextCandidates.push({
        id: message.id,
        sourceSha256: sha256(canonicalJson(message.source)),
      });
    }
  }

  const changedStructureTargets = new Set<string>();
  applyStructureChanges(
    targetInput.targets,
    initialStructures.changes,
    changedStructureTargets,
  );
  const updatedTargetBytes = new Map<string, string>();
  for (const message of initialCollection.messages) {
    if (!messagesNeedingSeed.has(message.id)) continue;
    const target = targetInput.targets.get(message.targetFile);
    if (target === undefined) {
      throw new ProjectOperationError(
        `无法准备目标文件：${message.targetFile}`,
      );
    }
    updateDocumentValue(target.document, message.path, message.source);
  }
  for (const [path, target] of targetInput.targets) {
    const changed =
      target.originalSha256 === undefined ||
      changedStructureTargets.has(path) ||
      initialCollection.messages.some(
        (message) =>
          message.targetFile === path && messagesNeedingSeed.has(message.id),
      );
    if (changed)
      updatedTargetBytes.set(path, target.document.toString({ lineWidth: 0 }));
  }

  const baseline: SourceBaseline = {
    schemaVersion: 1,
    source: configuration.source,
    translationScope: configuration.translationScope,
    jarSha256: jarInput.sha256,
    resources,
    mappings,
    knownOutOfScopeVisibleTexts: knownOutOfScopeVisibleTexts(
      configuration.resources,
      jarByPath,
    ),
    ...(miniMessageTheme === undefined ? {} : { miniMessageTheme }),
  };
  const baselineText = serializeBaseline(baseline);
  const baselineSha256 = sha256(baselineText);
  const lockContents: Omit<SyncLock, "integritySha256"> = {
    schemaVersion: 1,
    sourceVersion: configuration.source.version,
    translationHistory: configuration.source.translationHistory,
    jarSha256: jarInput.sha256,
    syncConfigurationSha256: syncConfigurationFingerprint(configuration),
    sourceBaselineSha256: baselineSha256,
    resourcesSha256: resourceSetFingerprint(resources),
    translationSeeds: seeds.sort((left, right) =>
      compareText(left.id, right.id),
    ),
    sameTextCandidates: sameTextCandidates.sort((left, right) =>
      compareText(left.id, right.id),
    ),
  };
  const lock: SyncLock = {
    ...lockContents,
    integritySha256: syncLockIntegrity(lockContents),
  };
  const lockText = serializeLock(lock);

  const inputSnapshots: FileSnapshot[] = [
    { path: configFile, sha256: configInput.sha256 },
    { path: jarFile, sha256: jarInput.sha256 },
    ...targetInput.snapshots,
    ...stateSnapshots,
  ];
  const writes: FileWrite[] = [
    ...[...updatedTargetBytes.entries()].map(([path, content]) => ({
      path: resolveProjectFile(project, path),
      content,
      expectedSha256: targetInput.targets.get(path)?.originalSha256,
    })),
    { path: baselinePath, content: baselineText, expectedSha256: undefined },
    { path: lockPath, content: lockText, expectedSha256: undefined },
  ];
  try {
    await writeFilesAtomically(
      project,
      transactionRelativePath,
      writes,
      async () => {
        await options.beforeApply?.();
        await assertFileSnapshots(inputSnapshots);
      },
    );
  } catch (error) {
    if (error instanceof ConcurrentEditError) {
      throw new ProjectOperationError(error.message);
    }
    throw error;
  }

  const targetAfter = await readTargets(project, baseline);
  const view = projectView(baseline, targetAfter.targets, targetAfter.issues);
  const reviewedView = withTranslationReview(view, lock, new Set());
  const evaluated = evaluateRules(reviewedView, builtInRules, {
    configuration: configuration.rules,
  });
  const review = evaluateRules(reviewedView, [translationReviewRule]);
  return makeReport(
    "init",
    reviewedView,
    lock,
    evaluated.diagnostics,
    undefined,
    review.diagnostics.map(checkConclusion),
  );
}

interface LoadedSavedProject {
  readonly project: string;
  readonly baseline: SourceBaseline;
  readonly lock: SyncLock;
  readonly configuration: ConsumerConfiguration;
  readonly view: ProjectView;
  readonly exceptions: ExceptionRecords;
  readonly exceptionPath: string;
  readonly exceptionSnapshot: FileSnapshot;
  readonly inputSnapshots: readonly FileSnapshot[];
  readonly staticDiagnostics: readonly Diagnostic[];
}

interface ConclusionContext {
  readonly view: ProjectView;
  readonly diagnostics: readonly Diagnostic[];
  readonly coverage: CheckCoverage;
  readonly registeredRules: readonly CheckRule[];
}

interface EvaluatedSavedProject extends LoadedSavedProject, ConclusionContext {
  readonly conclusions: readonly CheckConclusion[];
  readonly qualityCoverage: CheckCoverage;
}

type ExceptionResolution =
  | {
      readonly record: ExceptionRecord;
      readonly state: "active";
      readonly conclusion: CheckConclusion;
    }
  | {
      readonly record: ExceptionRecord;
      readonly state: "review-required" | "orphaned" | "unable-to-evaluate";
      readonly expected: JsonValue;
      readonly actual: JsonValue;
      readonly location?: DiagnosticLocation;
    };

async function loadSavedProject(
  projectDirectory: string,
): Promise<LoadedSavedProject> {
  const project = await realpath(resolve(projectDirectory));
  await assertNoSymlinkPath(project, configurationFileName);
  await assertNoSymlinkPath(
    project,
    `${stateDirectoryName}/${baselineDirectoryName}/${baselineFileName}`,
  );
  await assertNoSymlinkPath(project, `${stateDirectoryName}/${lockFileName}`);
  await assertNoSymlinkPath(
    project,
    `${stateDirectoryName}/${transactionFileName}`,
  );
  const exceptionRelativePath = `${stateDirectoryName}/${exceptionsFileName}`;
  await assertNoSymlinkPath(project, exceptionRelativePath);
  const state = await readState(project);
  if (!state.ok) {
    throw new ProjectOperationError(
      state.message,
      state.code ?? "state.invalid",
      {
        file: state.code?.startsWith("transaction.")
          ? `${stateDirectoryName}/${transactionFileName}`
          : stateDirectoryName,
        path: [],
      },
    );
  }
  const configInput = await readBytes(
    join(project, configurationFileName),
    "维护清单",
  );
  const configuration = requireConfiguration(configInput.text);
  const targetInput = await readTargets(project, state.baseline);
  const exceptionPath = resolveProjectFile(project, exceptionRelativePath);
  const exceptionInput = await readOptionalBytes(exceptionPath);
  let exceptions = emptyExceptionRecords();
  if (exceptionInput !== undefined) {
    try {
      exceptions = parseExceptionRecords(exceptionInput.text);
    } catch (error) {
      throw new ProjectOperationError(
        `例外记录无效：${error instanceof Error ? error.message : String(error)}`,
        "exceptions.invalid",
        { file: exceptionRelativePath, path: [] },
      );
    }
  }
  const view = projectView(
    state.baseline,
    targetInput.targets,
    targetInput.issues,
  );
  const staticDiagnostics: Diagnostic[] = [];
  if (
    syncConfigurationFingerprint(configuration) !==
    state.lock.syncConfigurationSha256
  ) {
    staticDiagnostics.push(
      diagnostic(
        "structure",
        "sync.configuration-changed",
        "error",
        "影响原文解析或同步的维护声明已更改，尚未同步。请先更新离线来源，再使用 Lioni 原生 `update <配置入口>`；需要推进比较基线时显式加 `--record-baseline`。",
        { file: configurationFileName, path: ["translationScope"] },
        { syncConfigurationSha256: state.lock.syncConfigurationSha256 },
        {
          syncConfigurationSha256: syncConfigurationFingerprint(configuration),
        },
      ),
    );
  }
  const baselinePath = join(
    project,
    stateDirectoryName,
    baselineDirectoryName,
    baselineFileName,
  );
  const lockPath = join(project, stateDirectoryName, lockFileName);
  const exceptionSnapshot: FileSnapshot = {
    path: exceptionPath,
    sha256: exceptionInput?.sha256,
  };
  return {
    project,
    baseline: state.baseline,
    lock: state.lock,
    configuration,
    view,
    exceptions,
    exceptionPath,
    exceptionSnapshot,
    inputSnapshots: [
      {
        path: join(project, configurationFileName),
        sha256: configInput.sha256,
      },
      { path: baselinePath, sha256: sha256(state.baselineText) },
      { path: lockPath, sha256: sha256(state.lockText) },
      ...targetInput.snapshots,
      exceptionSnapshot,
    ],
    staticDiagnostics,
  };
}

function pendingReasonForMessage(
  messageId: string,
  lock: SyncLock,
): SameTextPendingReason | undefined {
  if (lock.translationSeeds.some((seed) => seed.id === messageId)) {
    return "translation-seed";
  }
  return lock.sameTextCandidates.some((candidate) => candidate.id === messageId)
    ? "same-text-candidate"
    : undefined;
}

function withTranslationReview(
  view: ProjectView,
  lock: SyncLock,
  confirmedSameTextIds: ReadonlySet<string>,
): ProjectView {
  return {
    ...view,
    messages: view.messages.map((message) => {
      const pendingReason = pendingReasonForMessage(message.id, lock);
      return {
        ...message,
        translationReview: {
          ...(pendingReason === undefined ? {} : { pendingReason }),
          confirmedSameText: confirmedSameTextIds.has(message.id),
        },
      };
    }),
  };
}

function enabledRulesRequireInput(
  configuration: ConsumerConfiguration,
  input: RuleInput,
  registeredRules: readonly CheckRule[],
): boolean {
  return registeredRules.some(
    (rule) =>
      rule.requiredInputs?.includes(input) === true &&
      configuration.rules?.[rule.id]?.enabled !== false,
  );
}

async function evaluateSavedProject(
  loaded: LoadedSavedProject,
  operation: "status" | "check",
  registeredRules: readonly CheckRule[] = builtInRules,
): Promise<EvaluatedSavedProject> {
  const rules = [...registeredRules];
  const view =
    operation === "check" &&
    enabledRulesRequireInput(loaded.configuration, "minimessage-parse", rules)
      ? {
          ...loaded.view,
          miniMessage: await parseMiniMessages({
            messages: loaded.view.messages,
            resources: loaded.view.resources,
            theme: {
              ...(loaded.baseline.miniMessageTheme === undefined
                ? {}
                : { theme: loaded.baseline.miniMessageTheme }),
              issues: [],
            },
            sourceVersion: loaded.configuration.source.version,
          }),
        }
      : loaded.view;
  // 翻译状态检查先形成结论；通用例外匹配结果随后参与状态派生和质量检查。
  const reviewView = withTranslationReview(view, loaded.lock, new Set());
  const review = evaluateRules(reviewView, [translationReviewRule]);
  const reviewConclusions = review.diagnostics.map(checkConclusion);
  const reviewContext: ConclusionContext = {
    view: reviewView,
    diagnostics: review.diagnostics,
    coverage: review.coverage,
    registeredRules: [translationReviewRule],
  };
  const reviewResolutions = resolveExceptionRecords(
    loaded.exceptions.records,
    reviewConclusions,
    reviewContext,
    operation,
  );
  const accepted = new Set(
    reviewResolutions.flatMap((resolution) =>
      resolution.state === "active" ? [resolution.conclusion.id] : [],
    ),
  );
  const reviewedView = withTranslationReview(
    view,
    loaded.lock,
    new Set(
      reviewConclusions.flatMap((conclusion) =>
        accepted.has(conclusion.id) && conclusion.message !== undefined
          ? [conclusion.message.id]
          : [],
      ),
    ),
  );
  const evaluation = evaluateProject(reviewedView, loaded.configuration, rules);
  const diagnostics = [...loaded.staticDiagnostics, ...evaluation.diagnostics];
  return {
    ...loaded,
    view: reviewedView,
    diagnostics,
    coverage: {
      ...evaluation.coverage,
      complete: review.coverage.complete && evaluation.coverage.complete,
      enabledRuleIds: [
        ...review.coverage.enabledRuleIds,
        ...evaluation.coverage.enabledRuleIds,
      ],
      unsupportedRuleIds: [
        ...review.coverage.unsupportedRuleIds,
        ...evaluation.coverage.unsupportedRuleIds,
      ],
    },
    qualityCoverage: evaluation.coverage,
    registeredRules: [translationReviewRule, ...rules],
    conclusions: [...reviewConclusions, ...diagnostics.map(checkConclusion)],
  };
}

function isExecutionPrecondition(code: string): boolean {
  return (
    code === "sync.configuration-changed" ||
    code === "mapping.invalid" ||
    code === "source.field-missing" ||
    code === "message.type-mismatch" ||
    code === "target-missing" ||
    code === "yaml-invalid" ||
    code === "yaml-duplicate-key" ||
    code === "yaml-root-invalid"
  );
}

function requiredInputDependencyUnavailable(
  project: ConclusionContext,
  dependency: RuleInputDependency,
): boolean {
  const miniMessage = project.view.miniMessage;
  if (miniMessage === undefined) return true;
  const message = project.view.messages.find(
    (candidate) => candidate.id === dependency.messageId,
  );
  if (message === undefined) return false;

  if (!message.path.every((part, index) => dependency.path[index] === part)) {
    return true;
  }
  if (
    dependency.origin === "target" &&
    (message.targetStatus !== "present" || message.target === undefined)
  ) {
    return true;
  }
  if (
    dependency.origin === "target" &&
    project.view.fileIssues.some(
      (issue) =>
        issue.file === message.targetFile &&
        ["yaml-invalid", "yaml-duplicate-key", "yaml-root-invalid"].includes(
          issue.code,
        ),
    )
  ) {
    return true;
  }

  const value =
    dependency.origin === "source" ? message.source : message.target;
  const relativePath = dependency.path.slice(message.path.length);
  let current: JsonValue | undefined = value;
  for (const part of relativePath) {
    if (typeof part === "number") {
      if (!Array.isArray(current) || !Object.hasOwn(current, part)) {
        current = undefined;
        break;
      }
      current = current[part];
    } else {
      if (
        current === null ||
        typeof current !== "object" ||
        Array.isArray(current) ||
        !Object.hasOwn(current, part)
      ) {
        current = undefined;
        break;
      }
      current = (current as { readonly [key: string]: JsonValue })[part];
    }
  }
  if (current === undefined) return false;

  // GUI lore 共享根文档，正文项按投影位置映射回各列表路径。
  const documentMatchesPath = (
    document: NonNullable<typeof miniMessage>["documents"][number],
  ) => {
    if (canonicalJson(document.path) === canonicalJson(dependency.path))
      return true;
    const item = document.listItems?.find(
      ({ path }) => canonicalJson(path) === canonicalJson(dependency.path),
    );
    return (
      item !== undefined &&
      (document.parent === undefined ||
        (item.position.start <= document.range.start &&
          document.range.end <= item.position.end))
    );
  };
  const documentsForDependency = miniMessage.documents.filter(
    (document) =>
      document.message.id === dependency.messageId &&
      document.origin === dependency.origin &&
      document.documentIndex === dependency.documentIndex &&
      documentMatchesPath(document),
  );
  if (documentsForDependency.length > 0) {
    return documentsForDependency.some(
      (document) => document.status !== "parsed",
    );
  }

  if (dependency.documentIndex === 0) return true;
  const rootDocuments = miniMessage.documents.filter(
    (document) =>
      document.message.id === dependency.messageId &&
      document.origin === dependency.origin &&
      document.documentIndex === 0 &&
      documentMatchesPath(document),
  );
  return (
    rootDocuments.length === 0 ||
    rootDocuments.some((document) => document.status !== "parsed")
  );
}

function requiredRuleInputUnavailable(
  project: ConclusionContext,
  ruleId: string,
  operation: "status" | "check",
  messageId?: string,
  requiredInputDependencies?: readonly RuleInputDependency[],
): boolean {
  const rule = project.registeredRules.find(
    (candidate) => candidate.id === ruleId,
  );
  if (rule === undefined) return true;
  return (
    rule.requiredInputs?.some((input) => {
      switch (input) {
        case "minimessage-parse":
          if (operation !== "check" || project.view.miniMessage === undefined)
            return true;
          if (requiredInputDependencies !== undefined) {
            return requiredInputDependencies
              .filter((dependency) => dependency.input === input)
              .some((dependency) =>
                requiredInputDependencyUnavailable(project, dependency),
              );
          }
          if (messageId === undefined)
            return project.view.miniMessage.unavailableCapabilities.length > 0;
          if (
            !project.view.messages.some((message) => message.id === messageId)
          )
            return false;
          return (
            project.view.miniMessage.documents.filter(
              (document) => document.message.id === messageId,
            ).length === 0 ||
            project.view.miniMessage.documents.some(
              (document) =>
                document.message.id === messageId &&
                (document.status === "parser-failed" ||
                  (ruleId === "minimessage-tags" &&
                    document.status === "syntax-invalid")),
            )
          );
      }
    }) ?? false
  );
}

function ruleUnavailable(
  project: ConclusionContext,
  ruleId: string,
  operation: "status" | "check",
  messageId?: string,
  diagnosticCode?: string,
  location?: DiagnosticLocation,
  requiredInputDependencies?: readonly RuleInputDependency[],
): boolean {
  const incompleteVariableEvaluation =
    ruleId === "minimessage-variables" &&
    diagnosticCode !== "minimessage.variable-coverage-unavailable" &&
    messageId !== undefined &&
    project.diagnostics.some(
      (item) =>
        item.ruleId === ruleId &&
        item.message?.id === messageId &&
        item.code === "minimessage.variable-coverage-unavailable",
    );
  return (
    !project.coverage.enabledRuleIds.includes(ruleId) ||
    project.coverage.disabledRuleIds.includes(ruleId) ||
    project.coverage.unsupportedRuleIds.includes(ruleId) ||
    requiredRuleInputUnavailable(
      project,
      ruleId,
      operation,
      messageId,
      requiredInputDependencies,
    ) ||
    incompleteVariableEvaluation
  );
}

function assertExceptionPreconditions(project: EvaluatedSavedProject): void {
  const mappingIssue = project.view.fileIssues.find((issue) =>
    isExecutionPrecondition(issue.code),
  );
  if (mappingIssue !== undefined) {
    throw new ProjectOperationError(
      `当前项目存在执行前提问题，不能记录例外：${mappingIssue.reason}`,
      "exception.precondition-failed",
      { file: mappingIssue.file, path: mappingIssue.path },
    );
  }
  const blocker = project.diagnostics.find((item) =>
    isExecutionPrecondition(item.code),
  );
  if (blocker !== undefined) {
    throw new ProjectOperationError(
      `当前项目存在执行前提问题，不能记录例外：${blocker.reason}`,
      "exception.precondition-failed",
      blocker.location,
    );
  }
  const blockedMessage = project.view.messages.find(
    (message) => message.targetStatus === "blocked",
  );
  if (blockedMessage !== undefined) {
    throw new ProjectOperationError(
      "受管理消息的目标路径被现有内容阻断，不能记录例外",
      "exception.precondition-failed",
      { file: blockedMessage.targetFile, path: blockedMessage.path },
    );
  }
}

function exceptionNotice(
  code: string,
  reason: string,
  location: DiagnosticLocation,
  expected: JsonValue,
  actual: JsonValue,
): Diagnostic {
  return diagnostic(
    "exceptions",
    code,
    "warning",
    reason,
    location,
    expected,
    actual,
  );
}

function conclusionUnavailable(
  project: ConclusionContext,
  conclusion: ConclusionSubject,
  operation: "status" | "check",
): boolean {
  const message = project.view.messages.find(
    (item) => item.id === conclusion.message?.id,
  );
  if (
    message !== undefined &&
    (message.targetStatus === "blocked" ||
      project.view.fileIssues.some(
        (issue) =>
          issue.file === message.targetFile &&
          ["yaml-invalid", "yaml-duplicate-key", "yaml-root-invalid"].includes(
            issue.code,
          ),
      ))
  )
    return true;
  return ruleUnavailable(
    project,
    conclusion.ruleId,
    operation,
    conclusion.message?.id,
    conclusion.code,
    conclusion.location,
    conclusion.requiredInputDependencies,
  );
}

function resolveExceptionRecords(
  records: readonly ExceptionRecord[],
  conclusions: readonly CheckConclusion[],
  project: ConclusionContext,
  operation: "status" | "check",
): readonly ExceptionResolution[] {
  return records.map((record): ExceptionResolution => {
    if (conclusionUnavailable(project, record, operation)) {
      return {
        record,
        state: "unable-to-evaluate",
        expected: { state: "evaluated conclusion" },
        actual: { state: "unable-to-evaluate" },
      };
    }
    const current = conclusions.find(
      (item) => item.objectId === record.objectId,
    );
    if (current !== undefined) {
      if (
        current.id === record.id &&
        current.contentFingerprint === record.contentFingerprint &&
        !isExecutionPrecondition(current.code)
      ) {
        return { record, state: "active", conclusion: current };
      }
      return {
        record,
        state: "review-required",
        location: current.location,
        expected: { contentFingerprint: record.contentFingerprint },
        actual: { contentFingerprint: current.contentFingerprint },
      };
    }
    const messageExists =
      record.message === undefined ||
      project.view.messages.some(
        (message) => message.id === record.message?.id,
      );
    return {
      record,
      state: "orphaned",
      expected: { state: "matching conclusion" },
      actual: {
        state: messageExists ? "conclusion-missing" : "message-missing",
      },
    };
  });
}

function applyExceptionRecords(
  project: EvaluatedSavedProject,
  operation: "status" | "check",
): {
  readonly diagnostics: readonly Diagnostic[];
  readonly acceptedConclusionIds: ReadonlySet<string>;
} {
  const resolutions = resolveExceptionRecords(
    project.exceptions.records,
    project.conclusions,
    project,
    operation,
  );
  const acceptedConclusionIds = new Set<string>();
  const notices: Diagnostic[] = [];
  const stateReasons = {
    "review-required": "例外对象内容或相关条件已变化，需要复核",
    orphaned: "例外对象已消失或不再有对应原因，请清理此记录",
    "unable-to-evaluate":
      "相关内容无法可靠读取，或规则已禁用、未完成，无法评估此例外",
  } as const;
  for (const resolution of resolutions) {
    if (resolution.state === "active")
      acceptedConclusionIds.add(resolution.conclusion.id);
    else
      notices.push(
        exceptionNotice(
          `exception.${resolution.state}`,
          `${stateReasons[resolution.state]}；原理由：${resolution.record.reason}`,
          resolution.location ?? resolution.record.location,
          resolution.expected,
          resolution.actual,
        ),
      );
  }
  return {
    diagnostics: [
      ...project.diagnostics.filter(
        (item) => !acceptedConclusionIds.has(item.diagnosticId),
      ),
      ...notices,
    ],
    acceptedConclusionIds,
  };
}

async function evaluatedProjectForInspection(
  projectDirectory: string,
  operation: "status" | "check",
  registeredRules: readonly CheckRule[] = builtInRules,
): Promise<EvaluatedSavedProject> {
  return evaluateSavedProject(
    await loadSavedProject(projectDirectory),
    operation,
    registeredRules,
  );
}

async function currentExceptionProject(
  projectDirectory: string,
): Promise<EvaluatedSavedProject> {
  const evaluated = await evaluatedProjectForInspection(
    projectDirectory,
    "check",
  );
  assertExceptionPreconditions(evaluated);
  return evaluated;
}

async function persistExceptionRecords(
  project: EvaluatedSavedProject,
  records: ExceptionRecords,
  options: ExceptionRecordingOptions,
  revalidate: (current: EvaluatedSavedProject) => void,
): Promise<void> {
  const content = serializeExceptionRecords(records);
  try {
    await writeFilesAtomically(
      project.project,
      `${stateDirectoryName}/${transactionFileName}`,
      [
        {
          path: project.exceptionPath,
          content,
          expectedSha256: project.exceptionSnapshot.sha256,
        },
      ],
      async () => {
        await options.beforeApply?.();
        const current = await currentExceptionProject(project.project);
        revalidate(current);
        await assertFileSnapshots(project.inputSnapshots);
      },
    );
  } catch (error) {
    if (error instanceof ConcurrentEditError) {
      throw new ProjectOperationError(
        error.message,
        "exception.concurrent-edit",
        { file: error.file, path: [] },
      );
    }
    throw error;
  }
}

function exceptionCandidates(
  project: EvaluatedSavedProject,
  acceptedConclusionIds: ReadonlySet<string> = new Set(),
  operation: "status" | "check" = "check",
): readonly CheckConclusion[] {
  return project.conclusions
    .filter(
      (conclusion) =>
        !acceptedConclusionIds.has(conclusion.id) &&
        conclusion.ruleId !== "exceptions" &&
        !isExecutionPrecondition(conclusion.code) &&
        !conclusionUnavailable(project, conclusion, operation),
    )
    .sort((left, right) => compareText(left.id, right.id));
}

export async function recordException(
  projectDirectory: string,
  id: string,
  reason: string,
  options: ExceptionRecordingOptions = {},
): Promise<ExceptionReceipt> {
  const normalizedReason = reason.trim();
  if (normalizedReason.length === 0) {
    throw new ProjectOperationError(
      "记录例外必须提供理由",
      "exception.reason-required",
      { file: `${stateDirectoryName}/${exceptionsFileName}`, path: [] },
    );
  }
  const project = await currentExceptionProject(projectDirectory);
  // 记录时重新评估全部候选，允许维护者为同一有效对象更新理由。
  const selected = exceptionCandidates(project).find(
    (candidate) => candidate.id === id,
  );
  if (selected === undefined) {
    throw new ProjectOperationError(
      "当前找不到此例外候选 ID；内容可能已变化或无法评估",
      "exception.not-current",
      { file: `${stateDirectoryName}/${exceptionsFileName}`, path: [] },
    );
  }
  const { description, expected, actual, ...subject } = selected;
  void description;
  void expected;
  void actual;
  const record: ExceptionRecord = { ...subject, reason: normalizedReason };
  const records: ExceptionRecords = {
    schemaVersion: 3,
    records: [
      ...project.exceptions.records.filter(
        (existing) => existing.objectId !== record.objectId,
      ),
      record,
    ].sort((left, right) => compareText(left.objectId, right.objectId)),
  };
  await persistExceptionRecords(project, records, options, (current) => {
    const stillCurrent = exceptionCandidates(current).find(
      (candidate) =>
        candidate.id === selected.id &&
        candidate.objectId === selected.objectId &&
        candidate.contentFingerprint === selected.contentFingerprint,
    );
    if (stillCurrent === undefined) {
      throw new ProjectOperationError(
        "写入前例外对象已变化，未记录例外",
        "exception.changed",
        selected.location,
      );
    }
  });
  return {
    id: record.id,
    contentFingerprint: record.contentFingerprint,
    reason: record.reason,
  };
}

export async function inspectProject(
  projectDirectory: string,
  operation: "status" | "check",
  registeredRules: readonly CheckRule[] = builtInRules,
): Promise<ProjectReport> {
  let evaluated: EvaluatedSavedProject;
  try {
    evaluated = await evaluatedProjectForInspection(
      projectDirectory,
      operation,
      registeredRules,
    );
  } catch (error) {
    return invalidStateReport(
      operation,
      error instanceof Error ? error.message : String(error),
      error instanceof ProjectOperationError
        ? error.diagnosticCode
        : "state.invalid",
      error instanceof ProjectOperationError
        ? error.location
        : { file: stateDirectoryName, path: [] },
    );
  }
  const resolved = applyExceptionRecords(evaluated, operation);
  return makeReport(
    operation,
    evaluated.view,
    evaluated.lock,
    resolved.diagnostics,
    operation === "check" ? evaluated.qualityCoverage : undefined,
    exceptionCandidates(evaluated, resolved.acceptedConclusionIds, operation),
  );
}

export function operationExitCode(report: ProjectReport): number {
  if (report.operation === "init") return 0;
  if (issueCount(report) > 0) return 1;
  if (report.coverage?.complete === false) return 1;
  return 0;
}
