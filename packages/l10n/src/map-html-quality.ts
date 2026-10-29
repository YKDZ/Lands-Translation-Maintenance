import type { MiniMessageIncompleteFact } from "#/mini-message-model";
import {
  dependenciesOf,
  hasAvailableMiniMessageTranslation,
  messageForCandidate,
  type MiniMessageCheckInput,
  type MiniMessageQualityDependencies,
} from "#/minimessage-quality";

export function mapHtmlMessage(input: MiniMessageCheckInput) {
  const dependencies = dependenciesOf(input.dependencies);
  const message = messageForCandidate(dependencies, input.candidate.sourceKey);
  return message?.format === "map-html-minimessage" &&
    hasAvailableMiniMessageTranslation(
      input,
      input.candidate.sourceKey,
      input.candidate.language,
    )
    ? message
    : undefined;
}

export function mapHtmlFindings(
  dependencies: MiniMessageQualityDependencies,
  sourceKey: string,
  origin?: "source" | "target",
) {
  return dependencies.projection.mapFindings.filter(
    (finding) =>
      finding.message?.id === sourceKey &&
      (origin === undefined || finding.origin === origin),
  );
}

export function mapHtmlIssues(
  input: MiniMessageCheckInput,
  sourceKey: string,
): readonly MiniMessageIncompleteFact[] {
  const dependencies = dependenciesOf(input.dependencies);
  const message = messageForCandidate(dependencies, sourceKey);
  const documentIssues = (["source", "target"] as const).flatMap((origin) => {
    const document = dependencies.projection.documents.find(
      (candidate) =>
        candidate.message.id === sourceKey &&
        candidate.origin === origin &&
        candidate.parent === undefined &&
        candidate.documentIndex === 0,
    );
    if (document !== undefined && document.status === "parsed") return [];
    if (message === undefined) return [];
    const side = origin === "source" ? "原文" : "译文";
    return [
      {
        code: "map-html.document-unavailable",
        message,
        origin,
        location: {
          file: origin === "source" ? message.sourceFile : message.targetFile,
          path: message.path,
        },
        reason:
          document === undefined
            ? "地图" + side + "的官方 MiniMessage 文档缺失"
            : "地图" + side + "的 MiniMessage 解析未完成",
      },
    ];
  });
  const readIssues = dependencies.readIssues.filter(
    (issue) => issue.message === undefined || issue.message.id === sourceKey,
  );
  const selectedIssues = [
    ...dependencies.projection.incompleteFacts,
    ...dependencies.pairing.incomplete,
  ].filter(
    (issue) =>
      issue.message?.id === sourceKey ||
      (issue.message === undefined &&
        (issue.code === "minimessage.java-unavailable" ||
          issue.code === "minimessage.project-input-unavailable" ||
          (issue.code === "minimessage.projection-incomplete" &&
            issue.reason.includes("地图模板变量供值")))),
  );
  return [...readIssues, ...selectedIssues, ...documentIssues];
}
