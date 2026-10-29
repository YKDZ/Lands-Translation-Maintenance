import { createMessageFamilyChecker } from "@lioni/lioni";

import {
  landsMessageFamilyAnalysis,
  landsMessageFamilyFingerprint,
  landsMessageTemplate,
  projectLandsMessageFamilyCandidate,
  projectLandsMessageFamilyReference,
  selectLandsMessageFamilyCandidate,
} from "#/minimessage-message-family";

/** 对只在动态变量或数字槽取值上不同的 Lands 模板单独复核译文差异。 */
export const miniMessageSameTemplateFamilyCheck = createMessageFamilyChecker({
  id: "message-family-same-template",
  hostVersion: "lands-same-template-family-v1",
  analysis: landsMessageFamilyAnalysis,
  sourceTemplate: landsMessageTemplate,
  targetTemplate: landsMessageTemplate,
  select: selectLandsMessageFamilyCandidate,
  projectCandidate: projectLandsMessageFamilyCandidate,
  project: projectLandsMessageFamilyReference,
  fingerprintInput: landsMessageFamilyFingerprint,
});
