import type { CheckRule } from "#/model";
import { sameValue } from "#/value";

export const translationReviewRule: CheckRule = {
  id: "translation-review",
  defaultSeverity: "info",
  evaluate(project) {
    return project.messages.flatMap((message) => {
      const pendingReason = message.translationReview?.pendingReason;
      if (
        pendingReason === undefined ||
        message.targetStatus !== "present" ||
        message.target === undefined ||
        !sameValue(message.source, message.target)
      )
        return [];
      return [
        {
          code: "translation.same-text",
          message,
          location: { file: message.targetFile, path: message.path },
          reason:
            pendingReason === "translation-seed"
              ? "同步填入的原文尚未翻译或明确接受"
              : "历史同文候选尚未明确接受",
          fingerprint: { pendingReason },
          expected: { state: "translated-or-accepted" },
          actual: {
            source: message.source,
            target: message.target,
            pendingReason,
          },
        },
      ];
    });
  },
};
