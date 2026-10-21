import type {
  MiniMessageTagNode,
  ParsedMiniMessageDocument,
  TranslatableTextSegment,
} from "#/model";

const translationFallbackTags = new Set(["translate_or", "lang_or", "tr_or"]);

/** 从官方解析的标签参数中读取纯字符串 fallback，不再递归解释其内容。 */
export function translationFallbackSegment(
  document: ParsedMiniMessageDocument,
  node: MiniMessageTagNode,
): TranslatableTextSegment | undefined {
  if (node.closing || !translationFallbackTags.has(node.name)) return undefined;
  const value = node.parameters[1];
  const position = node.parameterPositions[1];
  if (value === undefined || position === undefined || value === "") {
    return undefined;
  }
  const raw =
    position.start < 0 || position.end < position.start
      ? value
      : document.input.slice(position.start, position.end);
  return {
    kind: "text",
    value,
    raw,
    position,
    context: [
      ...node.context,
      {
        kind: "tag-argument",
        name: "translate_or:fallback",
        position,
      },
    ],
  };
}
