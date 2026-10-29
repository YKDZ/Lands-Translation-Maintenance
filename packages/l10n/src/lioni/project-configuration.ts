import { z } from "zod";

import {
  landsProjectFieldsSchema,
  validateConfiguration,
} from "#/configuration";
import type { LandsProjectConfiguration } from "#/lioni/lands-model";
import { parseYaml } from "#/yaml-data";

const projectManifestSchema = landsProjectFieldsSchema
  .extend({ format: z.literal("lands-l10n-project/v1") })
  .strict();

export type { LandsProjectConfiguration } from "#/lioni/lands-model";

/** 读取 Lioni 项目目录中的 Lands 资源与字段声明。 */
export function parseLandsProjectConfiguration(
  source: string,
  file: string,
): LandsProjectConfiguration {
  const yaml = parseYaml(source, file);
  if (!yaml.ok) {
    throw new Error(
      `${file} 项目声明无效：${yaml.issues.map(({ reason }) => reason).join("；")}`,
    );
  }

  const parsed = projectManifestSchema.safeParse(yaml.parsed.value);
  if (!parsed.success) {
    throw new Error(
      `${file} 项目声明不符合契约：${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("；")}`,
    );
  }

  const configuration: LandsProjectConfiguration = {
    resources: parsed.data.resources.map(({ path, purpose }) => ({
      path,
      purpose,
    })),
    translationScope: {
      sourceLanguage: parsed.data.translationScope.sourceLanguage,
      targetLanguage: parsed.data.translationScope.targetLanguage,
      mappings: parsed.data.translationScope.mappings.map((mapping) => ({
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
  };
  const issues = validateConfiguration(configuration);
  if (issues.length > 0) {
    throw new Error(
      `${file} 项目声明无效：${issues
        .map(({ path, reason }) => `${path.join(".")}: ${reason}`)
        .join("；")}`,
    );
  }
  return configuration;
}
