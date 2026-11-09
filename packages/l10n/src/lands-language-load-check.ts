import { defineQualityCheck } from "@lioni/lioni";

import type { JsonValue } from "#/json-value";
import type {
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import {
  dependenciesOf,
  miniMessageQualityConfigurationSchema,
  outcome,
  qualityBasis,
  type MiniMessageCheckInput,
  type MiniMessageQualityObject,
} from "#/minimessage-quality";

function selected(input: MiniMessageCheckInput): boolean {
  return input.candidate.sourceKey === input.facts.source.units[0]?.key;
}

/**
 * 原生 QA 按候选调度，借首个原文单元执行一次整资源检查，避免无正文空壳被遗漏。
 * 诊断定位真实文件节点；例外依据覆盖完整资源及其读取状态，不借用宿主消息正文。
 * 固定行为来自 Lands 9.1.1 的语言清理、GUI 物品分类和槽位解析实现。
 */
export const landsLanguageLoadCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof miniMessageQualityConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "lands-language-load",
  version: "lands-language-load-v2",
  configurationSchema: miniMessageQualityConfigurationSchema,
  configuration: {},
  fingerprintInput(input) {
    if (!selected(input)) return { selected: false };
    const dependencies = dependenciesOf(input.dependencies);
    return qualityBasis({
      resources:
        dependencies.landsProjection?.mappings.map(
          (mapping) => mapping.languageLoad ?? null,
        ) ?? null,
      issues: dependencies.readIssues,
    });
  },
  check(input) {
    if (!selected(input)) return outcome("not-applicable", [], []);
    const dependencies = dependenciesOf(input.dependencies);
    const analysis = dependencies.languageLoad;
    if (analysis === undefined)
      return outcome(
        "incomplete",
        [],
        [
          {
            code: "lands.language.projection-unavailable",
            message: "语言加载检查缺少完整资源投影",
          },
        ],
      );
    return outcome(
      analysis.issues.length === 0 ? "complete" : "incomplete",
      analysis.findings.map((finding) => {
        const object: MiniMessageQualityObject = {
          kind: "lands-language-resource",
          key: finding.file + ":" + JSON.stringify(finding.path),
          language: input.candidate.language,
          code: "lands.language." + finding.code,
        };
        const location = {
          language: input.candidate.language,
          range: { file: finding.file, path: finding.path },
        };
        return {
          severity: "error" as const,
          object,
          location,
          message: finding.message,
          evidence: [
            {
              role: "expected",
              object,
              location,
              value: { state: "compatible with Lands 9.1.1 language loading" },
            },
            {
              role: "actual",
              object,
              location,
              value: finding.actual as JsonValue,
            },
          ],
        };
      }),
      analysis.issues.map((issue) => ({
        code: "lands.language.resource-unavailable",
        message: issue.file + ": " + issue.reason,
      })),
    );
  },
});
