import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, join } from "node:path";

import { isMap, type Document } from "yaml";

import {
  parseConfiguration,
  syncConfigurationFingerprint,
} from "#/configuration";
import { readJarResources } from "#/jar";
import { collectMessages } from "#/messages";
import type {
  CheckCoverage,
  ConsumerConfiguration,
  Diagnostic,
  DiagnosticLocation,
  JsonValue,
  ProjectFileIssue,
  ProjectReport,
  ProjectSummary,
  ProjectView,
  ResourceInventoryEntry,
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
import { parseYaml, setDocumentPath } from "#/yaml-data";

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

function resourceMismatches(
  declared: readonly ResourceInventoryEntry[],
  actual: readonly { readonly path: string }[],
  duplicates: readonly string[],
): string | undefined {
  const expectedPaths = declared.map((entry) => entry.path).sort();
  const actualPaths = actual.map((entry) => entry.path).sort();
  const expectedSet = new Set(expectedPaths);
  const actualSet = new Set(actualPaths);
  const missing = expectedPaths.filter((path) => !actualSet.has(path));
  const undeclared = actualPaths.filter((path) => !expectedSet.has(path));
  const differences = [
    ...(missing.length === 0
      ? []
      : [`声明中不存在的资源：${missing.join("、")}`]),
    ...(undeclared.length === 0
      ? []
      : [`尚未登记的新资源：${undeclared.join("、")}`]),
    ...(duplicates.length === 0
      ? []
      : [`JAR 中有重复路径：${duplicates.join("、")}`]),
  ];
  return differences.length === 0 ? undefined : differences.join("；");
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
  source: JsonValue,
  target: JsonValue | undefined,
): boolean {
  if (typeof source === "string") return typeof target === "string";
  if (Array.isArray(source)) {
    return (
      Array.isArray(target) && target.every((item) => typeof item === "string")
    );
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
    fileIssues: [],
  };
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
  return {
    sourceLanguage: baseline.translationScope.sourceLanguage,
    targetLanguage: baseline.translationScope.targetLanguage,
    resources: baseline.resources.map(({ path, purpose }) => ({
      path,
      purpose,
    })),
    messages: collected.messages,
    targetMessages: collected.targetMessages,
    fileIssues: [...extraIssues, ...collected.issues],
  };
}

function coverageUnavailable(view: ProjectView): readonly string[] {
  const unavailable = [
    "MiniMessage 语法、标签与交互检查尚未实现",
    "变量、术语、风格和译文一致性检查尚未实现",
  ];
  if (
    view.resources.some((resource) => resource.purpose === "bedrock-excluded")
  ) {
    unavailable.push("Bedrock JSON 已登记但本票不解析");
  }
  if (view.resources.some((resource) => resource.purpose === "gui-language")) {
    unavailable.push("GUI 语言资源已登记但本票不解析");
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
      `发现未完成的初始化事务且无法安全恢复：${error instanceof Error ? error.message : String(error)}`,
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
  const resources: ResourceSnapshot[] = configuration.resources
    .map((resource) => ({
      ...resource,
      sha256: sha256(jarByPath.get(resource.path)!),
    }))
    .sort((left, right) => compareText(left.path, right.path));

  const mappings: MappingSnapshot[] = [];
  for (const mapping of configuration.translationScope.mappings) {
    const sourceBytes = jarByPath.get(mapping.source);
    if (sourceBytes === undefined) {
      throw new ProjectOperationError(`映射原文不在 JAR 中：${mapping.source}`);
    }
    const parsed = readYaml(sourceBytes, mapping.source);
    mappings.push({
      mapping,
      sourceValue: parsed.value,
      sourceSha256: sha256(canonicalJson(parsed.value)),
    });
  }
  const invalidSourceIssues = sourceMessageIssues(mappings, resources);
  if (invalidSourceIssues.length > 0) {
    const detail = invalidSourceIssues
      .map((issue) => `${issue.file} ${issue.path.join(".")}: ${issue.reason}`)
      .join("；");
    throw new ProjectOperationError(
      `原文不符合已声明的聊天字段分类：${detail}`,
    );
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
    } else if (!isValidTargetValue(message.source, message.target)) {
      continue;
    } else if (sameValue(message.target, message.source)) {
      sameTextCandidates.push({
        id: message.id,
        sourceSha256: sha256(canonicalJson(message.source)),
      });
    }
  }

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
  const evaluation = evaluateProject(loaded.view, loaded.configuration);
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
    loaded.view,
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
