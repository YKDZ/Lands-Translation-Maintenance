import { createMessageFamilyChecker } from "@lioni/lioni";

import {
  landsMessageFamilyAnalysis,
  landsMessageFamilyFingerprint,
  projectLandsMessageFamilyCandidate,
  projectLandsMessageFamilyReference,
  selectLandsMessageFamilyCandidate,
} from "#/minimessage-message-family";

/** 对相同 Lands 原文及上下文中的已保存译文差异给出独立 QA 结论。 */
export const miniMessageSameSourceFamilyCheck = createMessageFamilyChecker({
  id: "message-family-same-source",
  hostVersion: "lands-same-source-family-v2",
  analysis: landsMessageFamilyAnalysis,
  select: selectLandsMessageFamilyCandidate,
  project: projectLandsMessageFamilyCandidate,
  reference: projectLandsMessageFamilyReference,
  fingerprintInput: landsMessageFamilyFingerprint,
});
