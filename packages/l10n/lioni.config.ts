import { defineConfig } from "@lioni/lioni";
import { createFileQualityExceptionStore } from "@lioni/lioni/node";

import { landsFactAdapters } from "#/lioni/lands-facts";
import { landsProjectPaths } from "#/lioni/project-paths";

/** 根据翻译项目入口构造唯一的 Lands 配置。 */
export function createLandsConfig(entryUrl: string | URL) {
  const paths = landsProjectPaths(entryUrl);
  return defineConfig({
    ...landsFactAdapters(entryUrl),
    quality: {
      exceptionStore: createFileQualityExceptionStore(paths.exceptionFile),
      loadDependencies: () => ({ termbaseDirectory: paths.termbaseDirectory }),
    },
  });
}
