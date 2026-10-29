import {
  defaultUpdatePolicy,
  type ActualTranslationFact,
  type SourceUnitFact,
  type TranslationIdentity,
  type TranslationWriteRequest,
  type UpdatePlanInput,
  type UpdatePlanItem,
} from "@lioni/lioni";

import type {
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import { canonicalJson, compareText } from "#/value";

type LandsBody = LandsJson;
type LandsUpdateInput = UpdatePlanInput<
  LandsUnit,
  LandsTranslation,
  LandsBody,
  UnavailableTranslation
>;
type LandsPlanItem = UpdatePlanItem<
  LandsUnit,
  LandsTranslation,
  LandsBody,
  UnavailableTranslation
>;
type AvailableTranslation = Extract<
  ActualTranslationFact<LandsTranslation, LandsBody, UnavailableTranslation>,
  { readonly bodyAvailability: "available" }
>;

type StructureMerge =
  | { readonly status: "ready"; readonly content: LandsJson }
  | { readonly status: "review"; readonly reason: string };

type StructureRemoval =
  | { readonly status: "remaining"; readonly content: LandsJson }
  | { readonly status: "removed" }
  | { readonly status: "review"; readonly reason: string };

function isRecord(
  value: LandsJson | undefined,
): value is { readonly [key: string]: LandsJson } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonType(value: LandsJson): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value;
}

function sameJson(left: LandsJson, right: LandsJson): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameIdentity(
  left: TranslationIdentity,
  right: TranslationIdentity,
): boolean {
  return (
    left.language === right.language &&
    left.namespace === right.namespace &&
    left.key === right.key
  );
}

function rangeForSource(
  scopes: readonly { readonly range: unknown }[],
  source: SourceUnitFact<LandsUnit>,
): LandsJson | undefined {
  return scopes[source.scopeIndex]?.range as LandsJson | undefined;
}

function currentRangeForRemovedSource(
  input: LandsUpdateInput,
  previous: SourceUnitFact<LandsUnit>,
): LandsJson | undefined {
  const previousRange = rangeForSource(
    input.previous?.source.read.scopes ?? [],
    previous,
  );
  if (previousRange === undefined) return undefined;
  return input.current.source.read.scopes.find(
    ({ enumeration, range }) =>
      enumeration === "complete" &&
      canonicalJson(range as LandsJson) === canonicalJson(previousRange),
  )?.range as LandsJson | undefined;
}

function completeCurrentTarget(
  input: LandsUpdateInput,
  language: string,
  target: AvailableTranslation,
): boolean {
  const read = input.current.translations.reads.find(
    (candidate) => candidate.language === language,
  );
  return (
    read?.status === "complete" &&
    read.scopes[target.scopeIndex]?.enumeration === "complete"
  );
}

function currentTranslationForItem(
  input: LandsUpdateInput,
  item: LandsPlanItem,
): AvailableTranslation | undefined {
  if (item.target === undefined) return undefined;
  const matches = input.current.translations.records.filter((record) =>
    sameIdentity(record.identity, item.target!),
  );
  if (matches.length !== 1 || matches[0]?.bodyAvailability !== "available") {
    return undefined;
  }
  return matches[0];
}

function planItemBase(
  item: LandsPlanItem,
  target: TranslationIdentity,
  sourceKey = item.sourceKey,
) {
  return {
    ...(sourceKey === undefined ? {} : { sourceKey }),
    language: item.language,
    target,
    changes: item.changes,
  };
}

function writeExistingItem(
  item: LandsPlanItem,
  target: AvailableTranslation,
  content: LandsJson,
  expectedSource:
    | {
        readonly presence: "present";
        readonly key: string;
        readonly unit: LandsUnit;
        readonly content: LandsJson;
        readonly range: LandsJson;
      }
    | {
        readonly presence: "absent";
        readonly key: string;
        readonly range: LandsJson;
      },
  reason: string,
): LandsPlanItem {
  const request = {
    operation: "write",
    target: { identity: target.identity },
    content,
    expectedSource,
    expectedTarget: {
      status: "present",
      identity: target.identity,
      content: target.content,
      range: target.range as LandsJson,
      record: target.translation,
    },
  } satisfies Extract<
    TranslationWriteRequest<LandsBody, LandsUnit>,
    { readonly operation: "write" }
  >;
  return {
    ...planItemBase(item, target.identity, expectedSource.key),
    action: "write",
    after: { content },
    request,
    reason,
  };
}

function deleteExistingItem(
  item: LandsPlanItem,
  previousSource: SourceUnitFact<LandsUnit>,
  target: AvailableTranslation,
  currentSourceRange: LandsJson,
  reason: string,
): LandsPlanItem {
  const request = {
    operation: "delete",
    target: { identity: target.identity },
    expectedSource: {
      presence: "absent",
      key: previousSource.key,
      range: currentSourceRange,
    },
    expectedTarget: {
      status: "present",
      identity: target.identity,
      content: target.content,
      range: target.range as LandsJson,
      record: target.translation,
    },
  } satisfies Extract<
    TranslationWriteRequest<LandsBody, LandsUnit>,
    { readonly operation: "delete" }
  >;
  return {
    ...planItemBase(item, target.identity, previousSource.key),
    action: "delete",
    request,
    reason,
  };
}

function retainExistingItem(
  item: LandsPlanItem,
  target: AvailableTranslation,
  reason: string,
): LandsPlanItem {
  return {
    ...planItemBase(item, target.identity),
    action: "retain",
    reason,
  };
}

function reviewExistingItem(
  item: LandsPlanItem,
  target: AvailableTranslation,
  reason: string,
): LandsPlanItem {
  return {
    ...planItemBase(item, target.identity),
    action: "review",
    reason,
  };
}

function mergeCurrentStructure(
  current: LandsJson,
  actual: LandsJson | undefined,
  previous: LandsJson | undefined,
  path: readonly string[],
): StructureMerge {
  if (actual === undefined) return { status: "ready", content: current };

  if (
    previous !== undefined &&
    jsonType(previous) !== jsonType(current) &&
    !sameJson(actual, previous) &&
    !sameJson(actual, current)
  ) {
    return {
      status: "review",
      reason: `${path.join(".")} 的目标类型变化与上次来源不符，无法安全替换。`,
    };
  }

  if (!isRecord(current) || !isRecord(actual)) {
    if (jsonType(current) !== jsonType(actual)) {
      if (previous !== undefined && sameJson(actual, previous)) {
        return { status: "ready", content: current };
      }
      return {
        status: "review",
        reason: `${path.join(".")} 的目标类型与当前结构不一致，无法安全覆盖。`,
      };
    }
    return { status: "ready", content: current };
  }

  const previousRecord = isRecord(previous) ? previous : undefined;
  const merged: Record<string, LandsJson> = {};
  const keys = new Set([
    ...Object.keys(current),
    ...Object.keys(actual),
    ...Object.keys(previousRecord ?? {}),
  ]);
  for (const key of [...keys].sort(compareText)) {
    const currentHas = Object.hasOwn(current, key);
    const actualHas = Object.hasOwn(actual, key);
    const previousHas =
      previousRecord !== undefined && Object.hasOwn(previousRecord, key);
    const fieldPath = [...path, key];

    if (currentHas) {
      const child = mergeCurrentStructure(
        current[key]!,
        actualHas ? actual[key] : undefined,
        previousHas ? previousRecord![key] : undefined,
        fieldPath,
      );
      if (child.status === "review") return child;
      merged[key] = child.content;
      continue;
    }

    if (!actualHas) continue;
    if (!previousHas) {
      merged[key] = actual[key]!;
      continue;
    }

    const removed = removeManagedStructure(
      previousRecord![key]!,
      actual[key]!,
      fieldPath,
    );
    if (removed.status === "review") return removed;
    if (removed.status === "remaining") merged[key] = removed.content;
  }
  return { status: "ready", content: merged };
}

function removeManagedStructure(
  previous: LandsJson,
  actual: LandsJson,
  path: readonly string[],
): StructureRemoval {
  if (jsonType(previous) !== jsonType(actual)) {
    return {
      status: "review",
      reason: `${path.join(".")} 的目标类型已偏离上次结构，不能确认删除范围。`,
    };
  }
  if (!isRecord(previous) || !isRecord(actual)) return { status: "removed" };

  const remaining: Record<string, LandsJson> = {};
  for (const key of Object.keys(actual).sort(compareText)) {
    if (!Object.hasOwn(previous, key)) {
      remaining[key] = actual[key]!;
      continue;
    }
    const child = removeManagedStructure(previous[key]!, actual[key]!, [
      ...path,
      key,
    ]);
    if (child.status === "review") return child;
    if (child.status === "remaining") remaining[key] = child.content;
  }
  return Object.keys(remaining).length === 0
    ? { status: "removed" }
    : { status: "remaining", content: remaining };
}

function sourceChangeForItem(item: LandsPlanItem) {
  return item.changes.source;
}

function currentStructureDecision(
  input: LandsUpdateInput,
  item: LandsPlanItem,
): LandsPlanItem | undefined {
  if (item.sourceKey === undefined) return undefined;
  const source = input.current.source.units.find(
    (candidate) => candidate.key === item.sourceKey,
  );
  if (source?.unit.context.role !== "structure") return undefined;
  const association = input.associations.current.find(
    (candidate) =>
      candidate.sourceKey === source.key &&
      candidate.language === item.language,
  );
  if (
    association?.status !== "matched" ||
    association.translationIndexes.length !== 1
  ) {
    return undefined;
  }
  const target =
    input.current.translations.records[association.translationIndexes[0]!];
  if (
    target?.bodyAvailability !== "available" ||
    target.translation.role !== "structure" ||
    !completeCurrentTarget(input, item.language, target)
  ) {
    return undefined;
  }
  const sourceRange = rangeForSource(input.current.source.read.scopes, source);
  const sourceScope = input.current.source.read.scopes[source.scopeIndex];
  if (sourceScope?.enumeration !== "complete" || sourceRange === undefined) {
    return undefined;
  }
  const previous = input.previous?.source.units.find(
    (candidate) => candidate.key === source.key,
  );
  const merged = mergeCurrentStructure(
    source.unit.source,
    target.content,
    previous?.unit.source,
    source.unit.context.path,
  );
  if (merged.status === "review") {
    return reviewExistingItem(item, target, merged.reason);
  }
  if (sameJson(merged.content, target.content)) {
    return retainExistingItem(
      item,
      target,
      "当前结构字段已符合来源；保留目标及其中的自定义字段。",
    );
  }
  return writeExistingItem(
    item,
    target,
    merged.content,
    {
      presence: "present",
      key: source.key,
      unit: source.unit,
      content: source.unit.source,
      range: sourceRange,
    },
    "按当前定义更新结构字段，并保留来源中未管理的目标字段。",
  );
}

function historicalRemovalEvidence(
  input: LandsUpdateInput,
  item: LandsPlanItem,
  previousSource: SourceUnitFact<LandsUnit>,
  target: AvailableTranslation,
): LandsJson | undefined {
  if (item.changes.source?.status !== "removed") return undefined;
  const currentSourceRange = currentRangeForRemovedSource(
    input,
    previousSource,
  );
  if (currentSourceRange === undefined) return undefined;

  const previous = input.previous;
  if (previous === undefined) return undefined;
  const previousOwners = input.associations.previous.filter(
    ({ translationIndexes }) =>
      translationIndexes.some(
        (index) =>
          previous.translations.records[index] !== undefined &&
          sameIdentity(
            previous.translations.records[index]!.identity,
            target.identity,
          ),
      ),
  );
  if (
    previousOwners.length !== 1 ||
    previousOwners[0]?.sourceKey !== previousSource.key ||
    previousOwners[0]?.language !== item.language ||
    previousOwners[0]?.status !== "matched" ||
    previousOwners[0]?.translationIndexes.length !== 1
  ) {
    return undefined;
  }

  const historicalCurrentAssociations =
    input.associations.currentFromPrevious?.filter(
      ({ sourceKey, language }) =>
        sourceKey === previousSource.key && language === item.language,
    ) ?? [];
  if (
    historicalCurrentAssociations.length !== 1 ||
    historicalCurrentAssociations[0]?.status !== "matched" ||
    historicalCurrentAssociations[0]?.translationIndexes.length !== 1 ||
    !historicalCurrentAssociations[0].translationIndexes.some((index) =>
      sameIdentity(
        input.current.translations.records[index]!.identity,
        target.identity,
      ),
    )
  ) {
    return undefined;
  }

  if (!completeCurrentTarget(input, item.language, target)) return undefined;
  return currentSourceRange;
}

function removedStructureDecision(
  input: LandsUpdateInput,
  item: LandsPlanItem,
): LandsPlanItem | undefined {
  if (item.action !== "delete" && item.action !== "retain") return undefined;
  const sourceChange = sourceChangeForItem(item);
  const previousSource = sourceChange?.previous;
  if (
    sourceChange?.status !== "removed" ||
    previousSource?.unit.context.role !== "structure"
  ) {
    return undefined;
  }
  const target = currentTranslationForItem(input, item);
  if (target?.translation.role !== "structure") return undefined;
  const sourceRange = historicalRemovalEvidence(
    input,
    item,
    previousSource,
    target,
  );
  if (sourceRange === undefined) return undefined;

  const removal = removeManagedStructure(
    previousSource.unit.source,
    target.content,
    previousSource.unit.context.path,
  );
  if (removal.status === "review") {
    return reviewExistingItem(item, target, removal.reason);
  }
  if (removal.status === "removed") {
    return deleteExistingItem(
      item,
      previousSource,
      target,
      sourceRange,
      "来源已移除该结构字段；删除仍受管的目标内容。",
    );
  }
  if (sameJson(removal.content, target.content)) {
    return retainExistingItem(
      item,
      target,
      "来源已移除该结构字段；保留其中不属于历史来源的自定义内容。",
    );
  }
  return writeExistingItem(
    item,
    target,
    removal.content,
    {
      presence: "absent",
      key: previousSource.key,
      range: sourceRange,
    },
    "来源已移除该结构字段；删除受管内容并保留自定义内容。",
  );
}

function removedMessageDecision(
  input: LandsUpdateInput,
  item: LandsPlanItem,
): LandsPlanItem | undefined {
  if (item.action !== "retain") return undefined;
  const sourceChange = sourceChangeForItem(item);
  const previousSource = sourceChange?.previous;
  if (
    sourceChange?.status !== "removed" ||
    previousSource?.unit.context.role !== "message"
  ) {
    return undefined;
  }
  const target = currentTranslationForItem(input, item);
  if (target?.translation.role !== "message") return undefined;
  const translationChange = item.changes.translations.find(
    ({ current }) =>
      current !== undefined && sameIdentity(current.identity, target.identity),
  );
  if (translationChange?.status !== "modified") return undefined;
  const sourceRange = historicalRemovalEvidence(
    input,
    item,
    previousSource,
    target,
  );
  if (sourceRange === undefined) return undefined;
  return deleteExistingItem(
    item,
    previousSource,
    target,
    sourceRange,
    "该受管消息已从完整来源范围移除；按 Lands 政策删除对应译文字段。",
  );
}

/** 委托默认消息决定，只扩展 Lands 结构字段合并与受管字段删除政策。 */
export async function landsUpdatePolicy(
  input: LandsUpdateInput,
): Promise<readonly LandsPlanItem[]> {
  const defaultItems = await defaultUpdatePolicy(input);
  const items = defaultItems.map((item) => {
    return (
      removedStructureDecision(input, item) ??
      removedMessageDecision(input, item) ??
      currentStructureDecision(input, item) ??
      item
    );
  });
  const previousRanges = new Set(
    (input.previous?.source.read.scopes ?? []).map(({ range }) =>
      canonicalJson(range as LandsJson),
    ),
  );
  for (const { range } of input.current.source.read.scopes) {
    const candidate = range as LandsJson;
    if (
      !isRecord(candidate) ||
      candidate.kind !== "lands-unregistered-resource" ||
      typeof candidate.path !== "string" ||
      previousRanges.has(canonicalJson(candidate))
    ) {
      continue;
    }
    for (const { language } of input.current.translations.reads) {
      items.push({
        action: "retain",
        language,
        changes: { translations: [] },
        reason: `发现未登记的普通资源 ${candidate.path}；仅提示，不自动加入翻译维护范围。`,
      });
    }
  }
  return items;
}
