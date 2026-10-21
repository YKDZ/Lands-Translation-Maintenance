import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, join } from "node:path";

import { isMap, type Document } from "yaml";

import {
  parseConfiguration,
  syncConfigurationFingerprint,
} from "#/configuration";
import { readJarResources } from "#/jar";
import { collectMessages, fieldSelectorMatchesPath } from "#/messages";
import { parseMiniMessages } from "#/minimessage";
import {
  captureMiniMessageTheme,
  validateMiniMessageThemeYaml,
  type MiniMessageThemeSnapshot,
} from "#/minimessage-theme";
import type {
  CheckCoverage,
  ConsumerConfiguration,
  Diagnostic,
  DiagnosticLocation,
  JsonValue,
  ObservedMessage,
  ProjectFileIssue,
  ProjectReport,
  ProjectSummary,
  ProjectStructure,
  ProjectView,
  ResourceInventoryEntry,
  SyncInputSnapshot,
  SyncMessageChange,
  SyncPlan,
  SyncPreviewResult,
  SyncResourceChanges,
  SyncResourceDifference,
  SyncStructureChange,
  SyncTargetFilePlan,
  SyncWrite,
  Severity,
} from "#/model";
import { builtInRules, evaluateRules } from "#/rules";
import {
  baselineFileName,
  baselineDirectoryName,
  configurationFileName,
  lockFileName,
  loadConfiguration,
  readState,
  resourceSetFingerprint,
  syncLockIntegrity,
  serializeBaseline,
  serializeLock,
  stateDirectoryName,
  transactionFileName,
  type MappingSnapshot,
  type ResourceSnapshot,
  type SameTextCandidate,
  type SourceBaseline,
  type SyncLock,
  type TranslationSeed,
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

export interface SyncApplyOptions {
  readonly beforeApply?: () => Promise<void>;
}

export type SyncApplyResult =
  | {
      readonly applied: true;
      readonly plan: SyncPlan;
      readonly status: ProjectReport;
    }
  | {
      readonly applied: false;
      readonly preview: Extract<SyncPreviewResult, { readonly ready: false }>;
    };

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

function requireMiniMessageTheme(
  resources: readonly ResourceInventoryEntry[],
  resourceBytes: ReadonlyMap<string, Uint8Array>,
): MiniMessageThemeSnapshot | undefined {
  const captured = captureMiniMessageTheme(resources, resourceBytes);
  if (captured.ambiguousFiles.length > 0) {
    throw new ProjectOperationError(
      `主题资源不唯一：${captured.ambiguousFiles.join("、")}`,
      "minimessage.theme-ambiguous",
      { file: captured.ambiguousFiles[0]!, path: [] },
    );
  }
  if (captured.unavailableFiles.length > 0) {
    throw new ProjectOperationError(
      `无法读取主题资源：${captured.unavailableFiles.join("、")}`,
      "minimessage.theme-unavailable",
      { file: captured.unavailableFiles[0]!, path: [] },
    );
  }
  if (captured.theme === undefined) return undefined;

  const issues = validateMiniMessageThemeYaml(captured.theme);
  if (issues.length === 0) return captured.theme;
  const details = issues
    .map(
      (issue) =>
        `${issue.file}${issue.path.length === 0 ? "" : `:${issue.path.join(".")}`}：${issue.reason}`,
    )
    .join("；");
  const firstIssue = issues[0]!;
  throw new ProjectOperationError(
    `主题 YAML 无法安全读取：${details}`,
    firstIssue.code,
    {
      file: firstIssue.file,
      path: firstIssue.path,
      ...(firstIssue.line === undefined ? {} : { line: firstIssue.line }),
      ...(firstIssue.column === undefined ? {} : { column: firstIssue.column }),
    },
  );
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
): SyncResourceDifference {
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
    if (sameValue(message.target, message.source)) pendingTranslations += 1;
    else modifiedTranslations += 1;
  }
  for (const candidate of lock.sameTextCandidates) {
    const message = messages.get(candidate.id);
    if (
      message !== undefined &&
      message.targetStatus === "present" &&
      message.target !== undefined &&
      sameValue(message.target, message.source)
    ) {
      sameTextCandidates += 1;
    }
  }

  return {
    resourceFiles: project.resources.length,
    messages: project.messages.length,
    pendingTranslations,
    sameTextCandidates,
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
  const diagnosticId = sha256(
    canonicalJson({ ruleId, code, location, expected, actual }),
  );
  return {
    diagnosticId,
    ruleId,
    severity,
    code,
    location,
    reason,
    expected,
    actual,
  };
}

function makeReport(
  operation: ProjectReport["operation"],
  project: ProjectView,
  lock: SyncLock,
  diagnostics: readonly Diagnostic[],
  coverage?: CheckCoverage,
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
        .filter((message) => message.sourceFile === snapshot.mapping.source)
        .map((message) => message.path),
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
  );
  return {
    sourceLanguage: baseline.translationScope.sourceLanguage,
    targetLanguage: baseline.translationScope.targetLanguage,
    resources: baseline.resources.map(({ path, purpose }) => ({
      path,
      purpose,
    })),
    messages: collected.messages,
    targetMessages: collected.targetMessages,
    structures,
    fileIssues: [
      ...extraIssues,
      ...collected.issues,
      ...structureFindingIssues(structures),
    ],
  };
}

interface StructurePlanResult {
  readonly changes: readonly SyncStructureChange[];
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
  previousMessages: readonly ObservedMessage[],
): StructurePlanResult {
  const previousBySource = new Map(
    previousMappings.map((snapshot) => [snapshot.mapping.source, snapshot]),
  );
  const changes: SyncStructureChange[] = [];
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
    const translationPaths = [...currentMessages, ...previousMessages]
      .filter((message) => message.sourceFile === mapping.source)
      .map((message) => message.path);

    if (!isRecord(currentDefinitions)) {
      blockers.push({
        code: "sync.structure-source-shape",
        reason: `${definitionsSource} 的结构根节点必须是映射`,
      });
      continue;
    }
    if (previousDefinitions !== undefined && !isRecord(previousDefinitions)) {
      blockers.push({
        code: "sync.structure-source-shape",
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
            code: "sync.structure-source-shape",
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
        code: "sync.structure-target-path-type",
        reason: `${mapping.target}:${path.join(".")} 的目标类型为${structureValueType(actual)}，上游结构类型为${structureValueType(expected)}`,
      });
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
          code: "sync.structure-source-shape",
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
  changes: readonly SyncStructureChange[],
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

function coverageUnavailable(view: ProjectView): readonly string[] {
  const unavailable = [
    "MiniMessage 变量、交互、标签对等及 Lands 控制语义检查尚未实现",
    "变量、术语、风格和译文一致性检查尚未实现",
  ];
  unavailable.push(...(view.miniMessage?.unavailableCapabilities ?? []));
  if (
    view.resources.some((resource) => resource.purpose === "bedrock-excluded")
  ) {
    unavailable.push("Bedrock JSON 已登记但本票不解析");
  }
  return unavailable;
}

function evaluateProject(
  view: ProjectView,
  configuration: ConsumerConfiguration,
) {
  return evaluateRules(view, builtInRules, {
    configuration: configuration.rules,
    unavailableCapabilities: coverageUnavailable(view),
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
  const miniMessageTheme = requireMiniMessageTheme(
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
  const evaluated = evaluateRules(view, builtInRules, {
    configuration: configuration.rules,
  });
  return makeReport("init", view, lock, evaluated.diagnostics);
}

function currentResourceChanges(
  previous: readonly ResourceSnapshot[],
  actual: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  maintainedSources: ReadonlySet<string>,
): SyncResourceChanges {
  const previousByPath = new Map(
    previous.map((resource) => [resource.path, resource]),
  );
  const actualByPath = new Map(
    actual.map((resource) => [resource.path, sha256(resource.bytes)]),
  );
  const added = [...actualByPath.keys()]
    .filter((path) => !previousByPath.has(path))
    .sort(compareText);
  const removed = [...previousByPath.keys()]
    .filter((path) => !actualByPath.has(path))
    .sort(compareText);
  const changed = [...actualByPath]
    .filter(([path, digest]) => previousByPath.get(path)?.sha256 !== digest)
    .map(([path]) => path)
    .filter((path) => previousByPath.has(path))
    .sort(compareText);
  const unchanged = [...actualByPath]
    .filter(([path, digest]) => previousByPath.get(path)?.sha256 === digest)
    .map(([path]) => path)
    .sort(compareText);

  return {
    added,
    removed,
    changed,
    unchanged,
    observedOnly: {
      added: added.filter((path) => !maintainedSources.has(path)),
      removed: removed.filter((path) => !maintainedSources.has(path)),
      changed: changed.filter((path) => !maintainedSources.has(path)),
    },
  };
}

function targetAddress(file: string, path: readonly string[]): string {
  return `${file}\u0000${canonicalJson(path)}`;
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

function targetValueMap(
  targets: ReadonlyMap<string, TargetFileInput>,
): ReadonlyMap<string, JsonValue | undefined> {
  return new Map(
    [...targets].map(([path, target]) => [path, target.value] as const),
  );
}

function addSnapshot(
  snapshots: Map<string, SyncInputSnapshot>,
  snapshot: SyncInputSnapshot,
): void {
  snapshots.set(snapshot.path, snapshot);
}

function makeSyncResourceSnapshots(
  configuration: ConsumerConfiguration,
  jarResources: readonly {
    readonly path: string;
    readonly bytes: Uint8Array;
  }[],
): ResourceSnapshot[] {
  const jarByPath = new Map(
    jarResources.map((resource) => [resource.path, resource.bytes]),
  );
  return configuration.resources
    .map((resource) => ({
      ...resource,
      sha256: sha256(jarByPath.get(resource.path)!),
    }))
    .sort((left, right) => compareText(left.path, right.path));
}

function makeSyncMappings(
  configuration: ConsumerConfiguration,
  jarResources: readonly {
    readonly path: string;
    readonly bytes: Uint8Array;
  }[],
): MappingSnapshot[] {
  const jarByPath = new Map(
    jarResources.map((resource) => [resource.path, resource.bytes]),
  );
  return configuration.translationScope.mappings.map((mapping) =>
    readMappingSnapshot(mapping, jarByPath),
  );
}

export async function previewSyncProject(
  projectDirectory: string,
  jarPath: string,
): Promise<SyncPreviewResult> {
  const project = await realpath(resolve(projectDirectory));
  const configFile = join(project, configurationFileName);
  await assertNoSymlinkPath(project, configurationFileName);
  const jarFile = resolve(jarPath);
  const [configInput, jarInput] = await Promise.all([
    readBytes(configFile, "维护清单"),
    readBinary(jarFile, "JAR"),
  ]);
  const configuration = requireConfiguration(configInput.text);
  const state = await readState(project);
  if (!state.ok) {
    throw new ProjectOperationError(state.message, "state.invalid", {
      file: stateDirectoryName,
      path: [],
    });
  }

  const jar = await readJarResources(jarInput.bytes);
  const resourceDifference = compareResourceInventory(
    configuration.resources,
    jar.resources,
    jar.duplicatePaths,
  );
  const maintainedSources = new Set(
    configuration.translationScope.mappings.map((mapping) => mapping.source),
  );
  const resourceChanges = currentResourceChanges(
    state.baseline.resources,
    jar.resources,
    maintainedSources,
  );
  const hasResourceDifference =
    resourceDifference.undeclared.length > 0 ||
    resourceDifference.missing.length > 0 ||
    resourceDifference.duplicates.length > 0;
  if (hasResourceDifference) {
    return {
      ready: false,
      blockers: [
        {
          code: "resource.inventory-mismatch",
          reason: "JAR 的完整非 .class 文件集合必须与资源声明一致",
        },
      ],
      resourceDifference,
      resourceChanges,
    };
  }

  const jarByPath = new Map(
    jar.resources.map((resource) => [resource.path, resource.bytes]),
  );
  const miniMessageTheme = requireMiniMessageTheme(
    configuration.resources,
    jarByPath,
  );
  const resources = makeSyncResourceSnapshots(configuration, jar.resources);
  const mappings = makeSyncMappings(configuration, jar.resources);
  const invalidSourceIssues = sourceMessageIssues(mappings, resources);
  if (invalidSourceIssues.length > 0) {
    const detail = invalidSourceIssues
      .map((issue) => `${issue.file} ${issue.path.join(".")}: ${issue.reason}`)
      .join("；");
    throw new ProjectOperationError(
      `原文不符合已声明的聊天字段分类：${detail}`,
    );
  }

  const combinedBaseline: SourceBaseline = {
    ...state.baseline,
    resources,
    mappings: [
      ...state.baseline.mappings.filter(({ mapping }) =>
        maintainedSources.has(mapping.source),
      ),
      ...mappings,
    ],
  };
  const targetInput = await readTargets(project, combinedBaseline);
  const invalidTargetIssues = targetInput.issues.filter((issue) =>
    ["yaml-invalid", "yaml-duplicate-key", "yaml-root-invalid"].includes(
      issue.code,
    ),
  );
  if (invalidTargetIssues.length > 0) {
    const details = invalidTargetIssues
      .map((issue) => `${issue.file}：${issue.reason}`)
      .join("；");
    throw new ProjectOperationError(`现有目标 YAML 无法安全读取：${details}`);
  }

  const targets = targetInput.targets;
  const currentCollection = collectMessages(
    mappings,
    targetValueMap(targets),
    resources,
  );
  const previousCollection = collectMessages(
    state.baseline.mappings,
    targetValueMap(targets),
    state.baseline.resources,
  );
  const structurePlan = planStructureChanges(
    state.baseline.mappings,
    mappings,
    targets,
    currentCollection.messages,
    previousCollection.messages,
  );
  if (structurePlan.blockers.length > 0) {
    return {
      ready: false,
      blockers: structurePlan.blockers,
      resourceDifference,
      resourceChanges,
    };
  }
  const previousMessages = new Map(
    previousCollection.messages.map((message) => [message.id, message]),
  );
  const previousMessagesByAddress = new Map(
    previousCollection.messages.map((message) => [
      targetAddress(message.targetFile, message.path),
      message,
    ]),
  );
  const currentMessages = currentCollection.messages;
  const currentMessageAddresses = new Set(
    currentMessages.map((message) =>
      targetAddress(message.targetFile, message.path),
    ),
  );
  const currentMessageIds = new Set(currentMessages.map(({ id }) => id));
  const sourceRemovedMessages = previousCollection.messages.filter(
    (previous) =>
      !currentMessageIds.has(previous.id) &&
      mappings.some(
        ({ mapping }) =>
          mapping.target === previous.targetFile &&
          mapping.fields.some((field) =>
            fieldSelectorMatchesPath(previous.path, field),
          ),
      ),
  );
  const blockedRemovedMessages = sourceRemovedMessages.filter(
    (message) => message.targetStatus === "blocked",
  );
  if (blockedRemovedMessages.length > 0) {
    const paths = blockedRemovedMessages
      .map((message) => `${message.targetFile}:${message.path.join(".")}`)
      .sort(compareText);
    return {
      ready: false,
      blockers: [
        {
          code: "sync.target-path-blocked",
          reason: `目标路径被现有结构阻断，无法安全删除已移除的原文：${paths.join("、")}`,
        },
      ],
      resourceDifference,
      resourceChanges,
    };
  }
  const deletableRemovedMessages = sourceRemovedMessages.filter(
    (message) => message.targetStatus !== "blocked",
  );
  const messagesUnblockedByRemoval = new Set(
    currentMessages
      .filter(
        (message) =>
          message.targetStatus === "blocked" &&
          deletableRemovedMessages.some(
            (previous) =>
              previous.targetStatus === "present" &&
              previous.targetFile === message.targetFile &&
              pathStartsWith(message.path, previous.path),
          ),
      )
      .map(({ id }) => id),
  );
  const unsafeBlockedMessages = currentMessages.filter((message) => {
    if (
      message.targetStatus !== "blocked" ||
      messagesUnblockedByRemoval.has(message.id)
    ) {
      return false;
    }
    const previous = previousMessages.get(message.id);
    return (
      previous === undefined || !sameValue(previous.source, message.source)
    );
  });
  if (unsafeBlockedMessages.length > 0) {
    const paths = unsafeBlockedMessages
      .map((message) => `${message.targetFile}:${message.path.join(".")}`)
      .sort(compareText);
    return {
      ready: false,
      blockers: [
        {
          code: "sync.target-path-blocked",
          reason: `新增或变化的原文无法写入被现有结构阻断的目标路径：${paths.join("、")}`,
        },
      ],
      resourceDifference,
      resourceChanges,
    };
  }
  const currentMappingsByTarget = new Map(
    mappings.map(({ mapping }) => [mapping.target, mapping]),
  );
  const currentTargetPaths = new Set(currentMappingsByTarget.keys());
  const changedTargetPaths = new Set<string>();
  for (const [path, target] of targets) {
    if (target.originalSha256 === undefined) changedTargetPaths.add(path);
  }
  applyStructureChanges(targets, structurePlan.changes, changedTargetPaths);

  const plannedMessages: SyncMessageChange[] = [];
  const targetAfter = new Map<string, JsonValue>();
  const requiresTranslation = new Set<string>();
  for (const previous of deletableRemovedMessages) {
    const target = targets.get(previous.targetFile);
    if (previous.targetStatus === "present") {
      if (target === undefined || previous.target === undefined) {
        throw new ProjectOperationError(
          `无法准备目标文件：${previous.targetFile}`,
        );
      }
      target.document.deleteIn(previous.path);
      changedTargetPaths.add(previous.targetFile);
    }
    plannedMessages.push({
      id: previous.id,
      action: "delete",
      reason: "source-removed",
      sourceFile: previous.sourceFile,
      targetFile: previous.targetFile,
      path: previous.path,
      category: previous.category,
      ...(previous.scene === undefined ? {} : { scene: previous.scene }),
      ...(previous.format === undefined ? {} : { format: previous.format }),
      previousSource: previous.source,
      ...(previous.target === undefined
        ? {}
        : { previousTarget: previous.target }),
    });
  }
  for (const message of currentMessages) {
    const previous = previousMessages.get(message.id);
    if (
      message.targetStatus === "blocked" &&
      !messagesUnblockedByRemoval.has(message.id)
    ) {
      plannedMessages.push({
        id: message.id,
        action: "preserve",
        reason: "target-path-blocked",
        sourceFile: message.sourceFile,
        targetFile: message.targetFile,
        path: message.path,
        category: message.category,
        ...(message.scene === undefined ? {} : { scene: message.scene }),
        ...(message.format === undefined ? {} : { format: message.format }),
        ...(previous === undefined ? {} : { previousSource: previous.source }),
        source: message.source,
      });
      continue;
    }
    const previousTargetRoot =
      previous === undefined
        ? undefined
        : targets.get(previous.targetFile)?.value;
    const previousTarget =
      previous === undefined
        ? undefined
        : valueAtPath(previousTargetRoot, previous.path);
    const currentTargetRoot = targets.get(message.targetFile)?.value;
    const currentTarget = valueAtPath(currentTargetRoot, message.path);
    const selectedPreviousTarget =
      currentTarget !== undefined ? currentTarget : previousTarget;
    const sourceUnchanged =
      previous !== undefined && sameValue(previous.source, message.source);
    let action: SyncMessageChange["action"];
    let reason: SyncMessageChange["reason"];
    let plannedTarget: JsonValue;

    if (sourceUnchanged && selectedPreviousTarget !== undefined) {
      action = "preserve";
      reason = "unchanged";
      plannedTarget = selectedPreviousTarget;
      if (currentTarget === undefined) {
        const destination = targets.get(message.targetFile);
        if (destination === undefined) {
          throw new ProjectOperationError(
            `无法准备目标文件：${message.targetFile}`,
          );
        }
        updateDocumentValue(destination.document, message.path, plannedTarget);
        changedTargetPaths.add(message.targetFile);
      }
    } else if (sourceUnchanged) {
      action = "seed";
      reason = "missing-translation";
      plannedTarget = message.source;
      requiresTranslation.add(message.id);
      const destination = targets.get(message.targetFile);
      if (destination === undefined) {
        throw new ProjectOperationError(
          `无法准备目标文件：${message.targetFile}`,
        );
      }
      updateDocumentValue(destination.document, message.path, plannedTarget);
      changedTargetPaths.add(message.targetFile);
    } else {
      action = previous === undefined ? "seed" : "reset";
      reason = previous === undefined ? "new-message" : "source-changed";
      plannedTarget = message.source;
      requiresTranslation.add(message.id);
      const destination = targets.get(message.targetFile);
      if (destination === undefined) {
        throw new ProjectOperationError(
          `无法准备目标文件：${message.targetFile}`,
        );
      }
      updateDocumentValue(destination.document, message.path, plannedTarget);
      changedTargetPaths.add(message.targetFile);
    }

    targetAfter.set(message.id, plannedTarget);
    plannedMessages.push({
      id: message.id,
      action,
      reason,
      sourceFile: message.sourceFile,
      targetFile: message.targetFile,
      path: message.path,
      category: message.category,
      ...(message.scene === undefined ? {} : { scene: message.scene }),
      ...(message.format === undefined ? {} : { format: message.format }),
      ...(previous === undefined ? {} : { previousSource: previous.source }),
      source: message.source,
      ...(selectedPreviousTarget === undefined
        ? {}
        : { previousTarget: selectedPreviousTarget }),
      target: plannedTarget,
    });
  }

  for (const targetMessage of currentCollection.targetMessages) {
    const address = targetAddress(targetMessage.targetFile, targetMessage.path);
    if (currentMessageAddresses.has(address)) continue;
    if (
      deletableRemovedMessages.some(
        (previous) =>
          previous.targetFile === targetMessage.targetFile &&
          pathStartsWith(targetMessage.path, previous.path),
      )
    ) {
      continue;
    }
    if (
      currentMessages.some(
        (message) =>
          message.targetStatus === "blocked" &&
          message.targetFile === targetMessage.targetFile &&
          targetMessage.path.length < message.path.length &&
          targetMessage.path.every(
            (segment, index) => message.path[index] === segment,
          ),
      )
    ) {
      continue;
    }
    if (
      currentMessages.some(
        (message) =>
          message.targetStatus === "present" &&
          message.target !== undefined &&
          !isValidTargetValue(message.category, message.target) &&
          message.targetFile === targetMessage.targetFile &&
          message.path.length < targetMessage.path.length &&
          message.path.every(
            (segment, index) => targetMessage.path[index] === segment,
          ),
      )
    ) {
      continue;
    }
    const target = targets.get(targetMessage.targetFile);
    if (target === undefined) continue;
    target.document.deleteIn(targetMessage.path);
    changedTargetPaths.add(targetMessage.targetFile);
    const previous = previousMessagesByAddress.get(address);
    const mapping = currentMappingsByTarget.get(targetMessage.targetFile);
    plannedMessages.push({
      id: targetMessage.id,
      action: "delete",
      reason:
        previous === undefined ? "orphaned-translation" : "source-removed",
      sourceFile: previous?.sourceFile ?? mapping?.source ?? "",
      targetFile: targetMessage.targetFile,
      path: targetMessage.path,
      category: targetMessage.category,
      ...(targetMessage.scene === undefined
        ? {}
        : { scene: targetMessage.scene }),
      ...(targetMessage.format === undefined
        ? {}
        : { format: targetMessage.format }),
      ...(previous === undefined ? {} : { previousSource: previous.source }),
      previousTarget: targetMessage.value,
    });
  }

  const translationSeeds = new Map(
    state.lock.translationSeeds.map((seed) => [seed.id, seed]),
  );
  const sameTextCandidates = new Map(
    state.lock.sameTextCandidates.map((candidate) => [candidate.id, candidate]),
  );
  const nextSeeds = new Map<string, TranslationSeed>();
  const nextSameTextCandidates = new Map<string, SameTextCandidate>();
  for (const message of currentMessages) {
    const sourceSha256 = sha256(canonicalJson(message.source));
    const oldSeed = translationSeeds.get(message.id);
    const oldCandidate = sameTextCandidates.get(message.id);
    const newSeed = requiresTranslation.has(message.id);
    if (
      newSeed ||
      (oldSeed !== undefined && oldSeed.sourceSha256 === sourceSha256)
    ) {
      nextSeeds.set(message.id, {
        id: message.id,
        sourceSha256,
        reason: "missing",
      });
      continue;
    }
    if (
      oldCandidate !== undefined &&
      oldCandidate.sourceSha256 === sourceSha256
    ) {
      nextSameTextCandidates.set(message.id, oldCandidate);
    }
    const plannedTarget = targetAfter.get(message.id);
    if (
      plannedTarget !== undefined &&
      sameValue(plannedTarget, message.source)
    ) {
      nextSameTextCandidates.set(message.id, { id: message.id, sourceSha256 });
    }
  }

  const baseline: SourceBaseline = {
    schemaVersion: 1,
    source: configuration.source,
    translationScope: configuration.translationScope,
    jarSha256: jarInput.sha256,
    resources,
    mappings,
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
    translationSeeds: [...nextSeeds.values()].sort((left, right) =>
      compareText(left.id, right.id),
    ),
    sameTextCandidates: [...nextSameTextCandidates.values()].sort(
      (left, right) => compareText(left.id, right.id),
    ),
  };
  const lock: SyncLock = {
    ...lockContents,
    integritySha256: syncLockIntegrity(lockContents),
  };
  const lockText = serializeLock(lock);
  const baselinePath = join(
    project,
    stateDirectoryName,
    baselineDirectoryName,
    baselineFileName,
  );
  const lockPath = join(project, stateDirectoryName, lockFileName);
  const inputSnapshots = new Map<string, SyncInputSnapshot>();
  addSnapshot(inputSnapshots, { path: configFile, sha256: configInput.sha256 });
  addSnapshot(inputSnapshots, { path: jarFile, sha256: jarInput.sha256 });
  addSnapshot(inputSnapshots, {
    path: baselinePath,
    sha256: sha256(state.baselineText),
  });
  addSnapshot(inputSnapshots, {
    path: lockPath,
    sha256: sha256(state.lockText),
  });
  for (const snapshot of targetInput.snapshots) {
    addSnapshot(inputSnapshots, {
      path: snapshot.path,
      ...(snapshot.sha256 === undefined ? {} : { sha256: snapshot.sha256 }),
    });
  }

  const targetPlans: SyncTargetFilePlan[] = [];
  const writes: SyncWrite[] = [];
  for (const [path, target] of targets) {
    if (!currentTargetPaths.has(path)) continue;
    const content = target.document.toString({ lineWidth: 0 });
    const changed = changedTargetPaths.has(path);
    const contentSha256 = changed
      ? sha256(content)
      : (target.originalSha256 ?? sha256(content));
    targetPlans.push({
      path,
      action: changed ? "write" : "unchanged",
      ...(target.originalSha256 === undefined
        ? {}
        : { expectedSha256: target.originalSha256 }),
      contentSha256,
    });
    if (changed) {
      writes.push({
        kind: "target",
        path: resolveProjectFile(project, path),
        content,
        ...(target.originalSha256 === undefined
          ? {}
          : { expectedSha256: target.originalSha256 }),
      });
    }
  }
  writes.push(
    {
      kind: "baseline",
      path: baselinePath,
      content: baselineText,
      expectedSha256: sha256(state.baselineText),
    },
    {
      kind: "lock",
      path: lockPath,
      content: lockText,
      expectedSha256: sha256(state.lockText),
    },
  );

  const previousTargetPaths = new Set(
    state.baseline.mappings.map(({ mapping }) => mapping.target),
  );
  const unmanagedTargets = [...previousTargetPaths]
    .filter((path) => !currentTargetPaths.has(path))
    .sort(compareText);
  const pendingTranslations = currentMessages
    .filter(
      (message) =>
        nextSeeds.has(message.id) &&
        sameValue(targetAfter.get(message.id), message.source),
    )
    .map((message) => message.id)
    .sort(compareText);
  plannedMessages.sort((left, right) =>
    compareText(
      `${left.targetFile}:${canonicalJson(left.path)}:${left.action}:${left.id}`,
      `${right.targetFile}:${canonicalJson(right.path)}:${right.action}:${right.id}`,
    ),
  );
  targetPlans.sort((left, right) => compareText(left.path, right.path));
  writes.sort((left, right) => compareText(left.path, right.path));
  const plan: SyncPlan = {
    sourceVersion: configuration.source.version,
    jarSha256: jarInput.sha256,
    resourceChanges,
    messages: plannedMessages,
    structures: structurePlan.changes,
    targetFiles: targetPlans,
    unmanagedTargets,
    pendingTranslations,
    inputSnapshots: [...inputSnapshots.values()].sort((left, right) =>
      compareText(left.path, right.path),
    ),
    writes,
  };
  return { ready: true, plan };
}

export async function applySyncProject(
  projectDirectory: string,
  jarPath: string,
  options: SyncApplyOptions = {},
): Promise<SyncApplyResult> {
  const project = await realpath(resolve(projectDirectory));
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

  const preview = await previewSyncProject(project, jarPath);
  if (!preview.ready) return { applied: false, preview };

  const writes: FileWrite[] = preview.plan.writes.map((write) => ({
    path: write.path,
    content: write.content,
    expectedSha256: write.expectedSha256,
  }));
  const inputSnapshots: FileSnapshot[] = preview.plan.inputSnapshots.map(
    (snapshot) => ({ path: snapshot.path, sha256: snapshot.sha256 }),
  );
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
      throw new ProjectOperationError(error.message, "sync.concurrent-edit", {
        file: error.file,
        path: [],
      });
    }
    throw error;
  }

  return {
    applied: true,
    plan: preview.plan,
    status: await inspectProject(project, "status"),
  };
}

async function loadSavedProject(projectDirectory: string): Promise<{
  readonly baseline: SourceBaseline;
  readonly lock: SyncLock;
  readonly configuration: ConsumerConfiguration;
  readonly view: ProjectView;
  readonly diagnostics: readonly Diagnostic[];
}> {
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
  const config = await loadConfiguration(project);
  if (!config.ok) {
    throw new ProjectOperationError(config.message, "configuration.invalid", {
      file: configurationFileName,
      path: [],
    });
  }
  const targetInput = await readTargets(project, state.baseline);
  const view = projectView(
    state.baseline,
    targetInput.targets,
    targetInput.issues,
  );
  const diagnostics: Diagnostic[] = [];
  if (
    syncConfigurationFingerprint(config.configuration) !==
    state.lock.syncConfigurationSha256
  ) {
    diagnostics.push(
      diagnostic(
        "structure",
        "sync.configuration-changed",
        "error",
        "影响原文解析或同步的维护声明已更改，需重新初始化以保存新基线",
        { file: configurationFileName, path: ["translationScope"] },
        { syncConfigurationSha256: state.lock.syncConfigurationSha256 },
        {
          syncConfigurationSha256: syncConfigurationFingerprint(
            config.configuration,
          ),
        },
      ),
    );
  }
  const evaluated = evaluateRules(view, builtInRules, {
    configuration: config.configuration.rules,
  });
  diagnostics.push(...evaluated.diagnostics);
  return {
    baseline: state.baseline,
    lock: state.lock,
    configuration: config.configuration,
    view,
    diagnostics,
  };
}

export async function inspectProject(
  projectDirectory: string,
  operation: "status" | "check",
): Promise<ProjectReport> {
  let loaded;
  try {
    loaded = await loadSavedProject(projectDirectory);
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
  if (operation === "status") {
    return makeReport(operation, loaded.view, loaded.lock, loaded.diagnostics);
  }
  const view =
    loaded.configuration.rules?.["minimessage-syntax"]?.enabled === false
      ? loaded.view
      : {
          ...loaded.view,
          miniMessage: await parseMiniMessages(
            loaded.view.messages,
            loaded.view.resources,
            loaded.baseline.miniMessageTheme,
          ),
        };
  const evaluation = evaluateProject(view, loaded.configuration);
  const diagnostics = [
    ...loaded.diagnostics,
    ...evaluation.diagnostics.filter(
      (entry) =>
        !loaded.diagnostics.some(
          (existing) => existing.diagnosticId === entry.diagnosticId,
        ),
    ),
  ];
  return makeReport(
    operation,
    view,
    loaded.lock,
    diagnostics,
    evaluation.coverage,
  );
}

export function operationExitCode(report: ProjectReport): number {
  if (report.operation === "init") return 0;
  if (issueCount(report) > 0) return 1;
  if (report.coverage?.complete === false) return 1;
  return 0;
}
