import { defineQualityCheck, type QualityFinding } from "@lioni/lioni";

import type { JsonValue } from "#/json-value";
import type {
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import {
  dependenciesOf,
  hasAvailableMiniMessageTranslation,
  miniMessageQualityConfigurationSchema,
  outcome,
  qualityBasis,
  type MiniMessageCheckInput,
  type MiniMessageQualityObject,
} from "#/minimessage-quality";
import { canonicalJson } from "#/value";

function isRecord(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structureBasis(input: MiniMessageCheckInput): JsonValue {
  const dependencies = dependenciesOf(input.dependencies);
  const source = input.sourceUnit?.unit;
  if (source?.context.role !== "structure") {
    return qualityBasis({ candidate: input.candidate, source: source ?? null });
  }
  const mapping = dependencies.landsProjection?.mappings.find(
    ({ definitionsSource, targetFile }) =>
      definitionsSource === source.context.sourceFile &&
      targetFile === source.context.targetFile,
  );
  const entry = mapping?.structures.find(
    ({ path }) => canonicalJson(path) === canonicalJson(source.context.path),
  );
  const association = input.facts.associations.find(
    ({ sourceKey, language }) =>
      sourceKey === input.candidate.sourceKey &&
      language === input.candidate.language,
  );
  return qualityBasis({
    candidate: input.candidate,
    source,
    association: association ?? null,
    mapping:
      mapping === undefined
        ? null
        : {
            sourceFile: mapping.sourceFile,
            targetFile: mapping.targetFile,
            definitionsSource: mapping.definitionsSource ?? null,
            fields: mapping.fields,
            enumeration: mapping.enumeration,
            error: mapping.error ?? null,
            entry: entry ?? null,
          },
  });
}

function issueForStructure(
  input: MiniMessageCheckInput,
  code: string,
  reason: string,
): {
  readonly code: string;
  readonly message: string;
  readonly object: MiniMessageQualityObject;
} {
  return {
    code,
    message: reason,
    object: {
      kind: "lands-structure",
      key: input.candidate.sourceKey,
      language: input.candidate.language,
    },
  };
}

function mismatchFinding(
  input: MiniMessageCheckInput,
  expected: JsonValue,
  actual: JsonValue,
  targetFile: string,
  path: readonly string[],
): QualityFinding<MiniMessageQualityObject> {
  const object: MiniMessageQualityObject = {
    kind: "lands-structure",
    key: input.candidate.sourceKey,
    language: input.candidate.language,
    code: "lands.structure-mismatch",
  };
  const location = {
    language: input.candidate.language,
    range: { file: targetFile, path },
  };
  return {
    severity: "error",
    object,
    location,
    message: "目标结构值与已登记的 Lands 定义不一致",
    evidence: [
      { role: "expected", object, location, value: expected },
      { role: "actual", object, location, value: actual },
    ],
  };
}

export const landsStructureConsistencyCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof miniMessageQualityConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "lands-structure-consistency",
  version: "1",
  configurationSchema: miniMessageQualityConfigurationSchema,
  configuration: {},
  fingerprintInput: structureBasis,
  check(input) {
    if (input.sourceUnit === null) {
      return outcome(
        "incomplete",
        [],
        [
          issueForStructure(
            input,
            "lands.structure-source-unavailable",
            "原生 QA 候选没有对应的 Lands 原文事实",
          ),
        ],
      );
    }
    const source = input.sourceUnit.unit;
    if (source.context.role !== "structure") {
      return outcome("not-applicable", [], []);
    }
    const association = input.facts.associations.find(
      ({ sourceKey, language }) =>
        sourceKey === input.candidate.sourceKey &&
        language === input.candidate.language,
    );
    if (association?.status === "missing") {
      // 缺失字段由漏译检查报告，避免结构职责重复给出同一缺失结论。
      return outcome("not-applicable", [], []);
    }
    if (association?.status !== "matched") {
      return outcome(
        "incomplete",
        [],
        [
          issueForStructure(
            input,
            "lands.structure-association-incomplete",
            "结构译文关联不完整，不能判断结构一致性",
          ),
        ],
      );
    }
    if (
      !hasAvailableMiniMessageTranslation(
        input,
        input.candidate.sourceKey,
        input.candidate.language,
      )
    ) {
      return outcome(
        "incomplete",
        [],
        [
          issueForStructure(
            input,
            "lands.structure-target-unavailable",
            "结构目标值不可用，不能判断结构一致性",
          ),
        ],
      );
    }

    const dependencies = dependenciesOf(input.dependencies);
    const projection = dependencies.landsProjection;
    if (projection === undefined) {
      return outcome(
        "incomplete",
        [],
        [
          issueForStructure(
            input,
            "lands.structure-projection-unavailable",
            "Lands 结构投影不可用，不能判断结构一致性",
          ),
        ],
      );
    }
    const mapping = projection.mappings.find(
      ({ definitionsSource, targetFile }) =>
        definitionsSource === source.context.sourceFile &&
        targetFile === source.context.targetFile,
    );
    if (mapping === undefined || mapping.enumeration !== "complete") {
      return outcome(
        "incomplete",
        [],
        [
          issueForStructure(
            input,
            "lands.structure-projection-incomplete",
            mapping?.error ?? "结构定义或目标资源读取不完整",
          ),
        ],
      );
    }
    const entry = mapping.structures.find(
      ({ path }) => canonicalJson(path) === canonicalJson(source.context.path),
    );
    if (entry === undefined || entry.actual.status !== "present") {
      return outcome(
        "incomplete",
        [],
        [
          issueForStructure(
            input,
            "lands.structure-value-unavailable",
            "已匹配的结构字段未能从实际目标资源唯一读取",
          ),
        ],
      );
    }
    if (canonicalJson(entry.expected) !== canonicalJson(source.source)) {
      return outcome(
        "incomplete",
        [],
        [
          issueForStructure(
            input,
            "lands.structure-source-changed",
            "QA 原文事实与本次读取的结构定义不一致",
          ),
        ],
      );
    }
    const openStructure =
      isRecord(entry.expected) &&
      Object.keys(entry.expected).length === 0 &&
      isRecord(entry.actual.value);
    if (
      openStructure ||
      canonicalJson(entry.expected) === canonicalJson(entry.actual.value)
    ) {
      return outcome("complete", [], []);
    }
    return outcome(
      "complete",
      [
        mismatchFinding(
          input,
          entry.expected,
          entry.actual.value,
          source.context.targetFile,
          source.context.path,
        ),
      ],
      [],
    );
  },
});
