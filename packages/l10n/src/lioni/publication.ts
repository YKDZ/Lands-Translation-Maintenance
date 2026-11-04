import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { loadTermbaseYaml } from "@lioni/lioni/node";

import { parseLandsProjectConfiguration } from "#/lioni/project-configuration";
import { readLandsSourceSnapshot } from "#/lioni/source-input";

export interface LandsPublicationFile {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly content: Uint8Array;
}

export interface LandsPublication {
  readonly sourceVersion: string;
  readonly files: readonly LandsPublicationFile[];
}

/** 从正式术语库读取可公开的表达；禁用表达不进入用户术语表。 */
export async function readLandsPublicationTerms(projectFilePath: string) {
  const directory = dirname(resolve(projectFilePath));
  const configuration = parseLandsProjectConfiguration(
    await readFile(projectFilePath, "utf8"),
    projectFilePath,
  );
  const termbase = await loadTermbaseYaml(join(directory, "terms"));
  return termbase.concepts
    .map((concept) => {
      const expressions = (language: string) => [
        ...new Set(
          concept.languages
            .find((entry) => entry.language === language)
            ?.expressions.filter((entry) => entry.usage !== "forbidden")
            .map((entry) => entry.text) ?? [],
        ),
      ];
      return {
        source: expressions(configuration.translationScope.sourceLanguage),
        target: expressions(configuration.translationScope.targetLanguage),
        note: concept.note ?? "",
      };
    })
    .filter((entry) => entry.source.length > 0 && entry.target.length > 0);
}

/**
 * 从项目维护目录的 project.yml 读取翻译发布资料，不写入任何文件。
 * 版本和文件对应关系复用正式来源及维护清单；译文保留原始字节，
 * 不重新序列化 YAML，也不包含目录中已经退出维护的文件。
 * 此读取不代替正式质量验收，调用方仍须验收同一份来源提交。
 */
export async function readLandsPublication(
  projectFilePath: string,
): Promise<LandsPublication> {
  const projectFile = resolve(projectFilePath);
  const maintenanceDirectory = dirname(projectFile);
  const projectDirectory = dirname(maintenanceDirectory);
  const configuration = parseLandsProjectConfiguration(
    await readFile(projectFile, "utf8"),
    projectFile,
  );
  const mappings = configuration.translationScope.mappings;
  if (mappings.length === 0) {
    throw new Error("翻译维护清单没有可发布的文件。");
  }
  for (const { target } of mappings) {
    // 发布目录仅容纳用户译文，不能将工作流或维护资料作为 YAML 一并导出。
    if (
      !/\.ya?ml$/iu.test(target) ||
      target.split("/").some((part) => part.startsWith("."))
    ) {
      throw new Error(`发布目标必须是非隐藏目录中的 YAML 文件：${target}`);
    }
  }

  const source = await readLandsSourceSnapshot(
    join(maintenanceDirectory, "source"),
  );
  const files = await Promise.all(
    mappings.map(async ({ source: sourcePath, target: targetPath }) => {
      if (!source.resources.has(sourcePath)) {
        throw new Error(`来源快照缺少受管原文：${sourcePath}`);
      }
      return {
        sourcePath,
        targetPath,
        content: await readFile(join(projectDirectory, targetPath)),
      };
    }),
  );
  return { sourceVersion: source.manifest.sourceVersion, files };
}
