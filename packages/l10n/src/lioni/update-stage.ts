import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readFacts, update } from "@lioni/lioni";
import {
  createFileComparisonBaselineStore,
  loadConfig,
} from "@lioni/lioni/node";

import { landsProjectPaths } from "#/lioni/project-paths";

function configPathOf(entry: string | URL): string {
  return entry instanceof URL ? fileURLToPath(entry) : resolve(entry);
}

function scopeRangeLabel(range: unknown): string | undefined {
  if (typeof range !== "object" || range === null || !("kind" in range)) {
    return undefined;
  }
  if (
    (range.kind === "lands-resource" ||
      range.kind === "lands-unregistered-resource") &&
    "path" in range &&
    typeof range.path === "string"
  ) {
    return range.path;
  }
  if (
    range.kind === "lands-target-resource" &&
    "targetFile" in range &&
    typeof range.targetFile === "string"
  ) {
    return range.targetFile;
  }
  return undefined;
}

function readErrorDetail(read: {
  readonly error?: string;
  readonly scopes: readonly {
    readonly range: unknown;
    readonly enumeration: string;
    readonly error?: string;
  }[];
}): string | undefined {
  if (read.error !== undefined) return read.error;
  const details = [
    ...new Set(
      read.scopes
        .filter(({ enumeration }) => enumeration !== "complete")
        .map(({ range, enumeration, error }) => {
          const label = scopeRangeLabel(range);
          const reason = error ?? enumeration;
          return label === undefined || reason.includes(label)
            ? reason
            : `${label}：${reason}`;
        }),
    ),
  ];
  return details.length === 0 ? undefined : details.join("；");
}

function incompleteFactMessage(
  facts: Awaited<ReturnType<typeof readFacts>>,
): string | undefined {
  if (facts.source.read.status !== "complete") {
    const detail = readErrorDetail(facts.source.read);
    return `原文事实读取${facts.source.read.status}，未开始写回${detail === undefined ? "。" : `：${detail}`}`;
  }
  const incompleteTranslations = facts.translations.reads.filter(
    ({ status }) => status !== "complete",
  );
  if (incompleteTranslations.length === 0) return undefined;
  return `译文事实读取不完整：${incompleteTranslations
    .map(({ language, status, ...read }) => {
      const detail = readErrorDetail(read);
      return `${language}（${status}${detail === undefined ? "" : `：${detail}`}）`;
    })
    .join("、")}。未开始写回。`;
}

function updateFailureMessage(
  result: Awaited<ReturnType<typeof update>>,
): string {
  const detail =
    (result.baseline !== undefined && "message" in result.baseline
      ? result.baseline.message
      : undefined) ??
    result.results.find(({ reason }) => reason !== undefined)?.reason;
  return `同步未完整，比较基线未推进；请先完成同步再开始翻译${detail === undefined ? "。" : `：${detail}`}`;
}

/**
 * 内部同步步骤：通过公开 Lioni SDK 同步并推进基线，验收由 check:full 独立执行。
 * SDK 中断时可能已部分写回；可回退的更新入口须在隔离项目副本中调用。
 */
export async function runLandsUpdateStage(entry: string | URL) {
  const configPath = configPathOf(entry);
  const paths = landsProjectPaths(pathToFileURL(configPath));
  const config = await loadConfig(configPath);
  const facts = await readFacts(config);
  const factIssue = incompleteFactMessage(facts);
  if (factIssue !== undefined) {
    return { status: "sync-incomplete" as const, message: factIssue };
  }

  const updateResult = await update(
    config,
    createFileComparisonBaselineStore(paths.baselineFile),
    { recordBaseline: true },
  );
  if (
    updateResult.status !== "completed" ||
    (updateResult.baseline?.outcome !== "saved" &&
      updateResult.baseline?.outcome !== "unchanged")
  ) {
    return {
      status: "sync-incomplete" as const,
      message: updateFailureMessage(updateResult),
      update: updateResult,
    };
  }

  return { status: "completed" as const, update: updateResult };
}
