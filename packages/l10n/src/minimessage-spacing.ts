import type {
  MiniMessageContextFrame,
  MiniMessagePosition,
  ParsedMiniMessageDocument,
  TranslatableTextDocument,
  TranslatableTextSegment,
} from "#/mini-message-model";

interface SpacingAtom {
  readonly kind: "han" | "latin" | "number" | "variable" | "other";
  readonly value: string;
  readonly position: MiniMessagePosition;
  readonly exact: boolean;
  /** 解码后的片段内偏移；HTML 实体等只能回映整段时仍能区分不同边界。 */
  readonly textOffset: number;
}

export interface MiniMessageSpacingFinding {
  readonly code: "variable-boundary" | "mixed-boundary";
  readonly left: SpacingAtom;
  readonly right: SpacingAtom;
}

const controls = new Set([
  "title",
  "subtitle",
  "actionbar",
  "bossbar",
  "java",
  "verbose",
  "ingame",
  "noprefix",
  "action",
  "label",
  "desc",
  "indent",
]);
const transparentControls = new Set([
  "verbose",
  "ingame",
  "noprefix",
  "indent",
]);
const htmlBlocks = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

function frameKey(frame: MiniMessageContextFrame): string {
  return `${frame.kind}:${frame.name}:${frame.position.start}:${frame.position.end}`;
}

function flowFor(segment: TranslatableTextSegment): {
  key: string;
  attribute: boolean;
} {
  const attribute = segment.context.findLast(
    (frame) => frame.kind === "html-attribute",
  );
  if (attribute !== undefined)
    return { key: frameKey(attribute), attribute: true };
  const block = segment.context.findLast(
    (frame) => frame.kind === "html-element" && htmlBlocks.has(frame.name),
  );
  const argument = segment.context.findLast(
    (frame) => frame.kind === "tag-argument",
  );
  return {
    key: [block, argument]
      .filter((frame) => frame !== undefined)
      .map(frameKey)
      .join("/"),
    attribute: false,
  };
}

function atomKind(value: string): SpacingAtom["kind"] {
  if (/\p{Script_Extensions=Han}/u.test(value)) return "han";
  if (/\p{Script_Extensions=Latin}/u.test(value) && /\p{L}/u.test(value))
    return "latin";
  if (/[0-9]/u.test(value)) return "number";
  return "other";
}

function boundaryCode(
  left: SpacingAtom,
  right: SpacingAtom,
): MiniMessageSpacingFinding["code"] | undefined {
  const word = (atom: SpacingAtom) =>
    atom.kind === "han" || atom.kind === "latin" || atom.kind === "number";
  if (
    (left.kind === "variable" && word(right)) ||
    (right.kind === "variable" && word(left))
  )
    return "variable-boundary";
  if (
    (left.kind === "han" &&
      (right.kind === "latin" || right.kind === "number")) ||
    (right.kind === "han" && (left.kind === "latin" || left.kind === "number"))
  )
    return "mixed-boundary";
  return undefined;
}

/**
 * 检查连续可见内容中缺少的间隔，只读，不产生自动修复操作。
 * 变量按独立内容处理；汉字与拉丁字母、数字之间需要空格。标点、已有空白
 * 和真实换行不触发混排要求，命令参数与不透明内容不当作正文。
 * 样式和点击元数据不打断显示；悬浮提示由调用方作为独立文档传入。
 */
export function inspectMiniMessageSpacing(
  document: TranslatableTextDocument,
  parsed: ParsedMiniMessageDocument,
): readonly MiniMessageSpacingFinding[] {
  const offset =
    parsed.listItems?.find(
      (item) => JSON.stringify(item.path) === JSON.stringify(document.path),
    )?.position.start ?? 0;
  const controlNodes = parsed.nodes.flatMap((node) => {
    if (node.kind !== "tag" || !controls.has(node.name)) return [];
    const position = {
      start: node.position.start - offset,
      end: node.position.end - offset,
    };
    return position.start >= document.range.start &&
      position.end <= document.range.end
      ? [{ ...node, position }]
      : [];
  });
  const controlPositions = new Set(
    controlNodes.map((node) => `${node.position.start}:${node.position.end}`),
  );
  const events = [
    ...controlNodes.map((node) => ({
      kind: "control" as const,
      position: node.position,
      node,
    })),
    ...document.segments
      .filter(
        (segment) =>
          !controlPositions.has(
            `${segment.position.start}:${segment.position.end}`,
          ),
      )
      .map((segment) => ({
        kind: "segment" as const,
        position: segment.position,
        segment,
      })),
  ].sort((left, right) => left.position.start - right.position.start);
  const findings = new Map<string, MiniMessageSpacingFinding>();
  // Java 片段在非 Java 客户端中消失；两种可见序列分别检查，避免拼接互斥内容。
  const platforms = controlNodes.some((node) => node.name === "java")
    ? [true, false]
    : [true];
  for (const java of platforms) {
    let javaDepth = 0;
    let currentFlow: string | undefined;
    let previous: SpacingAtom | undefined;
    const attributePrevious = new Map<string, SpacingAtom>();
    const append = (atom: SpacingAtom, flow: ReturnType<typeof flowFor>) => {
      const left = flow.attribute ? attributePrevious.get(flow.key) : previous;
      if (left !== undefined) {
        const code = boundaryCode(left, atom);
        if (code !== undefined) {
          const key = `${left.position.start}:${left.position.end}:${left.textOffset}:${atom.position.start}:${atom.position.end}:${atom.textOffset}`;
          findings.set(key, { code, left, right: atom });
        }
      }
      if (flow.attribute) attributePrevious.set(flow.key, atom);
      else previous = atom;
    };
    for (const event of events) {
      if (event.kind === "control") {
        if (event.node.name === "java") {
          javaDepth = Math.max(0, javaDepth + (event.node.closing ? -1 : 1));
        } else if (
          !transparentControls.has(event.node.name) &&
          (java || javaDepth === 0)
        ) {
          previous = undefined;
        }
        continue;
      }
      if (!java && javaDepth > 0) continue;
      const segment = event.segment;
      const flow = flowFor(segment);
      if (!flow.attribute && currentFlow !== flow.key) {
        previous = undefined;
        currentFlow = flow.key;
      }
      if (
        segment.kind === "command" ||
        (segment.kind === "structure" && segment.raw === "</click>")
      )
        continue;
      if (segment.kind === "boundary" || segment.kind === "structure") {
        if (flow.attribute) attributePrevious.delete(flow.key);
        else previous = undefined;
        continue;
      }
      if (segment.kind === "variable") {
        append(
          {
            kind: "variable",
            value: segment.raw,
            position: segment.position,
            exact: true,
            textOffset: 0,
          },
          flow,
        );
        continue;
      }
      const exact =
        segment.position.end - segment.position.start === segment.value.length;
      let index = 0;
      for (const value of segment.value) {
        // 组合附加符和零宽格式字符不是可见间隔，不能掩盖相邻正文的缺空格。
        if (/[\p{M}\p{Cf}]/u.test(value)) {
          index += value.length;
          continue;
        }
        const position = exact
          ? {
              start: segment.position.start + index,
              end: segment.position.start + index + value.length,
            }
          : segment.position;
        append(
          { kind: atomKind(value), value, position, exact, textOffset: index },
          flow,
        );
        index += value.length;
      }
    }
  }
  return [...findings.values()];
}
