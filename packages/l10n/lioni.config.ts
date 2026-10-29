import { defineConfig } from "@lioni/lioni";
import {
  createFileQualityExceptionStore,
  loadTermbaseYaml,
} from "@lioni/lioni/node";

import { landsStructureConsistencyCheck } from "#/lands-structure-consistency-check";
import { legacyFormatCheck } from "#/legacy-format-check";
import { legacyVariableCheck } from "#/legacy-variable-check";
import { landsFactAdapters } from "#/lioni/lands-facts";
import { landsUpdatePolicy } from "#/lioni/lands-update-policy";
import { landsProjectPaths } from "#/lioni/project-paths";
import { mapHtmlCheck } from "#/map-html-check";
import { mapHtmlSourceLimitsCheck } from "#/map-html-source-limits-check";
import { miniMessageClickBehaviorCheck } from "#/minimessage-click-behavior-check";
import { miniMessageHonorificCheck } from "#/minimessage-honorific-check";
import { miniMessageInteractionDistributionCheck } from "#/minimessage-interaction-distribution-check";
import { miniMessageLandsControlsCheck } from "#/minimessage-lands-controls-check";
import { miniMessageNestingCheck } from "#/minimessage-nesting-check";
import { miniMessagePunctuationCheck } from "#/minimessage-punctuation-check";
import { loadMiniMessageQualityDependencies } from "#/minimessage-quality";
import { miniMessageSyntaxCheck } from "#/minimessage-syntax-check";
import { miniMessageTagCorrespondenceCheck } from "#/minimessage-tag-correspondence-check";
import {
  landsTermbaseData,
  landsTerminologyCheck,
} from "#/minimessage-terminology-check";
import { miniMessageThemeCheck } from "#/minimessage-theme-check";
import { miniMessageVariableCorrespondenceCheck } from "#/minimessage-variable-correspondence-check";
import {
  buildTranslationOmissionCandidates,
  translationOmissionsCheck,
} from "#/translation-omissions-check";

/** 根据翻译项目入口构造唯一的 Lands 配置。 */
export function createLandsConfig(entryUrl: string | URL) {
  const paths = landsProjectPaths(entryUrl);
  return defineConfig({
    ...landsFactAdapters(entryUrl),
    updatePolicy: landsUpdatePolicy,
    quality: {
      buildCandidates: buildTranslationOmissionCandidates,
      checks: [
        miniMessageSyntaxCheck,
        miniMessageThemeCheck,
        miniMessageTagCorrespondenceCheck,
        miniMessageNestingCheck,
        miniMessageLandsControlsCheck,
        mapHtmlCheck,
        mapHtmlSourceLimitsCheck,
        legacyFormatCheck,
        legacyVariableCheck,
        landsTerminologyCheck,
        miniMessagePunctuationCheck,
        miniMessageHonorificCheck,
        miniMessageVariableCorrespondenceCheck,
        miniMessageClickBehaviorCheck,
        miniMessageInteractionDistributionCheck,
        translationOmissionsCheck,
        landsStructureConsistencyCheck,
      ],
      exceptionStore: createFileQualityExceptionStore(paths.exceptionFile),
      loadDependencies: async ({ facts }) => {
        const [miniMessage, termbase] = await Promise.all([
          loadMiniMessageQualityDependencies(entryUrl, facts),
          loadTermbaseYaml(paths.termbaseDirectory),
        ]);
        return { ...miniMessage, termbaseData: landsTermbaseData(termbase) };
      },
    },
  });
}
