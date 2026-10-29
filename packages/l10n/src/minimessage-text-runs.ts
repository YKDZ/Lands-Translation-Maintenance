import type {
  MiniMessageContextFrame,
  MiniMessageParseProject,
  MiniMessagePosition,
  TranslatableTextDocument,
} from "#/mini-message-model";
import type { JsonValue } from "#/model";
import { translatableTextOwnerIdentity } from "#/translatable-text-pairing";
import { canonicalJson } from "#/value";

export interface MiniMessageTextPart {
  readonly start: number;
  readonly end: number;
  readonly position: MiniMessagePosition;
}

export interface MiniMessageTextRun {
  readonly text: string;
  readonly parts: readonly MiniMessageTextPart[];
  readonly contextKey: string;
}

/** 复用正文 runs 的稳定规则，为独立变量和正文片段提供所属上下文。 */
export function miniMessageTextContextKeyResolver(
  project: MiniMessageParseProject,
  document: TranslatableTextDocument,
): (context: readonly MiniMessageContextFrame[]) => string {
  const elementFrames = new Map<
    string,
    { readonly frame: MiniMessageContextFrame; parentKey?: string }
  >();
  for (const segment of document.segments) {
    for (const frame of segment.context) {
      if (frame.kind !== "html-element") continue;
      const key = `${frame.position.start}:${frame.position.end}:${frame.name}`;
      elementFrames.set(key, { frame });
    }
  }
  const orderedElements = [...elementFrames.entries()].sort(
    ([leftKey, left], [rightKey, right]) =>
      left.frame.position.start - right.frame.position.start ||
      right.frame.position.end - left.frame.position.end ||
      leftKey.localeCompare(rightKey),
  );
  for (const [, element] of orderedElements) {
    const parents = orderedElements.filter(([, candidate]) => {
      const parent = candidate.frame.position;
      const child = element.frame.position;
      return (
        parent.start <= child.start &&
        parent.end >= child.end &&
        (parent.start < child.start || parent.end > child.end)
      );
    });
    const parent = parents.sort(
      ([leftKey, left], [rightKey, right]) =>
        left.frame.position.end -
          left.frame.position.start -
          (right.frame.position.end - right.frame.position.start) ||
        leftKey.localeCompare(rightKey),
    )[0];
    if (parent !== undefined) element.parentKey = parent[0];
  }

  const elementIdentities = new Map<string, string>();
  const siblingOrdinals = new Map<string, number>();
  for (const [key, element] of orderedElements) {
    const parentIdentity =
      element.parentKey === undefined
        ? "root"
        : (elementIdentities.get(element.parentKey) ?? "root");
    const siblingKey = `${parentIdentity}\0${element.frame.name}`;
    const ordinal = siblingOrdinals.get(siblingKey) ?? 0;
    siblingOrdinals.set(siblingKey, ordinal + 1);
    elementIdentities.set(
      key,
      `${parentIdentity}/${element.frame.name}[${ordinal}]`,
    );
  }

  const contextKey = (context: readonly MiniMessageContextFrame[]): string => {
    const frames: string[] = [];
    for (const [index, frame] of context.entries()) {
      if (frame.kind === "tag") {
        if (frame.name === "click") {
          const owner = translatableTextOwnerIdentity(project, document, [
            frame,
          ]);
          frames.push(
            `tag:click-owner:${canonicalJson(owner ?? { state: "unknown-owner" })}`,
          );
        }
        continue;
      }
      if (frame.kind === "html-element") {
        const key = `${frame.position.start}:${frame.position.end}:${frame.name}`;
        frames.push(`html-element:${elementIdentities.get(key) ?? frame.name}`);
        continue;
      }
      if (frame.kind === "html-attribute") {
        const owner = context
          .slice(0, index)
          .findLast((candidate) => candidate.kind === "html-element");
        const ownerIdentity =
          owner === undefined
            ? "root"
            : (elementIdentities.get(
                `${owner.position.start}:${owner.position.end}:${owner.name}`,
              ) ?? owner.name);
        frames.push(`html-attribute:${ownerIdentity}:${frame.name}`);
        continue;
      }
      frames.push(`${frame.kind}:${frame.name}`);
    }
    return canonicalJson(frames);
  };

  return contextKey;
}

export function miniMessageTextRuns(
  project: MiniMessageParseProject,
  document: TranslatableTextDocument,
): readonly MiniMessageTextRun[] {
  const contextKey = miniMessageTextContextKeyResolver(project, document);
  const runs: MiniMessageTextRun[] = [];
  let text = "";
  let parts: MiniMessageTextPart[] = [];
  let currentContextKey: string | undefined;

  const flush = () => {
    if (text !== "" && currentContextKey !== undefined) {
      runs.push({ text, parts, contextKey: currentContextKey });
    }
    text = "";
    parts = [];
  };

  for (const segment of document.segments) {
    const nextContextKey = contextKey(segment.context);
    if (segment.kind !== "text") {
      flush();
      currentContextKey = nextContextKey;
      continue;
    }
    if (
      currentContextKey !== undefined &&
      currentContextKey !== nextContextKey
    ) {
      flush();
    }
    currentContextKey = nextContextKey;
    const start = text.length;
    text += segment.value;
    parts.push({
      start,
      end: text.length,
      position: segment.position,
    });
  }
  flush();
  return runs;
}

/** 把可见正文区间还原成原文中一个或多个 UTF-16 区间。 */
export function positionsForTextRun(
  run: MiniMessageTextRun,
  start: number,
  end: number,
): readonly MiniMessagePosition[] {
  return run.parts.flatMap((part) => {
    const overlapStart = Math.max(part.start, start);
    const overlapEnd = Math.min(part.end, end);
    if (overlapStart >= overlapEnd) return [];
    const sourceLength = part.position.end - part.position.start;
    const textLength = part.end - part.start;
    if (sourceLength !== textLength) return [part.position];
    return [
      {
        start: part.position.start + overlapStart - part.start,
        end: part.position.start + overlapEnd - part.start,
      },
    ];
  });
}

export function sameTranslatableText(
  source: TranslatableTextDocument,
  target: TranslatableTextDocument,
): boolean {
  return (
    canonicalJson(
      source.segments.map(({ kind, value }) => ({ kind, value })),
    ) ===
    canonicalJson(target.segments.map(({ kind, value }) => ({ kind, value })))
  );
}

export function textRunReference(
  document: TranslatableTextDocument,
  run: MiniMessageTextRun,
): JsonValue {
  return {
    messageId: document.message.id,
    documentIndex: document.documentIndex,
    origin: document.origin,
    file: document.file,
    path: [...document.path],
    documentRange: { ...document.range },
    contextKey: run.contextKey,
    positions: run.parts.map(({ start, end, position }) => ({
      start,
      end,
      position: { ...position },
    })),
  };
}
