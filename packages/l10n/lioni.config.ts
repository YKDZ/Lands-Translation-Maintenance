import { defineConfig } from "@lioni/lioni";
import { createFileQualityExceptionStore } from "@lioni/lioni/node";

import { landsFactAdapters } from "#/lioni/lands-facts";
import { landsUpdatePolicy } from "#/lioni/lands-update-policy";
import { landsProjectPaths } from "#/lioni/project-paths";
import { miniMessageLandsControlsCheck } from "#/minimessage-lands-controls-check";
import { miniMessageNestingCheck } from "#/minimessage-nesting-check";
import { loadMiniMessageQualityDependencies } from "#/minimessage-quality";
import { miniMessageSyntaxCheck } from "#/minimessage-syntax-check";
import { miniMessageTagCorrespondenceCheck } from "#/minimessage-tag-correspondence-check";
import { miniMessageThemeCheck } from "#/minimessage-theme-check";

/** 根据翻译项目入口构造唯一的 Lands 配置。 */
export function createLandsConfig(entryUrl: string | URL) {
  const paths = landsProjectPaths(entryUrl);
  return defineConfig({
    ...landsFactAdapters(entryUrl),
    updatePolicy: landsUpdatePolicy,
    quality: {
      checks: [
        miniMessageSyntaxCheck,
        miniMessageThemeCheck,
        miniMessageTagCorrespondenceCheck,
        miniMessageNestingCheck,
        miniMessageLandsControlsCheck,
      ],
      exceptionStore: createFileQualityExceptionStore(paths.exceptionFile),
      loadDependencies: async ({ facts }) => ({
        ...(await loadMiniMessageQualityDependencies(entryUrl, facts)),
        termbaseDirectory: paths.termbaseDirectory,
      }),
    },
  });
}
