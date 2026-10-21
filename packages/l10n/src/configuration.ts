import { LineCounter, parseDocument } from "yaml";
import { z } from "zod";

import type { ConsumerConfiguration, RuleConfiguration } from "#/model";
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
        mappings: z
          .array(
            z
              .object({
                source: safePathSchema,
                target: safePathSchema,
                fields: z
                  .array(
                    z
                      .object({
                        path: z.array(z.string().min(1)).min(1),
                        category: z.enum(["chat-string", "chat-string-list"]),
                      })
                      .strict(),
                  )
                  .min(1),
              })
              .strict(),
          )
          .min(1),
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
  configuration.translationScope.mappings.forEach((mapping, mappingIndex) => {
    const sourceIndex = resources.get(mapping.source);
    if (sourceIndex === undefined) {
      issues.push({
        code: "configuration.mapping-source-unlisted",
        path: ["translationScope", "mappings", mappingIndex, "source"],
        reason: "映射原文必须登记在资源清单中",
        actual: mapping.source,
      });
    } else if (
      configuration.resources[sourceIndex]?.purpose !== "chat-language"
    ) {
      issues.push({
        code: "configuration.mapping-source-purpose",
        path: ["translationScope", "mappings", mappingIndex, "source"],
        reason: "本票只支持登记为聊天语言的映射原文",
        actual: mapping.source,
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
    if (mapping.source === mapping.target) {
      issues.push({
        code: "configuration.mapping-path-conflict",
        path: ["translationScope", "mappings", mappingIndex],
        reason: "原文文件不能同时作为译文目标",
        actual: mapping.source,
      });
    }

    const fieldPaths = new Map<string, readonly string[]>();
    mapping.fields.forEach((field, fieldIndex) => {
      const key = canonicalJson(field.path);
      const duplicate = fieldPaths.get(key);
      const overlap = [...fieldPaths.values()].find(
        (prior) =>
          prior.every((part, index) => field.path[index] === part) ||
          field.path.every((part, index) => prior[index] === part),
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
      fieldPaths.set(key, field.path);
    });
  });

  for (const [
    mappingIndex,
    mapping,
  ] of configuration.translationScope.mappings.entries()) {
    if (sources.has(mapping.target)) {
      issues.push({
        code: "configuration.mapping-path-conflict",
        path: ["translationScope", "mappings", mappingIndex, "target"],
        reason: "映射目标不能覆盖任何受登记的原文文件",
        actual: mapping.target,
      });
    }
    if (
      mapping.target === "lands-l10n.yaml" ||
      mapping.target.startsWith("lands-l10n.yaml/") ||
      mapping.target === ".lands-l10n" ||
      mapping.target.startsWith(".lands-l10n/")
    ) {
      issues.push({
        code: "configuration.mapping-target-reserved",
        path: ["translationScope", "mappings", mappingIndex, "target"],
        reason: "映射目标不能覆盖维护清单或工具内部状态",
        actual: mapping.target,
      });
    }
    if (resources.has(mapping.target)) {
      issues.push({
        code: "configuration.mapping-path-conflict",
        path: ["translationScope", "mappings", mappingIndex, "target"],
        reason: "映射目标不能与资源文件清单中的文件冲突",
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
    translationScope: result.data.translationScope,
    ...(result.data.rules === undefined ? {} : { rules: normalizedRules }),
  };
  const semanticIssues = validateConfiguration(configuration);
  if (semanticIssues.length > 0) {
    return { ok: false, issues: semanticIssues };
  }

  return { ok: true, value: configuration };
}
