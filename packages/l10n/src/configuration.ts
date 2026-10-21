import { LineCounter, parseDocument } from "yaml";
import { z } from "zod";

import { sceneMatchesCategory } from "#/field-metadata";
import type { ConsumerConfiguration, RuleConfiguration } from "#/model";
import { translationFieldCategories, translationFieldScenes } from "#/model";
import { canonicalJson, compareText, sha256 } from "#/value";

const severitySchema = z.enum(["error", "warning", "info"]);
const safePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "必须是项目内的规范相对路径",
  );

const configurationSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z
      .object({
        version: z.string().trim().min(1),
        translationHistory: z.string().trim().min(1),
      })
      .strict(),
    resources: z
      .array(
        z
          .object({
            path: safePathSchema,
            purpose: z.enum([
              "chat-language",
              "gui-language",
              "dialog-language",
              "configuration",
              "metadata",
              "documentation",
              "bedrock-excluded",
              "other-excluded",
            ]),
          })
          .strict(),
      )
      .min(1),
    translationScope: z
      .object({
        sourceLanguage: z.string().trim().min(1),
        targetLanguage: z.string().trim().min(1),
        mappings: z.array(
          z
            .object({
              source: safePathSchema,
              target: safePathSchema,
              definitionsSource: safePathSchema.optional(),
              fields: z
                .array(
                  z
                    .object({
                      path: z.array(z.string().min(1)).min(1),
                      category: z.enum(translationFieldCategories),
                      scene: z.enum(translationFieldScenes).optional(),
                    })
                    .strict(),
                )
                .min(1),
            })
            .strict(),
        ),
      })
      .strict(),
    rules: z
      .record(
        z.string().min(1),
        z
          .object({
            enabled: z.boolean().optional(),
            severity: severitySchema.optional(),
            parameters: z.record(z.string(), z.json()).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export interface ConfigurationIssue {
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly reason: string;
  readonly actual: string;
}

export type ParsedConfiguration =
  | { readonly ok: true; readonly value: ConsumerConfiguration }
  | { readonly ok: false; readonly issues: readonly ConfigurationIssue[] };

export function validateConfiguration(
  configuration: ConsumerConfiguration,
): readonly ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  const resources = new Map<string, number>();
  configuration.resources.forEach((resource, index) => {
    const previous = resources.get(resource.path);
    if (previous !== undefined) {
      issues.push({
        code: "configuration.duplicate-resource",
        path: ["resources", index, "path"],
        reason: `资源路径与第 ${previous + 1} 项重复`,
        actual: resource.path,
      });
    } else {
      resources.set(resource.path, index);
    }
    if (resource.path.endsWith(".class")) {
      issues.push({
        code: "configuration.class-resource",
        path: ["resources", index, "path"],
        reason: "资源清单只登记非 .class 常规文件",
        actual: resource.path,
      });
    }
  });

  const sources = new Set<string>();
  const targets = new Set<string>();
  const definitionsSources = new Set<string>();
  configuration.translationScope.mappings.forEach((mapping, mappingIndex) => {
    const categories = new Set(mapping.fields.map((field) => field.category));
    const hasChatFields = [...categories].some((category) =>
      category.startsWith("chat-"),
    );
    const hasGuiFields = [...categories].some((category) =>
      category.startsWith("gui-"),
    );
    const hasConfigurationFields = [...categories].some((category) =>
      category.startsWith("configuration-"),
    );
    const hasDialogFields = [...categories].some((category) =>
      category.startsWith("dialog-"),
    );
    const guiFieldsAreDialogItems = mapping.fields
      .filter((field) => field.category.startsWith("gui-"))
      .every(
        (field) =>
          field.scene === "gui-item-name" || field.scene === "gui-item-lore",
      );
    const dialogUsesGuiItems = hasDialogFields && hasGuiFields;
    const allowedPurposes = hasChatFields
      ? new Set(["chat-language"])
      : hasConfigurationFields
        ? new Set(["configuration"])
        : hasDialogFields
          ? new Set(["dialog-language"])
          : hasGuiFields
            ? new Set(["gui-language"])
            : new Set(["configuration"]);
    const sourceIndex = resources.get(mapping.source);
    if (sourceIndex === undefined) {
      issues.push({
        code: "configuration.mapping-source-unlisted",
        path: ["translationScope", "mappings", mappingIndex, "source"],
        reason: "映射原文必须登记在资源清单中",
        actual: mapping.source,
      });
    } else if (
      !allowedPurposes.has(configuration.resources[sourceIndex]!.purpose)
    ) {
      issues.push({
        code: "configuration.mapping-source-purpose",
        path: ["translationScope", "mappings", mappingIndex, "source"],
        reason: hasChatFields
          ? "聊天字段映射原文必须登记为聊天语言资源"
          : hasDialogFields
            ? "对话框字段映射原文必须登记为对话框语言资源"
            : hasGuiFields
              ? "GUI 字段映射原文必须登记为 GUI 语言资源"
              : "此字段映射原文必须登记为配置资源",
        actual: mapping.source,
      });
    }
    if (
      (hasChatFields &&
        (hasGuiFields || hasDialogFields || hasConfigurationFields)) ||
      (hasConfigurationFields && (hasGuiFields || hasDialogFields)) ||
      (dialogUsesGuiItems && !guiFieldsAreDialogItems) ||
      (hasGuiFields && hasDialogFields && !dialogUsesGuiItems)
    ) {
      issues.push({
        code: "configuration.mapping-field-purpose",
        path: ["translationScope", "mappings", mappingIndex, "fields"],
        reason: "同一映射不能混用不同资源用途的字段分类",
        actual: mapping.source,
      });
    }
    const hasGuiLanguageFields = hasGuiFields && !hasDialogFields;
    const hasSelfStructureSource = hasConfigurationFields || hasDialogFields;
    if (hasGuiLanguageFields && mapping.definitionsSource === undefined) {
      issues.push({
        code: "configuration.mapping-definitions-missing",
        path: [
          "translationScope",
          "mappings",
          mappingIndex,
          "definitionsSource",
        ],
        reason: "GUI 语言映射必须关联同模块的 definitions_gui.yml",
        actual: mapping.source,
      });
    }
    if (
      hasSelfStructureSource &&
      mapping.definitionsSource !== mapping.source
    ) {
      issues.push({
        code: "configuration.mapping-definitions-missing",
        path: [
          "translationScope",
          "mappings",
          mappingIndex,
          "definitionsSource",
        ],
        reason: "混合语言或配置文件必须将自身登记为结构来源",
        actual: mapping.source,
      });
    }
    if (mapping.definitionsSource !== undefined) {
      const definitionsIndex = resources.get(mapping.definitionsSource);
      if (definitionsIndex === undefined) {
        issues.push({
          code: "configuration.mapping-definitions-unlisted",
          path: [
            "translationScope",
            "mappings",
            mappingIndex,
            "definitionsSource",
          ],
          reason: "结构定义必须登记在资源清单中",
          actual: mapping.definitionsSource,
        });
      } else if (
        mapping.definitionsSource === mapping.source &&
        hasSelfStructureSource
      ) {
        const expectedSelfPurpose = hasConfigurationFields
          ? "configuration"
          : "dialog-language";
        if (
          configuration.resources[definitionsIndex]?.purpose !==
          expectedSelfPurpose
        ) {
          issues.push({
            code: "configuration.mapping-definitions-purpose",
            path: [
              "translationScope",
              "mappings",
              mappingIndex,
              "definitionsSource",
            ],
            reason: "结构来源自身的资源用途必须与混合字段映射一致",
            actual: mapping.definitionsSource,
          });
        }
      } else if (
        configuration.resources[definitionsIndex]?.purpose !== "configuration"
      ) {
        issues.push({
          code: "configuration.mapping-definitions-purpose",
          path: [
            "translationScope",
            "mappings",
            mappingIndex,
            "definitionsSource",
          ],
          reason: "结构定义必须登记为配置资源",
          actual: mapping.definitionsSource,
        });
      }
      if (hasGuiLanguageFields) {
        const sourceDirectory = mapping.source.slice(
          0,
          mapping.source.lastIndexOf("/"),
        );
        const definitionsDirectory = mapping.definitionsSource.slice(
          0,
          mapping.definitionsSource.lastIndexOf("/"),
        );
        if (
          sourceDirectory !== definitionsDirectory ||
          mapping.definitionsSource.split("/").at(-1) !== "definitions_gui.yml"
        ) {
          issues.push({
            code: "configuration.mapping-definitions-module",
            path: [
              "translationScope",
              "mappings",
              mappingIndex,
              "definitionsSource",
            ],
            reason: "GUI 语言资源只能关联同模块目录下的 definitions_gui.yml",
            actual: mapping.definitionsSource,
          });
        }
      } else if (
        hasSelfStructureSource &&
        mapping.definitionsSource !== mapping.source
      ) {
        issues.push({
          code: "configuration.mapping-definitions-source",
          path: [
            "translationScope",
            "mappings",
            mappingIndex,
            "definitionsSource",
          ],
          reason: "混合配置字段的结构来源必须是映射原文文件自身",
          actual: mapping.definitionsSource,
        });
      }
      if (definitionsSources.has(mapping.definitionsSource)) {
        issues.push({
          code: "configuration.mapping-definitions-duplicate",
          path: [
            "translationScope",
            "mappings",
            mappingIndex,
            "definitionsSource",
          ],
          reason: "同一结构定义文件只能关联一次",
          actual: mapping.definitionsSource,
        });
      }
      definitionsSources.add(mapping.definitionsSource);
    }
    if (
      mapping.definitionsSource !== undefined &&
      !hasGuiLanguageFields &&
      !hasSelfStructureSource
    ) {
      issues.push({
        code: "configuration.mapping-definitions-unexpected",
        path: [
          "translationScope",
          "mappings",
          mappingIndex,
          "definitionsSource",
        ],
        reason: "仅 GUI 语言或混合配置映射可以声明结构来源",
        actual: mapping.definitionsSource,
      });
    }
    if (sources.has(mapping.source)) {
      issues.push({
        code: "configuration.mapping-source-duplicate",
        path: ["translationScope", "mappings", mappingIndex, "source"],
        reason: "同一原文文件只能声明一次映射",
        actual: mapping.source,
      });
    }
    sources.add(mapping.source);
    if (targets.has(mapping.target)) {
      issues.push({
        code: "configuration.mapping-target-duplicate",
        path: ["translationScope", "mappings", mappingIndex, "target"],
        reason: "目标文件只能由一条映射维护",
        actual: mapping.target,
      });
    }
    targets.add(mapping.target);

    const fieldPaths = new Map<string, readonly string[]>();
    mapping.fields.forEach((field, fieldIndex) => {
      const scene = field.scene;
      const isChatCategory = field.category.startsWith("chat-");
      if (
        (isChatCategory && scene !== undefined) ||
        (!isChatCategory && scene === undefined) ||
        (scene !== undefined && !sceneMatchesCategory(field.category, scene))
      ) {
        issues.push({
          code: "configuration.mapping-field-scene",
          path: [
            "translationScope",
            "mappings",
            mappingIndex,
            "fields",
            fieldIndex,
            "scene",
          ],
          reason: "翻译字段场景必须与字段分类匹配；聊天字段不声明场景",
          actual: scene ?? "未声明",
        });
      }
      const key = canonicalJson(field.path);
      const duplicate = fieldPaths.get(key);
      const overlap = [...fieldPaths.values()].find((prior) =>
        pathsMayOverlap(prior, field.path),
      );
      if (duplicate !== undefined || overlap !== undefined) {
        issues.push({
          code: "configuration.mapping-field-overlap",
          path: [
            "translationScope",
            "mappings",
            mappingIndex,
            "fields",
            fieldIndex,
            "path",
          ],
          reason: "翻译字段路径不能重复或相互包含",
          actual: field.path.join("."),
        });
      }
      const wildcards = field.path.filter(
        (part) => part === "*" || part === "**",
      );
      if (
        (wildcards.length > 0 && field.category.startsWith("chat-")) ||
        (field.path.includes("**") &&
          (field.path.at(-1) !== "**" || scene !== "gui-general"))
      ) {
        issues.push({
          code: "configuration.mapping-field-pattern",
          path: [
            "translationScope",
            "mappings",
            mappingIndex,
            "fields",
            fieldIndex,
            "path",
          ],
          reason:
            "路径通配符只用于明确的 GUI 或对话框场景；** 仅限通用 GUI 文本的末尾",
          actual: field.path.join("."),
        });
      }
      fieldPaths.set(key, field.path);
    });
  });

  for (const [
    mappingIndex,
    mapping,
  ] of configuration.translationScope.mappings.entries()) {
    if (mapping.target === ".l10n" || mapping.target.startsWith(".l10n/")) {
      issues.push({
        code: "configuration.mapping-target-reserved",
        path: ["translationScope", "mappings", mappingIndex, "target"],
        reason: "映射目标不能覆盖维护清单或工具内部状态",
        actual: mapping.target,
      });
    }
  }

  const targetPaths = [...targets];
  for (let index = 0; index < targetPaths.length; index += 1) {
    const path = targetPaths[index]!;
    const conflict = targetPaths.find(
      (other, otherIndex) =>
        otherIndex !== index && other.startsWith(`${path}/`),
    );
    if (conflict !== undefined) {
      issues.push({
        code: "configuration.mapping-target-overlap",
        path: ["translationScope", "mappings"],
        reason: "目标文件路径不能同时是另一个目标文件的父目录",
        actual: `${path} / ${conflict}`,
      });
    }
  }

  return issues;
}

function pathsMayOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index]!;
    const rightPart = right[index]!;
    if (leftPart === "**" || rightPart === "**") return true;
    if (leftPart !== rightPart && leftPart !== "*" && rightPart !== "*") {
      return false;
    }
  }
  return true;
}

export function syncConfigurationFingerprint(
  configuration: ConsumerConfiguration,
): string {
  const syncConfiguration = {
    schemaVersion: configuration.schemaVersion,
    source: configuration.source,
    resources: [...configuration.resources].sort((left, right) =>
      compareText(left.path, right.path),
    ),
    translationScope: {
      sourceLanguage: configuration.translationScope.sourceLanguage,
      targetLanguage: configuration.translationScope.targetLanguage,
      mappings: configuration.translationScope.mappings
        .map((mapping) => ({
          ...mapping,
          fields: [...mapping.fields].sort((left, right) =>
            compareText(canonicalJson(left.path), canonicalJson(right.path)),
          ),
        }))
        .sort((left, right) => compareText(left.source, right.source)),
    },
  };
  return sha256(canonicalJson(syncConfiguration));
}

export function parseConfiguration(source: string): ParsedConfiguration {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    uniqueKeys: true,
    prettyErrors: false,
    lineCounter,
    stringKeys: true,
  });
  if (document.errors.length > 0) {
    return {
      ok: false,
      issues: document.errors.map((error) => {
        const linePos = lineCounter.linePos(error.pos[0]);
        return {
          code:
            error.code === "DUPLICATE_KEY"
              ? "configuration.duplicate-key"
              : "configuration.yaml-invalid",
          path: [],
          reason: error.message,
          actual: linePos === null ? "YAML 文档无效" : `第 ${linePos.line} 行`,
        };
      }),
    };
  }

  let parsed: unknown;
  try {
    parsed = document.toJS({ mapAsMap: false, maxAliasCount: 0 });
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "configuration.yaml-invalid",
          path: [],
          reason: error instanceof Error ? error.message : String(error),
          actual: "YAML 文档无法转换为配置数据",
        },
      ],
    };
  }

  const result = configurationSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        code: "configuration.invalid",
        path: issue.path.filter(
          (part): part is string | number =>
            typeof part === "string" || typeof part === "number",
        ),
        reason: issue.message,
        actual: "配置值不符合契约",
      })),
    };
  }

  const normalizedRules: Record<string, RuleConfiguration> = {};
  for (const [id, settings] of Object.entries(result.data.rules ?? {})) {
    normalizedRules[id] = {
      ...(settings.enabled === undefined ? {} : { enabled: settings.enabled }),
      ...(settings.severity === undefined
        ? {}
        : { severity: settings.severity }),
      ...(settings.parameters === undefined
        ? {}
        : { parameters: settings.parameters }),
    };
  }
  const configuration: ConsumerConfiguration = {
    schemaVersion: result.data.schemaVersion,
    source: result.data.source,
    resources: result.data.resources,
    translationScope: {
      sourceLanguage: result.data.translationScope.sourceLanguage,
      targetLanguage: result.data.translationScope.targetLanguage,
      mappings: result.data.translationScope.mappings.map((mapping) => ({
        source: mapping.source,
        target: mapping.target,
        ...(mapping.definitionsSource === undefined
          ? {}
          : { definitionsSource: mapping.definitionsSource }),
        fields: mapping.fields.map((field) => ({
          path: field.path,
          category: field.category,
          ...(field.scene === undefined ? {} : { scene: field.scene }),
        })),
      })),
    },
    ...(result.data.rules === undefined ? {} : { rules: normalizedRules }),
  };
  const semanticIssues = validateConfiguration(configuration);
  if (semanticIssues.length > 0) {
    return { ok: false, issues: semanticIssues };
  }

  return { ok: true, value: configuration };
}
