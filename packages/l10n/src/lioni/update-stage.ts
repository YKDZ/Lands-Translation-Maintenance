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

function incompleteFactMessage(
  facts: Awaited<ReturnType<typeof readFacts>>,
): string | undefined {
  if (facts.source.read.status !== "complete") {
    return `原文事实读取${facts.source.read.status}，未开始写回${facts.source.read.error === undefined ? "。" : `：${facts.source.read.error}`}`;
  }
  const incompleteTranslations = facts.translations.reads.filter(
    ({ status }) => status !== "complete",
  );
  if (incompleteTranslations.length === 0) return undefined;
  return `译文事实读取不完整：${incompleteTranslations
    .map(
      ({ language, status, error }) =>
        `${language}（${status}${error === undefined ? "" : `：${error}`}）`,
    )
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
