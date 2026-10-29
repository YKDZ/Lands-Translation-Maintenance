import { defaultUpdatePolicy, defineConfig } from "@lioni/lioni";
import { createFileQualityExceptionStore } from "@lioni/lioni/node";

import {
  hasLandsStructureMappings,
  landsFactAdapters,
} from "#/lioni/lands-facts";
import { landsProjectPaths } from "#/lioni/project-paths";

/** 根据翻译项目入口构造唯一的 Lands 配置。 */
export function createLandsConfig(entryUrl: string | URL) {
  const paths = landsProjectPaths(entryUrl);
  return defineConfig({
    ...landsFactAdapters(entryUrl),
    updatePolicy: async (input) => {
      const items = await defaultUpdatePolicy(input);
      if (!(await hasLandsStructureMappings(entryUrl))) return items;

      // 03 接入真实结构单元后删除此迁移期阻断。
      return [
        ...items,
        ...input.current.translations.reads.map(({ language }) => ({
          action: "review" as const,
          language,
          changes: { translations: [] },
          reason:
            "当前配置含尚未接入原生更新的结构映射；结构字段仍待处理，不能推进比较基线。",
        })),
      ];
    },
    quality: {
      exceptionStore: createFileQualityExceptionStore(paths.exceptionFile),
      loadDependencies: () => ({ termbaseDirectory: paths.termbaseDirectory }),
    },
  });
}
