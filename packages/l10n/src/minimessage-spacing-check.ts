import { defineQualityCheck } from "@lioni/lioni";

import type {
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import type {
  MiniMessagePosition,
  TranslatableTextDocument,
} from "#/mini-message-model";
import {
  dependenciesOf,
  hasMiniMessageInput,
  issueForQuality,
  miniMessageQualityConfigurationSchema,
  outcome,
  qualityBasis,
  type MiniMessageCheckInput,
  type MiniMessageQualityMessageView,
  type MiniMessageQualityObject,
} from "#/minimessage-quality";
import {
  inspectMiniMessageSpacing,
  type MiniMessageSpacingFinding,
} from "#/minimessage-spacing";
import { matchedMiniMessageTranslation } from "#/minimessage-terminology-check";

const version = "lands-chinese-spacing-v1";
const analyses = new WeakMap<
  MiniMessageQualityMessageView,
  readonly {
    readonly document: TranslatableTextDocument;
    readonly findings: readonly MiniMessageSpacingFinding[];
  }[]
>();

function analysisFor(view: MiniMessageQualityMessageView) {
  let analysis = analyses.get(view);
  if (analysis !== undefined) return analysis;
  const parsed = new Map(
    view.documents
      .filter((document) => document.origin === "target")
      .map((document) => [document.documentIndex, document]),
  );
  analysis = view.translatableText.flatMap((document) => {
    if (document.origin !== "target") return [];
    const source = parsed.get(document.documentIndex);
    return source?.status === "parsed"
      ? [{ document, findings: inspectMiniMessageSpacing(document, source) }]
      : [];
  });
  analyses.set(view, analysis);
  return analysis;
}

function viewFor(input: MiniMessageCheckInput) {
  return dependenciesOf(input.dependencies).miniMessageViews[
    input.candidate.sourceKey
  ];
}

/** 中文间隔是译文本身的风格约束，不依赖原文正文配对，也不照抄英文空格。 */
export const miniMessageSpacingCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof miniMessageQualityConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "translation-spacing",
  version,
  configurationSchema: miniMessageQualityConfigurationSchema,
  configuration: {},
  fingerprintInput(input) {
    const view = viewFor(input);
    return qualityBasis({
      version,
      sourceVersion: dependenciesOf(input.dependencies).sourceVersion,
      language: input.candidate.language,
      content: input.candidate.content,
      scene: view?.message.scene ?? null,
      documents:
        view?.translatableText.filter(
          (document) => document.origin === "target",
        ) ?? [],
      parsed:
        view?.documents.filter((document) => document.origin === "target") ??
        [],
      issues:
        view?.incompleteFacts.filter((issue) => issue.origin !== "source") ??
        [],
    });
  },
  check(input) {
    const dependencies = dependenciesOf(input.dependencies);
    const view = viewFor(input);
    if (
      input.candidate.language !== "zh-CN" ||
      !hasMiniMessageInput(input, dependencies)
    )
      return outcome("not-applicable", [], []);
    const association = matchedMiniMessageTranslation(input);
    if (association.status === "not-matched")
      return outcome("not-applicable", [], []);
    if (association.status === "incomplete")
      return outcome(
        "incomplete",
        [],
        [
          {
            code: "translation-spacing.association-incomplete",
            message: association.reason,
          },
        ],
      );
    if (view === undefined)
      return outcome(
        "incomplete",
        [],
        [
          {
            code: "translation-spacing.projection-unavailable",
            message: "间隔检查缺少译文正文投影",
          },
        ],
      );
    const issues = view.incompleteFacts
      .filter((issue) => issue.origin !== "source")
      .map((issue) => issueForQuality(issue, input.candidate));
    if (
      view.documents.some(
        (document) =>
          document.origin === "target" && document.status !== "parsed",
      )
    )
      issues.push({
        code: "translation-spacing.parse-incomplete",
        message: "部分译文无法完整解析，未检查其间隔",
      });
    const diagnostics = analysisFor(view).flatMap(({ document, findings }) =>
      findings.map((finding) => {
        const code = "translation-spacing." + finding.code;
        const object: MiniMessageQualityObject = {
          kind: "translation",
          key: input.candidate.sourceKey,
          language: input.candidate.language,
          code,
        };
        const positions: readonly MiniMessagePosition[] = [
          finding.left.position,
          finding.right.position,
        ];
        const location = {
          language: input.candidate.language,
          range: { file: document.file, path: document.path, positions },
          key: input.candidate.sourceKey,
        };
        return {
          severity: "error" as const,
          object,
          location,
          message: `可见内容 ${finding.left.value} 与 ${finding.right.value} 之间缺少空格`,
          evidence: [
            {
              role: "style-policy",
              object,
              location,
              value: {
                version,
                rule: finding.code,
                policy:
                  "正文词语与独立变量之间、汉字与拉丁字母或数字之间保留空格；标点和技术写法内部不触发此要求",
              },
            },
            {
              role: "actual",
              object,
              location,
              value: {
                documentIndex: document.documentIndex,
                left: finding.left,
                right: finding.right,
              },
            },
          ],
        };
      }),
    );
    return outcome(
      issues.length === 0 ? "complete" : "incomplete",
      diagnostics,
      issues,
    );
  },
});
