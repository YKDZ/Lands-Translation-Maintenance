import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SourceRead, TranslationRead, SourceUnitFact } from "@lioni/lioni";
import { z } from "zod";

import { parseConfiguration } from "#/configuration";
import { formatForScene } from "#/field-metadata";
import {
  landsProjectPaths,
  type LandsProjectPaths,
} from "#/lioni/project-paths";
import {
  readLandsSourceSnapshot,
  type LandsSourceSnapshot,
} from "#/lioni/source-input";
import { formatForMessagePath } from "#/messages";
import type {
  ConsumerConfiguration,
  JsonValue,
  ResourcePurpose,
  TranslationField,
} from "#/model";
import {
  translationFieldCategories,
  translationFieldScenes,
  translationFormats,
} from "#/model";
import { canonicalJson, compareText } from "#/value";
import { parseYaml } from "#/yaml-data";

const lioniJsonSchema = z.json();
type LioniJson = z.infer<typeof lioniJsonSchema>;

const unitSchema = z
  .object({
    source: lioniJsonSchema,
    context: z
      .object({
        sourceFile: z.string(),
        targetFile: z.string(),
        path: z.array(z.string()),
        category: z.enum(translationFieldCategories),
        scene: z.enum(translationFieldScenes).optional(),
        format: z.enum(translationFormats).optional(),
        fieldPath: z.array(z.string()),
        sourceVersion: z.string(),
        jarSha256: z.string(),
        definitionsSource: z.string().optional(),
      })
      .strict(),
  })
  .strict();

const translationSchema = z
  .object({
    sourceFile: z.string(),
    targetFile: z.string(),
    path: z.array(z.string()),
    category: z.enum(translationFieldCategories),
    content: lioniJsonSchema,
  })
  .strict();

const unavailableTranslationSchema = z
  .object({
    sourceFile: z.string(),
    targetFile: z.string(),
    path: z.array(z.string()),
    category: z.enum(translationFieldCategories),
    raw: lioniJsonSchema,
  })
  .strict();

type LandsUnit = z.infer<typeof unitSchema>;
type LandsTranslation = z.infer<typeof translationSchema>;
type UnavailableTranslation = z.infer<typeof unavailableTranslationSchema>;

interface FieldEntry {
  readonly path: readonly string[];
  readonly value: JsonValue;
}

type PathValue =
  | { readonly status: "present"; readonly value: JsonValue }
  | { readonly status: "missing" }
  | {
      readonly status: "blocked";
      readonly path: readonly string[];
      readonly value: JsonValue;
    };

interface ReadResourceResult {
  readonly status: "available" | "missing" | "unavailable";
  readonly value?: JsonValue;
  readonly error?: string;
}

function isRecord(
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toLioniJson(value: JsonValue): LioniJson {
  if (isJsonArray(value)) return value.map(toLioniJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toLioniJson(entry)]),
    );
  }
  return value;
}

function readPath(root: JsonValue, path: readonly string[]): PathValue {
  let current = root;
  const walked: string[] = [];
  for (const segment of path) {
    if (!isRecord(current)) {
      return { status: "blocked", path: walked, value: current };
    }
    if (!Object.hasOwn(current, segment)) return { status: "missing" };
    current = current[segment]!;
    walked.push(segment);
  }
  return { status: "present", value: current };
}

function collectChatStrings(
  value: JsonValue,
  path: readonly string[],
  entries: FieldEntry[],
  issues: string[],
  file: string,
): void {
  if (typeof value === "string") {
    entries.push({ path, value });
    return;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value).sort(compareText)) {
      collectChatStrings(value[key]!, [...path, key], entries, issues, file);
    }
    return;
  }
  issues.push(`${file}:${path.join(".")} 不是字符串或字符串映射`);
  entries.push({ path, value });
}

function collectPatternEntries(
  root: JsonValue,
  pattern: readonly string[],
  file: string,
): {
  readonly entries: readonly FieldEntry[];
  readonly issues: readonly string[];
} {
  const entries: FieldEntry[] = [];
  const issues: string[] = [];

  function collectLeaves(value: JsonValue, path: readonly string[]): void {
    if (!isRecord(value)) {
      entries.push({ path, value });
      return;
    }
    for (const key of Object.keys(value).sort(compareText)) {
      collectLeaves(value[key]!, [...path, key]);
    }
  }

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
      collectLeaves(value, path);
      return;
    }
    if (!isRecord(value)) {
      issues.push(`${file}:${path.join(".")} 的字段祖先不是映射`);
      return;
    }
    if (segment === "*") {
      for (const key of Object.keys(value).sort(compareText)) {
        visit(value[key]!, [...path, key], index + 1);
      }
      return;
    }
    if (Object.hasOwn(value, segment)) {
      visit(value[segment]!, [...path, segment], index + 1);
    }
  }

  visit(root, [], 0);
  return { entries, issues };
}

function collectFieldEntries(
  root: JsonValue,
  field: TranslationField,
  file: string,
  strictSource: boolean,
): {
  readonly entries: readonly FieldEntry[];
  readonly issues: readonly string[];
} {
  const issues: string[] = [];
  if (field.category === "chat-string") {
    const selected = readPath(root, field.path);
    if (selected.status === "missing") {
      return {
        entries: [],
        issues: strictSource
          ? [`${file}:${field.path.join(".")} 声明的翻译字段缺失`]
          : [],
      };
    }
    if (selected.status === "blocked") {
      return {
        entries: [],
        issues: [`${file}:${selected.path.join(".")} 的字段祖先不是映射`],
      };
    }
    const entries: FieldEntry[] = [];
    collectChatStrings(selected.value, field.path, entries, issues, file);
    return { entries, issues };
  }

  const selected = collectPatternEntries(root, field.path, file);
  issues.push(...selected.issues);
  if (
    strictSource &&
    selected.entries.length === 0 &&
    selected.issues.length === 0 &&
    !field.path.some((part) => part === "*" || part === "**")
  ) {
    issues.push(`${file}:${field.path.join(".")} 声明的翻译字段缺失`);
  }
  return { entries: selected.entries, issues };
}

function validFieldValue(field: TranslationField, value: JsonValue): boolean {
  if (
    field.category === "chat-string" ||
    field.category === "gui-string" ||
    field.category === "dialog-string" ||
    field.category === "dialog-label-format" ||
    field.category === "configuration-string"
  ) {
    return typeof value === "string";
  }
  if (field.category === "gui-lore") {
    return (
      typeof value === "string" ||
      (Array.isArray(value) && value.every((item) => typeof item === "string"))
    );
  }
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function messageFormat(
  path: readonly string[],
  field: TranslationField,
  purpose: ResourcePurpose | undefined,
) {
  if (field.scene !== undefined) return formatForScene(field.scene);
  return formatForMessagePath(path, field.category, purpose);
}

function configurationFrom(
  source: string,
  file: string,
): ConsumerConfiguration {
  const parsed = parseConfiguration(source);
  if (!parsed.ok) {
    const details = parsed.issues
      .map(({ path, reason }) => `${path.join(".")}: ${reason}`)
      .join("；");
    throw new Error(`${file} 配置无效：${details}`);
  }
  return parsed.value;
}

async function readProjectInput(paths: LandsProjectPaths): Promise<{
  readonly configuration: ConsumerConfiguration;
  readonly snapshot: LandsSourceSnapshot;
}> {
  const [configurationText, snapshot] = await Promise.all([
    readFile(paths.legacyManifestFile, "utf8"),
    readLandsSourceSnapshot(paths.sourceDirectory),
  ]);
  return {
    configuration: configurationFrom(
      configurationText,
      paths.legacyManifestFile,
    ),
    snapshot,
  };
}

function parseResource(bytes: Uint8Array, path: string): ReadResourceResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    return {
      status: "unavailable",
      error: `${path} 不是有效 UTF-8：${errorText(error)}`,
    };
  }
  const parsed = parseYaml(text, path);
  if (!parsed.ok) {
    return {
      status: "unavailable",
      error: parsed.issues.map(({ reason }) => reason).join("；"),
    };
  }
  return { status: "available", value: parsed.parsed.value };
}

function fieldUnits(
  mapping: ConsumerConfiguration["translationScope"]["mappings"][number],
  root: JsonValue,
  sourceVersion: string,
  jarSha256: string,
  purpose: ResourcePurpose | undefined,
): {
  readonly records: readonly {
    readonly value: LandsUnit;
    readonly bodyAvailability: "available" | "unavailable";
  }[];
  readonly issues: readonly string[];
} {
  const byKey = new Map<
    string,
    {
      readonly value: LandsUnit;
      readonly bodyAvailability: "available" | "unavailable";
    }
  >();
  const issues: string[] = [];

  for (const field of mapping.fields) {
    const selected = collectFieldEntries(root, field, mapping.source, true);
    issues.push(...selected.issues);
    for (const entry of selected.entries) {
      const format = messageFormat(entry.path, field, purpose);
      const context = {
        sourceFile: mapping.source,
        targetFile: mapping.target,
        path: [...entry.path],
        category: field.category,
        ...(field.scene === undefined ? {} : { scene: field.scene }),
        ...(format === undefined ? {} : { format }),
        fieldPath: [...field.path],
        sourceVersion,
        jarSha256,
        ...(mapping.definitionsSource === undefined
          ? {}
          : { definitionsSource: mapping.definitionsSource }),
      };
      const unit: LandsUnit = { source: toLioniJson(entry.value), context };
      const key = `${mapping.source}:${canonicalJson(entry.path)}`;
      if (byKey.has(key)) {
        issues.push(
          `${mapping.source}:${canonicalJson(entry.path)} 被多个字段约定选中`,
        );
        continue;
      }
      byKey.set(key, {
        value: unit,
        bodyAvailability: validFieldValue(field, entry.value)
          ? "available"
          : "unavailable",
      });
      if (!validFieldValue(field, entry.value)) {
        issues.push(
          `${mapping.source}:${entry.path.join(".")} 不符合 ${field.category} 类型`,
        );
      }
    }
  }

  return {
    records: [...byKey.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, record]) => record),
    issues,
  };
}

function sourceRange(
  path: string,
  purpose: string,
  sourceVersion: string,
  jarSha256: string,
) {
  return {
    kind: "lands-resource",
    path,
    purpose,
    sourceVersion,
    jarSha256,
  };
}

async function readSource(
  paths: LandsProjectPaths,
): Promise<SourceRead<LandsUnit>> {
  let configuration: ConsumerConfiguration;
  let snapshot: LandsSourceSnapshot;
  try {
    ({ configuration, snapshot } = await readProjectInput(paths));
  } catch (error) {
    return {
      scopes: [
        {
          range: { kind: "lands-source-input", path: paths.sourceDirectory },
          enumeration: "failed",
          records: [],
          error: errorText(error),
        },
      ],
    };
  }

  const resourcePurposes = new Map(
    configuration.resources.map(({ path, purpose }) => [path, purpose]),
  );
  const mappingsBySource = new Map<
    string,
    ConsumerConfiguration["translationScope"]["mappings"][number][]
  >();
  for (const mapping of configuration.translationScope.mappings) {
    const mappings = mappingsBySource.get(mapping.source) ?? [];
    mappings.push(mapping);
    mappingsBySource.set(mapping.source, mappings);
  }

  const resourcePaths = new Set([
    ...configuration.resources.map(({ path }) => path),
    ...snapshot.resources.keys(),
  ]);
  const scopes: SourceRead<LandsUnit>["scopes"][number][] = [];
  for (const path of [...resourcePaths].sort(compareText)) {
    const registeredPurpose = resourcePurposes.get(path);
    const purpose = registeredPurpose ?? "unregistered";
    const range = sourceRange(
      path,
      purpose,
      snapshot.manifest.sourceVersion,
      snapshot.manifest.jarSha256,
    );
    const bytes = snapshot.resources.get(path);
    if (bytes === undefined) {
      scopes.push({
        range,
        enumeration: "failed",
        records: [],
        error: "已登记资源在保存的 JAR 来源中缺失",
      });
      continue;
    }

    const mappings = mappingsBySource.get(path) ?? [];
    if (mappings.length === 0) {
      scopes.push({ range, enumeration: "complete", records: [] });
      continue;
    }

    const parsed = parseResource(bytes, path);
    if (parsed.status !== "available") {
      scopes.push({
        range,
        enumeration: "failed",
        records: [],
        error: parsed.error ?? `${path} 无法读取`,
      });
      continue;
    }

    const records: SourceRead<LandsUnit>["scopes"][number]["records"][number][] =
      [];
    const issues: string[] = [];
    for (const mapping of mappings) {
      const collected = fieldUnits(
        mapping,
        parsed.value!,
        snapshot.manifest.sourceVersion,
        snapshot.manifest.jarSha256,
        registeredPurpose,
      );
      issues.push(...collected.issues);
      records.push(...collected.records);
    }
    scopes.push({
      range,
      enumeration: issues.length === 0 ? "complete" : "partial",
      records,
      ...(issues.length === 0 ? {} : { error: issues.join("；") }),
    });
  }

  return { scopes };
}

function fieldPaths(
  mapping: ConsumerConfiguration["translationScope"]["mappings"][number],
  definitions: JsonValue,
): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const field of mapping.fields) {
    for (const entry of collectFieldEntries(
      definitions,
      field,
      mapping.definitionsSource ?? mapping.source,
      false,
    ).entries) {
      paths.add(canonicalJson(entry.path));
    }
  }
  return paths;
}

function structureEntries(
  definitions: JsonValue,
  target: JsonValue | undefined,
  translatedPaths: ReadonlySet<string>,
) {
  const entries: {
    readonly path: readonly string[];
    readonly expected: JsonValue;
    readonly actual: PathValue;
  }[] = [];

  function visit(value: JsonValue, path: readonly string[]): void {
    if (translatedPaths.has(canonicalJson(path))) return;
    if (isRecord(value) && Object.keys(value).length > 0) {
      for (const key of Object.keys(value).sort(compareText)) {
        visit(value[key]!, [...path, key]);
      }
      return;
    }
    const actual =
      target === undefined
        ? { status: "missing" as const }
        : readPath(target, path);
    entries.push({ path, expected: value, actual });
  }

  visit(definitions, []);
  return entries;
}

async function readTargetResource(
  projectDirectory: string,
  path: string,
): Promise<ReadResourceResult> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(join(projectDirectory, path));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { status: "missing" };
    }
    return { status: "unavailable", error: errorText(error) };
  }
  return parseResource(bytes, path);
}

async function readTranslations(
  paths: LandsProjectPaths,
  language: string,
  sourceUnits: readonly SourceUnitFact<LandsUnit>[],
): Promise<TranslationRead<LandsTranslation, UnavailableTranslation>> {
  let configuration: ConsumerConfiguration;
  let snapshot: LandsSourceSnapshot;
  try {
    ({ configuration, snapshot } = await readProjectInput(paths));
  } catch (error) {
    return {
      scopes: configurationFallbackScopes(sourceUnits, errorText(error)),
    };
  }

  if (language !== configuration.translationScope.targetLanguage) {
    return {
      scopes: configuration.translationScope.mappings.map((mapping) => ({
        range: {
          kind: "lands-target-resource",
          sourceFile: mapping.source,
          targetFile: mapping.target,
        },
        covers: sourceUnits
          .filter(({ unit }) => unit.context.sourceFile === mapping.source)
          .map(({ key }) => key),
        enumeration: "failed",
        records: [],
        error: `当前资料配置目标语言为 ${configuration.translationScope.targetLanguage}`,
      })),
    };
  }

  const targetScopes: TranslationRead<
    LandsTranslation,
    UnavailableTranslation
  >["scopes"][number][] = [];
  for (const mapping of configuration.translationScope.mappings) {
    const mappedUnits = sourceUnits.filter(
      ({ unit }) =>
        unit.context.sourceFile === mapping.source &&
        unit.context.targetFile === mapping.target,
    );
    const covers = mappedUnits.map(({ key }) => key).sort(compareText);
    const target = await readTargetResource(
      paths.projectDirectory,
      mapping.target,
    );
    const targetRoot = target.status === "available" ? target.value : undefined;
    const records: TranslationRead<
      LandsTranslation,
      UnavailableTranslation
    >["scopes"][number]["records"][number][] = [];
    const issues: string[] = [];

    if (target.status === "available") {
      const selectedTargets = new Map<string, FieldEntry>();
      for (const field of mapping.fields) {
        const selected = collectFieldEntries(
          target.value!,
          field,
          mapping.target,
          false,
        );
        issues.push(...selected.issues);
        for (const entry of selected.entries) {
          const key = canonicalJson(entry.path);
          if (selectedTargets.has(key)) {
            issues.push(
              `${mapping.target}:${entry.path.join(".")} 被多个字段约定选中`,
            );
            continue;
          }
          selectedTargets.set(key, entry);
        }
      }

      for (const entry of [...selectedTargets.values()].sort((left, right) =>
        compareText(canonicalJson(left.path), canonicalJson(right.path)),
      )) {
        const field = mapping.fields.find((candidate) =>
          collectFieldEntries(
            target.value!,
            candidate,
            mapping.target,
            false,
          ).entries.some(
            (selected) =>
              canonicalJson(selected.path) === canonicalJson(entry.path),
          ),
        );
        if (field === undefined) continue;
        const record = {
          sourceFile: mapping.source,
          targetFile: mapping.target,
          path: [...entry.path],
          category: field.category,
        };
        if (validFieldValue(field, entry.value)) {
          records.push({
            value: { ...record, content: toLioniJson(entry.value) },
            bodyAvailability: "available",
          });
        } else {
          records.push({
            value: { ...record, raw: toLioniJson(entry.value) },
            bodyAvailability: "unavailable",
          });
        }
      }
    }

    const definitionsSource = mapping.definitionsSource;
    let definitions: JsonValue | undefined;
    if (definitionsSource !== undefined) {
      const definitionBytes = snapshot.resources.get(definitionsSource);
      if (definitionBytes === undefined) {
        issues.push(`${definitionsSource} 已登记为结构来源，但离线来源中缺失`);
      } else {
        const parsedDefinitions = parseResource(
          definitionBytes,
          definitionsSource,
        );
        if (parsedDefinitions.status === "available") {
          definitions = parsedDefinitions.value;
        } else {
          issues.push(
            parsedDefinitions.error ?? `${definitionsSource} 无法读取`,
          );
        }
      }
    }

    const selectedPaths = new Set(
      mappedUnits.map(({ unit }) => canonicalJson(unit.context.path)),
    );
    if (definitions !== undefined) {
      for (const path of fieldPaths(mapping, definitions))
        selectedPaths.add(path);
    }
    const structures =
      definitions === undefined
        ? []
        : structureEntries(definitions, targetRoot, selectedPaths);

    targetScopes.push({
      range: {
        kind: "lands-target-resource",
        sourceFile: mapping.source,
        targetFile: mapping.target,
        targetStatus: target.status,
        ...(target.error === undefined ? {} : { targetError: target.error }),
        ...(definitionsSource === undefined ? {} : { definitionsSource }),
        fields: mapping.fields,
        structures,
        sourceVersion: snapshot.manifest.sourceVersion,
      },
      covers,
      enumeration:
        target.status === "unavailable"
          ? "failed"
          : issues.length === 0
            ? "complete"
            : "partial",
      records,
      ...(target.status === "unavailable"
        ? { error: target.error }
        : issues.length === 0
          ? {}
          : { error: issues.join("；") }),
    });
  }

  return { scopes: targetScopes };
}

function configurationFallbackScopes(
  sourceUnits: readonly SourceUnitFact<LandsUnit>[],
  error: string,
) {
  const byMapping = new Map<string, string[]>();
  for (const sourceUnit of sourceUnits) {
    const mapping = `${sourceUnit.unit.context.sourceFile}\u0000${sourceUnit.unit.context.targetFile}`;
    const keys = byMapping.get(mapping) ?? [];
    keys.push(sourceUnit.key);
    byMapping.set(mapping, keys);
  }
  return [...byMapping.entries()].map(([mapping, covers]) => {
    const [sourceFile, targetFile] = mapping.split("\u0000");
    return {
      range: { kind: "lands-target-resource", sourceFile, targetFile },
      covers,
      enumeration: "failed" as const,
      records: [],
      error,
    };
  });
}

export function landsFactAdapters(entryUrl: string | URL) {
  const paths = landsProjectPaths(entryUrl);
  return {
    source: {
      schema: unitSchema,
      read: () => readSource(paths),
    },
    keyOf: (unit: LandsUnit) =>
      `${unit.context.sourceFile}:${canonicalJson(unit.context.path)}`,
    translations: {
      languages: ["zh-CN"],
      schema: translationSchema,
      unavailableSchema: unavailableTranslationSchema,
      contentSchema: z.json(),
      contentOf: (translation: LandsTranslation) => translation.content,
      keyOf: (translation: LandsTranslation | UnavailableTranslation) => ({
        namespace: translation.targetFile,
        key: canonicalJson(translation.path),
      }),
      matches: (
        unit: LandsUnit,
        translation: LandsTranslation | UnavailableTranslation,
      ) =>
        unit.context.sourceFile === translation.sourceFile &&
        canonicalJson(unit.context.path) === canonicalJson(translation.path),
      read: (
        language: string,
        sourceUnits: readonly SourceUnitFact<LandsUnit>[],
      ) => readTranslations(paths, language, sourceUnits),
    },
  };
}

export { landsProjectPaths } from "#/lioni/project-paths";
