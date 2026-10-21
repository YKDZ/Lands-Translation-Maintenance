import { formatForScene } from "#/field-metadata";
import type {
  DiagnosticLocation,
  JsonValue,
  ObservedMessage,
  ProjectFileIssue,
  ResourceInventoryEntry,
  TargetMessage,
  TranslationField,
  TranslationFieldCategory,
  TranslationMapping,
  ResourcePurpose,
} from "#/model";
import { canonicalJson, compareText, sha256 } from "#/value";
import { valueAtPath } from "#/yaml-data";

export interface SavedMapping {
  readonly mapping: TranslationMapping;
  readonly sourceValue: JsonValue;
}

export interface MessageCollection {
  readonly messages: readonly ObservedMessage[];
  readonly targetMessages: readonly TargetMessage[];
  readonly issues: readonly ProjectFileIssue[];
}

function pathKey(path: readonly string[]): string {
  return canonicalJson(path);
}

function isRecord(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inspectPath(
  root: JsonValue | undefined,
  path: readonly string[],
):
  | { readonly status: "present"; readonly value: JsonValue }
  | { readonly status: "missing" }
  | {
      readonly status: "blocked";
      readonly path: readonly string[];
      readonly value: JsonValue;
    } {
  if (root === undefined) return { status: "missing" };
  let current: JsonValue = root;
  for (let index = 0; index < path.length; index += 1) {
    if (!isRecord(current)) {
      return {
        status: "blocked",
        path: path.slice(0, index),
        value: current,
      };
    }
    const segment = path[index]!;
    if (!Object.hasOwn(current, segment)) return { status: "missing" };
    current = current[segment]!;
  }
  return { status: "present", value: current };
}

function isValidTargetValue(
  category: TranslationFieldCategory,
  target: JsonValue,
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
  return (
    Array.isArray(target) && target.every((item) => typeof item === "string")
  );
}

function messageIdentity(
  mapping: TranslationMapping,
  path: readonly string[],
  field: TranslationField,
  sourcePurpose: ResourcePurpose | undefined,
) {
  const identity = {
    sourceFile: mapping.source,
    path,
  };
  const format = formatForMessagePath(path, field.category, sourcePurpose);
  return {
    ...identity,
    targetFile: mapping.target,
    category: field.category,
    ...(field.scene === undefined
      ? {}
      : { scene: field.scene, format: formatForScene(field.scene) }),
    ...(field.scene !== undefined || format === undefined ? {} : { format }),
    id: sha256(canonicalJson(identity)),
  };
}

function formatForMessagePath(
  path: readonly string[],
  category: TranslationFieldCategory,
  purpose: ResourcePurpose | undefined,
): "legacy-variable-minimessage" | "map-html-minimessage" | undefined {
  if (category !== "chat-string" || purpose !== "chat-language") {
    return undefined;
  }

  if (
    (path.length === 5 &&
      path[0] === "general" &&
      path[1] === "land" &&
      path[2] === "title" &&
      path[3] === "land" &&
      (path[4] === "normal" || path[4] === "levels-disabled")) ||
    (path.length === 4 &&
      path[0] === "general" &&
      path[1] === "land" &&
      path[2] === "title" &&
      (path[3] === "camp" || path[3] === "admin"))
  ) {
    return "legacy-variable-minimessage";
  }

  const mapNames = new Set(["dynmap", "bluemap", "squaremap", "pl3xmap"]);
  if (
    path.length === 5 &&
    path[0] === "general" &&
    path[1] === "integration" &&
    mapNames.has(path[2]!) &&
    path[3] === "land" &&
    (path[4] === "description" || path[4] === "spawn")
  ) {
    return "map-html-minimessage";
  }
  if (
    path.length === 5 &&
    path[0] === "general" &&
    path[1] === "integration" &&
    mapNames.has(path[2]!) &&
    ((path[3] === "nation" && path[4] === "description") ||
      (path[3] === "capital" && path[4] === "spawn"))
  ) {
    return "map-html-minimessage";
  }
  return undefined;
}

function walkStrings(
  value: JsonValue,
  path: readonly string[],
  output: Map<string, { path: readonly string[]; value: JsonValue }>,
  file: string,
  issues: ProjectFileIssue[],
): void {
  if (typeof value === "string") {
    output.set(pathKey(path), { path, value });
    return;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as { readonly [key: string]: JsonValue };
    for (const key of Object.keys(record).sort()) {
      walkStrings(record[key]!, [...path, key], output, file, issues);
    }
    return;
  }
  issues.push({
    file,
    code: "message.type-mismatch",
    reason: "聊天字符串字段必须由字符串或字符串映射组成",
    path,
    expected: "字符串或映射",
    actual: value,
  });
  output.set(pathKey(path), { path, value });
}

function isStringList(value: JsonValue): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isValidMessageValue(
  category: TranslationFieldCategory,
  value: JsonValue,
): boolean {
  if (
    category === "chat-string" ||
    category === "gui-string" ||
    category === "dialog-string" ||
    category === "dialog-label-format" ||
    category === "configuration-string"
  ) {
    return typeof value === "string";
  }
  if (category === "gui-lore") {
    return typeof value === "string" || isStringList(value);
  }
  return isStringList(value);
}

function fieldTypeDescription(category: TranslationFieldCategory): string {
  if (
    category === "chat-string" ||
    category === "gui-string" ||
    category === "dialog-string" ||
    category === "dialog-label-format" ||
    category === "configuration-string"
  ) {
    return "字符串";
  }
  if (category === "gui-lore") return "字符串或只含字符串的列表";
  return "只含字符串的列表";
}

function fieldTypeReason(category: TranslationFieldCategory): string {
  if (category === "gui-lore") return "GUI lore 必须是字符串或只含字符串的列表";
  if (category === "chat-string" || category === "chat-string-list") {
    return category === "chat-string"
      ? "聊天字符串字段必须由字符串或字符串映射组成"
      : "聊天列表字段必须是只含字符串的列表";
  }
  if (category.startsWith("dialog-"))
    return "对话框字段必须符合声明的字符串类型";
  if (category.startsWith("configuration-")) {
    return "配置翻译字段必须符合声明的字符串类型";
  }
  return "GUI 名称、标题和通用文本必须是字符串";
}

interface SelectedEntry {
  readonly path: readonly string[];
  readonly value: JsonValue;
}

interface MatchingEntries {
  readonly entries: readonly SelectedEntry[];
  readonly blockedAncestors: readonly SelectedEntry[];
}

function matchingEntries(
  root: JsonValue | undefined,
  pattern: readonly string[],
): MatchingEntries {
  if (root === undefined) return { entries: [], blockedAncestors: [] };
  const entries: SelectedEntry[] = [];
  const blockedAncestors: SelectedEntry[] = [];
  function visit(
    value: JsonValue,
    path: readonly string[],
    index: number,
  ): void {
    if (index === pattern.length) {
      entries.push({ path, value });
      return;
    }
    const segment = pattern[index]!;
    if (segment === "**") {
      function collectLeaves(current: JsonValue, leafPath: readonly string[]) {
        if (isRecord(current)) {
          for (const key of Object.keys(current).sort()) {
            collectLeaves(current[key]!, [...leafPath, key]);
          }
        } else {
          entries.push({ path: leafPath, value: current });
        }
      }
      collectLeaves(value, path);
      return;
    }
    if (!isRecord(value)) {
      blockedAncestors.push({ path, value });
      return;
    }
    if (segment === "*") {
      for (const key of Object.keys(value).sort()) {
        visit(value[key]!, [...path, key], index + 1);
      }
      return;
    }
    if (Object.hasOwn(value, segment)) {
      visit(value[segment]!, [...path, segment], index + 1);
    }
  }
  visit(root, [], 0);
  return { entries, blockedAncestors };
}

export function fieldSelectorMatchesPath(
  path: readonly string[],
  field: TranslationField,
): boolean {
  if (field.category === "chat-string") {
    return (
      path.length >= field.path.length &&
      field.path.every((segment, index) => path[index] === segment)
    );
  }
  const selector = field.path;
  const recursiveIndex = selector.indexOf("**");
  const fixedLength = recursiveIndex === -1 ? selector.length : recursiveIndex;
  if (
    (recursiveIndex === -1 && path.length !== selector.length) ||
    (recursiveIndex !== -1 && path.length < fixedLength)
  ) {
    return false;
  }
  for (let index = 0; index < fixedLength; index += 1) {
    const segment = selector[index]!;
    if (segment !== "*" && segment !== path[index]) return false;
  }
  return true;
}

function collectField(
  root: JsonValue | undefined,
  field: TranslationField,
  file: string,
  strictSource: boolean,
): {
  readonly values: ReadonlyMap<
    string,
    { path: readonly string[]; value: JsonValue }
  >;
  readonly issues: readonly ProjectFileIssue[];
} {
  const values = new Map<
    string,
    { path: readonly string[]; value: JsonValue }
  >();
  const issues: ProjectFileIssue[] = [];
  if (field.category === "chat-string") {
    const selected = valueAtPath(root, field.path);
    if (selected === undefined) {
      if (strictSource) {
        issues.push({
          file,
          code: "source.field-missing",
          reason: "声明的翻译字段不存在",
          path: field.path,
          expected: "已声明的字段",
          actual: { state: "missing" },
        });
      }
      return { values, issues };
    }
    const stringValues = new Map<
      string,
      { path: readonly string[]; value: JsonValue }
    >();
    walkStrings(
      selected,
      field.path,
      stringValues,
      file,
      issues as ProjectFileIssue[],
    );
    for (const [key, entry] of stringValues) values.set(key, entry);
    return { values, issues };
  }

  const selected = matchingEntries(root, field.path);
  if (strictSource) {
    for (const blocked of selected.blockedAncestors) {
      issues.push({
        file,
        code: "source.field-parent-not-map",
        reason: "已存在的声明字段祖先必须是映射",
        path: blocked.path,
        expected: "映射",
        actual: blocked.value,
      });
    }
  }
  if (
    selected.entries.length === 0 &&
    selected.blockedAncestors.length === 0 &&
    strictSource &&
    !field.path.some((part) => part === "*" || part === "**")
  ) {
    issues.push({
      file,
      code: "source.field-missing",
      reason: "声明的翻译字段不存在",
      path: field.path,
      expected: "已声明的字段",
      actual: { state: "missing" },
    });
  }
  for (const entry of selected.entries) {
    if (!isValidMessageValue(field.category, entry.value)) {
      issues.push({
        file,
        code: "message.type-mismatch",
        reason: fieldTypeReason(field.category),
        path: entry.path,
        expected: fieldTypeDescription(field.category),
        actual: entry.value,
      });
    }
    values.set(pathKey(entry.path), entry);
  }
  return { values, issues };
}

function asLocation(file: string, path: readonly string[]): DiagnosticLocation {
  return { file, path };
}

export function collectMessages(
  mappings: readonly SavedMapping[],
  targets: ReadonlyMap<string, JsonValue | undefined>,
  resources: readonly ResourceInventoryEntry[],
): MessageCollection {
  const messages: ObservedMessage[] = [];
  const targetMessages: TargetMessage[] = [];
  const issues: ProjectFileIssue[] = [];
  const resourcePurposes = new Map(
    resources.map((resource) => [resource.path, resource.purpose]),
  );
  for (const saved of mappings) {
    const targetRoot = targets.get(saved.mapping.target);
    const sourcePurpose = resourcePurposes.get(saved.mapping.source);
    for (const field of saved.mapping.fields) {
      const source = collectField(
        saved.sourceValue,
        field,
        saved.mapping.source,
        true,
      );
      const target =
        targetRoot === undefined
          ? {
              values: new Map<
                string,
                { path: readonly string[]; value: JsonValue }
              >(),
              issues: [],
            }
          : collectField(targetRoot, field, saved.mapping.target, false);
      issues.push(...source.issues, ...target.issues);
      const targetByPath = target.values;

      for (const [key, sourceEntry] of source.values) {
        const identity = messageIdentity(
          saved.mapping,
          sourceEntry.path,
          field,
          sourcePurpose,
        );
        const targetValue = inspectPath(targetRoot, sourceEntry.path);
        if (
          targetValue.status === "present" &&
          !isValidTargetValue(field.category, targetValue.value) &&
          !target.issues.some(
            (issue) =>
              issue.code === "message.type-mismatch" &&
              pathKey(issue.path.map(String)) === key,
          )
        ) {
          issues.push({
            file: saved.mapping.target,
            code: "message.type-mismatch",
            reason: fieldTypeReason(field.category),
            path: sourceEntry.path,
            expected: fieldTypeDescription(field.category),
            actual: targetValue.value,
          });
        }
        if (
          targetValue.status === "blocked" &&
          !target.issues.some(
            (issue) =>
              issue.code === "message.type-mismatch" &&
              pathKey(issue.path.map(String)) === pathKey(targetValue.path),
          )
        ) {
          issues.push({
            file: saved.mapping.target,
            code: "message.type-mismatch",
            reason: "受管理字段路径的祖先必须是映射",
            path: targetValue.path,
            expected: "映射",
            actual: targetValue.value,
          });
        }
        messages.push({
          ...identity,
          source: sourceEntry.value,
          target:
            targetValue.status === "present" ? targetValue.value : undefined,
          targetStatus: targetValue.status,
        });
      }

      const sourceKeys = new Set(source.values.keys());
      for (const [key, targetEntry] of targetByPath) {
        const identity = messageIdentity(
          saved.mapping,
          targetEntry.path,
          field,
          sourcePurpose,
        );
        targetMessages.push({
          ...identity,
          value: targetEntry.value,
        });
        if (!sourceKeys.has(key)) {
          issues.push({
            file: saved.mapping.target,
            code: "message.extra",
            reason: "目标文件包含原文中不存在的受管理字段",
            path: targetEntry.path,
            expected: { state: "absent" },
            actual: targetEntry.value,
          });
        }
      }
    }
  }

  const knownResources = new Set(resources.map((resource) => resource.path));
  for (const mapping of mappings) {
    if (!knownResources.has(mapping.mapping.source)) {
      issues.push({
        file: mapping.mapping.source,
        code: "mapping.invalid",
        reason: "映射原文不属于资源文件清单",
        path: [],
      });
    }
  }

  messages.sort((left, right) => compareText(left.id, right.id));
  targetMessages.sort((left, right) => compareText(left.id, right.id));
  issues.sort((left, right) =>
    compareText(
      `${left.file}:${canonicalJson(left.path)}:${left.code}`,
      `${right.file}:${canonicalJson(right.path)}:${right.code}`,
    ),
  );
  return { messages, targetMessages, issues };
}

export function collectTargetValues(
  mappings: readonly SavedMapping[],
  parsedTargets: ReadonlyMap<string, JsonValue | undefined>,
): ReadonlyMap<string, JsonValue | undefined> {
  const result = new Map<string, JsonValue | undefined>();
  for (const saved of mappings) {
    if (parsedTargets.has(saved.mapping.target)) {
      result.set(saved.mapping.target, parsedTargets.get(saved.mapping.target));
    }
  }
  return result;
}

export function messageTargetLocation(
  message: ObservedMessage,
): DiagnosticLocation {
  return asLocation(message.targetFile, message.path);
}
