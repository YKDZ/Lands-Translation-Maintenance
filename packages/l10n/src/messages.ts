import type {
  ChatFieldCategory,
  DiagnosticLocation,
  JsonValue,
  ObservedMessage,
  ProjectFileIssue,
  ResourceInventoryEntry,
  TargetMessage,
  TranslationField,
  TranslationMapping,
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

function messageIdentity(
  mapping: TranslationMapping,
  path: readonly string[],
  category: ChatFieldCategory,
) {
  const identity = {
    sourceFile: mapping.source,
    path,
  };
  return {
    ...identity,
    targetFile: mapping.target,
    category,
    id: sha256(canonicalJson(identity)),
  };
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

  if (field.category === "chat-string") {
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

  if (
    !Array.isArray(selected) ||
    !selected.every((item) => typeof item === "string")
  ) {
    issues.push({
      file,
      code: "message.type-mismatch",
      reason: "聊天列表字段必须是只含字符串的列表",
      path: field.path,
      expected: "字符串列表",
      actual: selected,
    });
    values.set(pathKey(field.path), {
      path: field.path,
      value: selected,
    });
    return { values, issues };
  }
  values.set(pathKey(field.path), { path: field.path, value: selected });
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
  for (const saved of mappings) {
    const targetRoot = targets.get(saved.mapping.target);
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
          field.category,
        );
        const targetEntry = targetByPath.get(key);
        messages.push({
          ...identity,
          source: sourceEntry.value,
          target: targetEntry?.value,
        });
      }

      const sourceKeys = new Set(source.values.keys());
      for (const [key, targetEntry] of targetByPath) {
        const identity = messageIdentity(
          saved.mapping,
          targetEntry.path,
          field.category,
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
