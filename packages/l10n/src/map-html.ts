import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

import { translationFallbackSegment } from "#/minimessage-text";
import type {
  JsonValue,
  MiniMessageContextFrame,
  MiniMessageFinding,
  MiniMessagePosition,
  MiniMessageSourceNode,
  ParsedMiniMessageDocument,
  TranslatableTextSegment,
} from "#/model";

type HtmlNode = DefaultTreeAdapterTypes.ChildNode;
type HtmlElement = DefaultTreeAdapterTypes.Element;
type HtmlText = DefaultTreeAdapterTypes.TextNode;

interface Projection {
  readonly input: string;
  readonly sourceStarts: readonly number[];
  readonly sourceEnds: readonly number[];
  readonly markers: ReadonlyMap<string, ProjectionMarker>;
  readonly htmlTagRanges: readonly HtmlTagRange[];
  readonly htmlAttributeRanges: readonly {
    readonly start: number;
    readonly end: number;
    readonly name: string;
  }[];
}

interface MutableProjectionOffsets {
  readonly starts: number[];
  readonly ends: number[];
}

interface ProjectionMarker {
  readonly kind:
    | "variable"
    | "command-open"
    | "command-close"
    | "boundary"
    | "fallback-open"
    | "fallback-close"
    | "structure";
  readonly node: Extract<MiniMessageSourceNode, { readonly kind: "tag" }>;
  readonly value?: string;
}

export interface HtmlTagRange {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly closing: boolean;
  readonly raw: string;
}

interface HtmlAttribute {
  readonly name: string;
  readonly value: string;
  readonly position: MiniMessagePosition;
}

interface HtmlElementInfo {
  readonly name: string;
  readonly path: readonly number[];
  readonly attributes: readonly HtmlAttribute[];
  readonly position: MiniMessagePosition;
}

interface ParsedHtml {
  readonly projection: Projection;
  readonly elements: readonly HtmlElementInfo[];
  readonly segments: readonly TranslatableTextSegment[];
  readonly parserErrors: readonly {
    readonly code: string;
    readonly position: MiniMessagePosition;
  }[];
  readonly structuralIssues: readonly {
    readonly code: string;
    readonly position: MiniMessagePosition;
    readonly actual: string;
  }[];
}

const translatableAttributes = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-valuetext",
  "placeholder",
  "title",
]);
const voidElements = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const optionalEndTags = new Set([
  "dd",
  "dt",
  "li",
  "optgroup",
  "option",
  "p",
  "rp",
  "rt",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
]);
const suppliedMapVariables = new Set([
  "land",
  "title",
  "owner",
  "members",
  "members_amount",
  "level",
  "public",
  "allies",
  "enemies",
  "cmd",
  "capital",
  "level_nation",
  "lands",
  "lands_amount",
  "members_amount_nation",
  "nation_created_at",
]);

const mapVariablesByVersion = new Map([
  ["8.0.1", suppliedMapVariables],
  ["8.9.2", new Set([...suppliedMapVariables, "land_color"])],
]);

function walkElements(
  nodes: readonly HtmlNode[],
  visit: (element: HtmlElement) => void,
): void {
  for (const node of nodes) {
    if (node.nodeName === "#text" || node.nodeName === "#comment") continue;
    if (node.nodeName === "#documentType") continue;
    const element = node as HtmlElement;
    visit(element);
    walkElements(element.childNodes, visit);
  }
}

function htmlRanges(input: string): {
  readonly tags: readonly HtmlTagRange[];
  readonly attributes: readonly {
    readonly start: number;
    readonly end: number;
    readonly name: string;
  }[];
} {
  const fragment = parseFragment(input, { sourceCodeLocationInfo: true });
  const ranges: HtmlTagRange[] = [];
  const attributes: {
    readonly start: number;
    readonly end: number;
    readonly name: string;
  }[] = [];
  walkElements(fragment.childNodes, (element) => {
    const location = element.sourceCodeLocation;
    if (location?.startTag !== undefined) {
      ranges.push({
        start: location.startTag.startOffset,
        end: location.startTag.endOffset,
        name: element.tagName.toLowerCase(),
        closing: false,
        raw: input.slice(
          location.startTag.startOffset,
          location.startTag.endOffset,
        ),
      });
    }
    if (location?.endTag !== undefined) {
      ranges.push({
        start: location.endTag.startOffset,
        end: location.endTag.endOffset,
        name: element.tagName.toLowerCase(),
        closing: true,
        raw: input.slice(
          location.endTag.startOffset,
          location.endTag.endOffset,
        ),
      });
    }
    for (const [name, attribute] of Object.entries(location?.attrs ?? {})) {
      attributes.push({
        start: attribute.startOffset,
        end: attribute.endOffset,
        name: name.toLowerCase(),
      });
    }
  });
  return { tags: ranges, attributes };
}

function parserTagRanges(
  input: string,
  nodes: readonly MiniMessageSourceNode[],
): readonly HtmlTagRange[] {
  const { tags } = htmlRanges(input);
  return tags.filter(
    (tag) =>
      !nodes.some(
        (node) =>
          node.kind === "tag" &&
          node.position.start === tag.start &&
          node.position.end === tag.end &&
          node.raw === tag.raw &&
          (node.name === "v" || node.semanticKind !== "unknown"),
      ),
  );
}

function attributeRanges(input: string): Projection["htmlAttributeRanges"] {
  return htmlRanges(input).attributes;
}

function isWithinHtmlAttribute(
  start: number,
  end: number,
  attributes: Projection["htmlAttributeRanges"],
): boolean {
  return attributes.some(
    (attribute) => attribute.start <= start && end <= attribute.end,
  );
}

function appendSourceRange(
  input: string,
  pieces: string[],
  offsets: MutableProjectionOffsets,
  start: number,
  end: number,
): void {
  if (start >= end) return;
  appendProjection(pieces, offsets, input.slice(start, end), {
    start,
    end,
  });
}

function nodeOutput(
  node: MiniMessageSourceNode,
  marker: string | undefined,
  withinAttribute: boolean,
): string | undefined {
  if (node.kind !== "tag") return node.visibleText;
  if (marker !== undefined) return marker;
  // Lands 8.0.1 keeps map placeholders inside HTML attributes literal; this
  // versioned behavior is separate from official MiniMessage insertions.
  if (withinAttribute && node.name === "v") {
    return node.raw;
  }
  return node.visibleText === "" ? undefined : node.visibleText;
}

function appendProjection(
  pieces: string[],
  offsets: MutableProjectionOffsets,
  text: string,
  position: MiniMessagePosition,
): void {
  if (text.length === 0) return;
  const currentBoundary = offsets.starts.length - 1;
  if (pieces.length === 0) {
    offsets.ends[currentBoundary] = position.start;
  }
  offsets.starts[currentBoundary] = position.start;
  pieces.push(text);
  const exact = text.length === position.end - position.start;
  for (let index = 1; index <= text.length; index += 1) {
    const sourceOffset = exact
      ? position.start + index
      : index === text.length
        ? position.end
        : position.start;
    offsets.starts.push(sourceOffset);
    offsets.ends.push(sourceOffset);
  }
}

function appendMappedProjection(
  pieces: string[],
  projectionOffsets: MutableProjectionOffsets,
  text: string,
  offsets: readonly number[],
): void {
  if (text.length === 0) return;
  if (offsets.length !== text.length + 1) {
    throw new Error("地图 fallback 的来源位置映射长度无效");
  }
  const currentBoundary = projectionOffsets.starts.length - 1;
  const start = offsets[0] ?? -1;
  if (pieces.length === 0) {
    projectionOffsets.ends[currentBoundary] = start;
  }
  projectionOffsets.starts[currentBoundary] = start;
  pieces.push(text);
  projectionOffsets.starts.push(...offsets.slice(1));
  projectionOffsets.ends.push(...offsets.slice(1));
}

function fallbackSourceOffsets(
  node: Extract<MiniMessageSourceNode, { readonly kind: "tag" }>,
  value: string,
): readonly number[] {
  const offsets = node.parameterSourceOffsets[1];
  if (offsets === undefined || offsets.length !== value.length + 1) {
    return Array.from({ length: value.length + 1 }, () => -1);
  }
  return offsets;
}

function projectionMarker(
  markerIndex: number,
  markers: Map<string, ProjectionMarker>,
  value: ProjectionMarker,
): string {
  const marker = `\uE000L${markerIndex}\uE001`;
  markers.set(marker, value);
  return marker;
}

function projectionFor(document: ParsedMiniMessageDocument): Projection {
  const htmlTagRanges = parserTagRanges(document.input, document.nodes);
  const htmlAttributeRanges = attributeRanges(document.input);
  const pieces: string[] = [];
  const offsets: MutableProjectionOffsets = { starts: [0], ends: [0] };
  const markers = new Map<string, ProjectionMarker>();
  let markerIndex = 0;
  let cursor = 0;

  for (const node of [...document.nodes].sort(
    (left, right) =>
      left.position.start - right.position.start ||
      left.position.end - right.position.end,
  )) {
    const { start, end } = node.position;
    if (start < cursor || start < 0 || end < start) continue;
    appendSourceRange(document.input, pieces, offsets, cursor, start);

    const fallback =
      node.kind === "tag"
        ? translationFallbackSegment(document, node)
        : undefined;
    if (
      fallback !== undefined &&
      fallback.value === node.visibleText &&
      !isWithinHtmlAttribute(start, end, htmlAttributeRanges)
    ) {
      const nodeTag = node as Extract<
        MiniMessageSourceNode,
        { readonly kind: "tag" }
      >;
      const fallbackOffsets = fallbackSourceOffsets(nodeTag, fallback.value);
      const fallbackStart = fallbackOffsets[0] ?? -1;
      const fallbackEnd = fallbackOffsets[fallbackOffsets.length - 1] ?? -1;
      const structureMarker = projectionMarker(markerIndex, markers, {
        kind: "structure",
        node: nodeTag,
        value: nodeTag.parameters[0] ?? "",
      });
      markerIndex += 1;
      appendProjection(pieces, offsets, structureMarker, {
        start,
        end: start,
      });
      // 分隔结构片段和 fallback 片段，避免来源位置跨过整段 MiniMessage 包装。
      appendProjection(pieces, offsets, "<!-- -->", { start, end });
      const openMarker = projectionMarker(markerIndex, markers, {
        kind: "fallback-open",
        node: nodeTag,
      });
      markerIndex += 1;
      appendProjection(pieces, offsets, openMarker, {
        start: fallbackStart,
        end: fallbackStart,
      });
      appendMappedProjection(pieces, offsets, fallback.value, fallbackOffsets);
      const closeMarker = projectionMarker(markerIndex, markers, {
        kind: "fallback-close",
        node: nodeTag,
      });
      markerIndex += 1;
      appendProjection(pieces, offsets, closeMarker, {
        start: fallbackEnd,
        end: fallbackEnd,
      });
      cursor = end;
      continue;
    }

    let marker: string | undefined;
    if (
      node.kind === "tag" &&
      !isWithinHtmlAttribute(start, end, htmlAttributeRanges)
    ) {
      let kind: ProjectionMarker["kind"] | undefined;
      if (
        node.name === "v" &&
        !node.closing &&
        node.parameters[0] !== undefined
      ) {
        kind = "variable";
      } else if (node.name === "click") {
        kind = node.closing ? "command-close" : "command-open";
      } else if (node.name === "br" || node.name === "newline") {
        kind = "boundary";
      } else if (
        node.visibleText === "" &&
        node.semanticKind !== "unknown" &&
        node.semanticKind !== "style"
      ) {
        kind = "structure";
      } else if (
        node.visibleText === "" &&
        node.semanticKind === "unknown" &&
        !isMapHtmlParserTag(document.input, start, node.raw, htmlTagRanges)
      ) {
        kind = "structure";
      }
      if (kind !== undefined) {
        marker = `\uE000L${markerIndex}\uE001`;
        markerIndex += 1;
        markers.set(marker, { kind, node });
      }
    }
    const withinAttribute = isWithinHtmlAttribute(
      start,
      end,
      htmlAttributeRanges,
    );
    const replacement = nodeOutput(node, marker, withinAttribute);
    if (replacement !== undefined) {
      if (
        replacement === node.visibleText &&
        node.visibleSourceOffsets.length === replacement.length + 1
      ) {
        appendMappedProjection(
          pieces,
          offsets,
          replacement,
          node.visibleSourceOffsets,
        );
      } else {
        appendProjection(pieces, offsets, replacement, node.position);
      }
    } else if (pieces.length === 0) {
      const currentBoundary = offsets.starts.length - 1;
      offsets.starts[currentBoundary] = end;
      offsets.ends[currentBoundary] = end;
    }
    cursor = end;
  }
  appendSourceRange(
    document.input,
    pieces,
    offsets,
    cursor,
    document.input.length,
  );

  return {
    input: pieces.join(""),
    sourceStarts: offsets.starts,
    sourceEnds: offsets.ends,
    markers,
    htmlTagRanges,
    htmlAttributeRanges,
  };
}

function mappedPosition(
  offsets: Pick<Projection, "sourceStarts" | "sourceEnds">,
  start: number,
  end: number,
): MiniMessagePosition {
  if (start === end) {
    const offset = offsets.sourceStarts[start] ?? offsets.sourceEnds[end] ?? -1;
    return { start: offset, end: offset };
  }
  return {
    start: offsets.sourceStarts[start] ?? -1,
    end: offsets.sourceEnds[end] ?? -1,
  };
}

function positionJson(position: MiniMessagePosition): JsonValue {
  return { start: position.start, end: position.end };
}

function textSegment(
  value: string,
  raw: string,
  position: MiniMessagePosition,
  context: TranslatableTextSegment["context"],
): TranslatableTextSegment | undefined {
  if (value === "") return undefined;
  return {
    kind: "text",
    value,
    raw,
    position,
    context,
  };
}

function segmentsForTextNode(
  node: HtmlText,
  projection: Projection,
  context: TranslatableTextSegment["context"],
  activeClicks: MiniMessageContextFrame[],
  activeFallbacks: MiniMessageContextFrame[],
): TranslatableTextSegment[] {
  const location = node.sourceCodeLocation;
  if (location === null || location === undefined) return [];
  const value = node.value;
  const textStart = location.startOffset;
  const textEnd = location.endOffset;
  const markers = [...projection.markers.keys()];
  const currentContext = (): TranslatableTextSegment["context"] => [
    ...context,
    ...activeClicks,
    ...activeFallbacks.filter(
      (frame) =>
        !context.some(
          (existing) =>
            existing.kind === frame.kind &&
            existing.name === frame.name &&
            existing.position.start === frame.position.start,
        ),
    ),
  ];
  if (
    markers.length === 0 ||
    !markers.some((marker) => value.includes(marker))
  ) {
    const segment = textSegment(
      value,
      projection.input.slice(textStart, textEnd),
      mappedPosition(projection, textStart, textEnd),
      currentContext(),
    );
    return segment === undefined ? [] : [segment];
  }

  const segments: TranslatableTextSegment[] = [];
  let valueOffset = 0;
  let sourceOffset = textStart;
  while (valueOffset < value.length) {
    let next: { readonly marker: string; readonly index: number } | undefined;
    for (const marker of markers) {
      const index = value.indexOf(marker, valueOffset);
      if (index < 0) continue;
      if (next === undefined || index < next.index) next = { marker, index };
    }
    if (next === undefined) {
      const rest = value.slice(valueOffset);
      const sourceEnd = textEnd;
      const segment = textSegment(
        rest,
        projection.input.slice(sourceOffset, sourceEnd),
        mappedPosition(projection, sourceOffset, sourceEnd),
        currentContext(),
      );
      if (segment !== undefined) segments.push(segment);
      break;
    }
    const prefix = value.slice(valueOffset, next.index);
    const markerStart = projection.input.indexOf(next.marker, sourceOffset);
    const prefixEnd = markerStart < 0 ? sourceOffset : markerStart;
    const prefixSegment = textSegment(
      prefix,
      projection.input.slice(sourceOffset, prefixEnd),
      mappedPosition(projection, sourceOffset, prefixEnd),
      currentContext(),
    );
    if (prefixSegment !== undefined) segments.push(prefixSegment);
    const projectionMarker = projection.markers.get(next.marker);
    if (projectionMarker !== undefined) {
      const markerNode = projectionMarker.node;
      const markerContext = currentContext();
      if (projectionMarker.kind === "variable") {
        segments.push({
          kind: "variable",
          value: markerNode.parameters[0] ?? "",
          raw: markerNode.raw,
          position: markerNode.position,
          context: markerContext,
        });
      } else if (projectionMarker.kind === "command-open") {
        segments.push({
          kind: "command",
          value: markerNode.parameters.join(":"),
          raw: markerNode.raw,
          position: markerNode.position,
          context: markerContext,
        });
        activeClicks.push({
          kind: "tag",
          name: "click",
          position: markerNode.position,
        });
      } else if (projectionMarker.kind === "command-close") {
        segments.push({
          kind: "structure",
          value: "/click",
          raw: markerNode.raw,
          position: markerNode.position,
          context: markerContext,
        });
        const openClick = [...markerNode.context]
          .reverse()
          .find((frame) => frame.kind === "tag" && frame.name === "click");
        const openIndex =
          openClick === undefined
            ? activeClicks.length - 1
            : activeClicks.findLastIndex(
                (frame) =>
                  frame.name === openClick.name &&
                  frame.position.start === openClick.position.start,
              );
        if (openIndex >= 0) activeClicks.splice(openIndex, 1);
      } else if (projectionMarker.kind === "boundary") {
        segments.push({
          kind: "boundary",
          value: "\n",
          raw: markerNode.raw,
          position: markerNode.position,
          context: markerContext,
        });
      } else if (projectionMarker.kind === "fallback-open") {
        const fallbackPosition = markerNode.parameterPositions[1];
        if (fallbackPosition !== undefined) {
          activeFallbacks.push({
            kind: "tag-argument",
            name: "translate_or:fallback",
            position: fallbackPosition,
          });
        }
      } else if (projectionMarker.kind === "fallback-close") {
        const fallbackPosition = markerNode.parameterPositions[1];
        const openIndex =
          fallbackPosition === undefined
            ? activeFallbacks.length - 1
            : activeFallbacks.findLastIndex(
                (frame) => frame.position.start === fallbackPosition.start,
              );
        if (openIndex >= 0) activeFallbacks.splice(openIndex, 1);
      } else {
        segments.push({
          kind: "structure",
          value: projectionMarker.value ?? markerNode.parameters.join(":"),
          raw: markerNode.raw,
          position: markerNode.position,
          context: markerContext,
        });
      }
    }
    valueOffset = next.index + next.marker.length;
    sourceOffset =
      markerStart < 0 ? sourceOffset : markerStart + next.marker.length;
  }
  return segments;
}

function parseHtml(document: ParsedMiniMessageDocument): ParsedHtml {
  const projection = projectionFor(document);
  const parserErrors: ParsedHtml["parserErrors"] extends readonly (infer Item)[]
    ? Item[]
    : never = [];
  const fragment = parseFragment(projection.input, {
    sourceCodeLocationInfo: true,
    onParseError(error) {
      parserErrors.push({
        code: error.code,
        position: mappedPosition(
          projection,
          error.startOffset,
          error.endOffset,
        ),
      });
    },
  });
  const elements: HtmlElementInfo[] = [];
  const segments: TranslatableTextSegment[] = [];
  const structuralIssues: {
    code: string;
    position: MiniMessagePosition;
    actual: string;
  }[] = [];
  const activeClicks: MiniMessageContextFrame[] = [];
  const activeFallbacks: MiniMessageContextFrame[] = [];

  function visit(
    nodes: readonly HtmlNode[],
    parentPath: readonly number[],
    inheritedContext: TranslatableTextSegment["context"],
  ): void {
    let elementIndex = 0;
    for (const node of nodes) {
      if (node.nodeName === "#text") {
        segments.push(
          ...segmentsForTextNode(
            node as HtmlText,
            projection,
            inheritedContext,
            activeClicks,
            activeFallbacks,
          ),
        );
        continue;
      }
      if (node.nodeName === "#comment" || node.nodeName === "#documentType") {
        continue;
      }
      const element = node as HtmlElement;
      const location = element.sourceCodeLocation;
      if (location === null || location === undefined) {
        structuralIssues.push({
          code: "html-element-location-missing",
          position: { start: -1, end: -1 },
          actual: element.tagName,
        });
        visit(element.childNodes, parentPath, inheritedContext);
        continue;
      }
      const elementPath = [...parentPath, elementIndex];
      elementIndex += 1;
      const elementPosition = mappedPosition(
        projection,
        location.startOffset,
        location.endOffset,
      );
      const context = [
        ...inheritedContext,
        ...activeFallbacks.filter(
          (frame) =>
            !inheritedContext.some(
              (existing) =>
                existing.kind === frame.kind &&
                existing.name === frame.name &&
                existing.position.start === frame.position.start,
            ),
        ),
        {
          kind: "html-element" as const,
          name: element.tagName.toLowerCase(),
          position: elementPosition,
        },
      ];
      const attributes = element.attrs.map((attribute) => {
        const attributeLocation = location.attrs?.[attribute.name];
        const position =
          attributeLocation === undefined
            ? elementPosition
            : mappedPosition(
                projection,
                attributeLocation.startOffset,
                attributeLocation.endOffset,
              );
        if (translatableAttributes.has(attribute.name.toLowerCase())) {
          segments.push({
            kind: "text",
            value: attribute.value,
            raw:
              attributeLocation === undefined
                ? attribute.value
                : projection.input.slice(
                    attributeLocation.startOffset,
                    attributeLocation.endOffset,
                  ),
            position,
            context: [
              ...context,
              {
                kind: "html-attribute" as const,
                name: attribute.name.toLowerCase(),
                position,
              },
            ],
          });
        }
        return {
          name: attribute.name.toLowerCase(),
          value: attribute.value,
          position,
        };
      });
      elements.push({
        name: element.tagName.toLowerCase(),
        path: elementPath,
        attributes,
        position: elementPosition,
      });
      if (
        !voidElements.has(element.tagName.toLowerCase()) &&
        !optionalEndTags.has(element.tagName.toLowerCase()) &&
        location.endTag === undefined
      ) {
        structuralIssues.push({
          code: "html-element-close-missing",
          position: mappedPosition(
            projection,
            location.startTag?.startOffset ?? location.startOffset,
            location.startTag?.endOffset ?? location.endOffset,
          ),
          actual: element.tagName.toLowerCase(),
        });
      }
      visit(element.childNodes, elementPath, context);
    }
  }

  visit(fragment.childNodes, [], document.context);
  return {
    projection,
    elements,
    segments,
    parserErrors,
    structuralIssues,
  };
}

function finding(
  document: ParsedMiniMessageDocument,
  code: string,
  identity: JsonValue,
  expected: JsonValue,
  actual: JsonValue,
  reason: string,
  sourceVersion: string,
): MiniMessageFinding {
  return {
    code,
    identity,
    fingerprint: { format: "map-html-v1", sourceVersion },
    message: document.message,
    origin: document.origin,
    location: { file: document.file, path: document.path },
    reason,
    expected,
    actual,
  };
}

function pathKey(path: readonly number[]): string {
  return path.join("/");
}

function attrsByName(element: HtmlElementInfo): ReadonlyMap<string, string> {
  return new Map(element.attributes.map(({ name, value }) => [name, value]));
}

function structureSummary(parsed: ParsedHtml): readonly JsonValue[] {
  return parsed.elements.map((element) => ({
    path: element.path,
    tag: element.name,
  }));
}

export interface MapHtmlAnalysis {
  readonly findings: readonly MiniMessageFinding[];
  readonly sourceSegments: readonly TranslatableTextSegment[];
  readonly targetSegments: readonly TranslatableTextSegment[];
  readonly supportedHtmlTagRanges: readonly HtmlTagRange[];
}

/** 只处理已经由真实资源字段分类为地图模板的 MiniMessage 文档。 */
export function analyzeMapHtml(
  source: ParsedMiniMessageDocument,
  target: ParsedMiniMessageDocument,
  sourceVersion: string,
): MapHtmlAnalysis {
  const sourceHtml = parseHtml(source);
  const targetHtml = parseHtml(target);
  const findings: MiniMessageFinding[] = [];

  for (const [originDocument, parsed] of [
    [source, sourceHtml],
    [target, targetHtml],
  ] as const) {
    for (const [index, error] of parsed.parserErrors.entries()) {
      findings.push(
        finding(
          originDocument,
          "map-html.structure-invalid",
          { kind: "html-parser-error", index },
          { state: "valid HTML fragment" },
          {
            parserError: error.code,
            position: positionJson(error.position),
          },
          "地图模板 HTML 结构无法被 HTML5 解析器完整接受",
          sourceVersion,
        ),
      );
    }
    for (const [index, issue] of parsed.structuralIssues.entries()) {
      findings.push(
        finding(
          originDocument,
          "map-html.structure-invalid",
          { kind: issue.code, index },
          { state: "complete HTML element" },
          { tag: issue.actual, position: positionJson(issue.position) },
          "地图模板 HTML 元素结构不完整",
          sourceVersion,
        ),
      );
    }
  }

  const sourceStructure = structureSummary(sourceHtml);
  const targetStructure = structureSummary(targetHtml);
  if (JSON.stringify(sourceStructure) !== JSON.stringify(targetStructure)) {
    findings.push(
      finding(
        target,
        "map-html.structure-mismatch",
        { kind: "element-tree" },
        sourceStructure,
        targetStructure,
        "地图 HTML 元素、嵌套位置或属性集合与原文不一致",
        sourceVersion,
      ),
    );
  }

  const targetByPath = new Map(
    targetHtml.elements.map((element) => [pathKey(element.path), element]),
  );
  for (const sourceElement of sourceHtml.elements) {
    const targetElement = targetByPath.get(pathKey(sourceElement.path));
    if (
      targetElement === undefined ||
      targetElement.name !== sourceElement.name
    )
      continue;
    const sourceAttrs = attrsByName(sourceElement);
    const targetAttrs = attrsByName(targetElement);
    for (const name of new Set([
      ...sourceAttrs.keys(),
      ...targetAttrs.keys(),
    ])) {
      const sourceValue = sourceAttrs.get(name);
      const targetValue = targetAttrs.get(name);
      if (sourceValue === undefined || targetValue === undefined) {
        if (sourceValue === targetValue) continue;
        const sourceAttribute = sourceElement.attributes.find(
          (attribute) => attribute.name === name,
        );
        const targetAttribute = targetElement.attributes.find(
          (attribute) => attribute.name === name,
        );
        findings.push(
          finding(
            target,
            "map-html.behavior-attribute-mismatch",
            { elementPath: sourceElement.path, attribute: name },
            {
              tag: sourceElement.name,
              attribute: name,
              state: sourceValue === undefined ? "absent" : "present",
              ...(sourceValue === undefined ? {} : { value: sourceValue }),
              ...(sourceAttribute === undefined
                ? {}
                : { position: positionJson(sourceAttribute.position) }),
            },
            {
              tag: targetElement.name,
              attribute: name,
              state: targetValue === undefined ? "absent" : "present",
              ...(targetValue === undefined ? {} : { value: targetValue }),
              ...(targetAttribute === undefined
                ? {}
                : { position: positionJson(targetAttribute.position) }),
            },
            `地图 HTML 属性 ${name} 的存在状态与原文不一致`,
            sourceVersion,
          ),
        );
        continue;
      }
      if (translatableAttributes.has(name) || targetValue === sourceValue)
        continue;
      const targetAttribute = targetElement.attributes.find(
        (attribute) => attribute.name === name,
      );
      findings.push(
        finding(
          target,
          "map-html.behavior-attribute-mismatch",
          { elementPath: sourceElement.path, attribute: name },
          {
            tag: sourceElement.name,
            attribute: name,
            value: sourceValue,
            ...(sourceElement.attributes.find(
              (attribute) => attribute.name === name,
            ) === undefined
              ? {}
              : {
                  position: positionJson(
                    sourceElement.attributes.find(
                      (attribute) => attribute.name === name,
                    )!.position,
                  ),
                }),
          },
          {
            tag: targetElement.name,
            attribute: name,
            value: targetValue,
            ...(targetAttribute === undefined
              ? {}
              : { position: positionJson(targetAttribute.position) }),
          },
          `地图 HTML 行为属性 ${name} 与原文不一致`,
          sourceVersion,
        ),
      );
    }
  }

  const landColorStyleAttribute = sourceHtml.elements
    .flatMap((element) => element.attributes)
    .find(
      (attribute) =>
        attribute.name === "style" &&
        attribute.value.includes("<v:land_color>"),
    );
  if (landColorStyleAttribute !== undefined) {
    findings.push(
      finding(
        source,
        "map-html.source-attribute-variable-literal",
        { kind: "land-color-attribute" },
        {
          behavior: "HTML attribute MiniMessage variables are expanded",
        },
        {
          sourceVersion,
          attribute: "style",
          position: positionJson(landColorStyleAttribute.position),
          behavior: "attribute placeholder remains literal",
          resolverSuppliesVariable: isKnownMapVariable(
            "land_color",
            sourceVersion,
          ),
        },
        !isKnownMapVariable("land_color", sourceVersion)
          ? "原文在 HTML style 属性中使用 <v:land_color>；8.0.1 未提供此值，且属性内变量不会展开"
          : "原文在 HTML style 属性中使用 <v:land_color>；即使 8.9.2 提供此值，属性内变量仍不会展开",
        sourceVersion,
      ),
    );
  }

  return {
    findings,
    sourceSegments: sourceHtml.segments,
    targetSegments: targetHtml.segments,
    supportedHtmlTagRanges: sourceHtml.projection.htmlTagRanges,
  };
}

export function isMapHtmlParserTag(
  input: string,
  position: number,
  raw: string,
  ranges: readonly HtmlTagRange[],
): boolean {
  return ranges.some(
    (range) =>
      range.start === position &&
      range.raw === raw &&
      input.slice(range.start, range.end) === raw,
  );
}

export function mapHtmlTagRanges(
  input: string,
  nodes: readonly MiniMessageSourceNode[] = [],
): readonly HtmlTagRange[] {
  return parserTagRanges(input, nodes);
}

export function isMapHtmlAttributeTag(
  input: string,
  position: number,
  raw: string,
): boolean {
  return isWithinHtmlAttribute(
    position,
    position + raw.length,
    attributeRanges(input),
  );
}

export function isKnownMapVariable(
  name: string,
  sourceVersion: string,
): boolean {
  return mapVariablesByVersion.get(sourceVersion)?.has(name) ?? false;
}

export function supportsMapHtmlVersion(sourceVersion: string): boolean {
  return mapVariablesByVersion.has(sourceVersion);
}

export function mapHtmlSegments(
  document: ParsedMiniMessageDocument,
): readonly TranslatableTextSegment[] {
  return parseHtml(document).segments;
}
