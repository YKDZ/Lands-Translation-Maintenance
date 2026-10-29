import type {
  MiniMessageContextFrame,
  MiniMessageIncompleteFact,
  MiniMessageParseProject,
  ParsedMiniMessageDocument,
  TranslatableTextDocument,
} from "#/mini-message-model";
import type { JsonValue } from "#/model";
import { canonicalJson } from "#/value";

export interface TranslatableTextPairing {
  readonly pairs: readonly {
    readonly sourceDocument: TranslatableTextDocument;
    readonly targetDocument: TranslatableTextDocument;
  }[];
  readonly incomplete: readonly MiniMessageIncompleteFact[];
}

function samePosition(
  left: { readonly start: number; readonly end: number },
  right: { readonly start: number; readonly end: number },
): boolean {
  return left.start === right.start && left.end === right.end;
}

function documentsFor(
  project: MiniMessageParseProject,
  document: Pick<
    TranslatableTextDocument,
    "message" | "origin" | "path" | "file"
  >,
): readonly ParsedMiniMessageDocument[] {
  return project.documents.filter(
    (candidate) =>
      candidate.message.id === document.message.id &&
      candidate.origin === document.origin &&
      candidate.file === document.file &&
      candidate.path.length <= document.path.length &&
      canonicalJson(candidate.path) ===
        canonicalJson(document.path.slice(0, candidate.path.length)),
  );
}

type IdenticalFieldHoverOwner =
  | { readonly state: "identified"; readonly identity: JsonValue }
  | { readonly state: "different" }
  | { readonly state: "unknown" };

function identicalFieldHoverOwner(
  project: MiniMessageParseProject,
  document: Pick<TranslatableTextDocument, "message" | "path">,
  frame: MiniMessageContextFrame,
): IdenticalFieldHoverOwner {
  const { message } = document;
  if (
    message.targetStatus !== "present" ||
    message.target === undefined ||
    canonicalJson(message.source) !== canonicalJson(message.target)
  ) {
    return { state: "different" };
  }

  const rootsFor = (origin: "source" | "target") =>
    project.documents.filter(
      (candidate) =>
        candidate.message.id === message.id &&
        candidate.origin === origin &&
        candidate.documentIndex === 0 &&
        candidate.path.length <= document.path.length &&
        canonicalJson(candidate.path) ===
          canonicalJson(document.path.slice(0, candidate.path.length)),
    );
  const sourceRoots = rootsFor("source");
  const targetRoots = rootsFor("target");
  if (sourceRoots.length !== 1 || targetRoots.length !== 1) {
    return { state: "unknown" };
  }

  const sourceRoot = sourceRoots[0]!;
  const targetRoot = targetRoots[0]!;
  if (
    sourceRoot.status !== "parsed" ||
    targetRoot.status !== "parsed" ||
    sourceRoot.input !== targetRoot.input ||
    sourceRoot.surface !== targetRoot.surface ||
    !samePosition(sourceRoot.range, targetRoot.range) ||
    canonicalJson(sourceRoot.context) !== canonicalJson(targetRoot.context)
  ) {
    return { state: "unknown" };
  }

  const hoverNodes = (root: ParsedMiniMessageDocument) =>
    root.nodes.filter(
      (node) =>
        node.kind === "tag" &&
        node.name === "hover" &&
        !node.closing &&
        samePosition(node.position, frame.position),
    );
  const sourceHovers = hoverNodes(sourceRoot);
  const targetHovers = hoverNodes(targetRoot);
  if (sourceHovers.length !== 1 || targetHovers.length !== 1) {
    return { state: "unknown" };
  }

  const sourceHover = sourceHovers[0]!;
  const targetHover = targetHovers[0]!;
  if (
    sourceHover.kind !== "tag" ||
    targetHover.kind !== "tag" ||
    canonicalJson(sourceHover.context) !== canonicalJson(targetHover.context)
  ) {
    return { state: "unknown" };
  }
  return {
    state: "identified",
    identity: {
      kind: "identical-field-hover",
      name: sourceHover.name,
      position: { ...frame.position },
      context: sourceHover.context.map(({ kind, name, position }) => ({
        kind,
        name,
        position: { ...position },
      })),
    },
  };
}

type HoverHostClick =
  | { readonly state: "identified"; readonly identity: JsonValue }
  | { readonly state: "none" }
  | { readonly state: "unknown" };

/** 通过官方解析节点的位置与上下文确认 hover 所属的 click 组件。 */
function hoverHostClick(
  project: MiniMessageParseProject,
  document: Pick<
    TranslatableTextDocument,
    "message" | "origin" | "path" | "file"
  >,
  frame: MiniMessageContextFrame,
): HoverHostClick {
  const matchingDocuments = documentsFor(project, document).filter(
    (candidate) =>
      candidate.nodes.some(
        (node) =>
          node.kind === "tag" &&
          node.name === "hover" &&
          !node.closing &&
          samePosition(node.position, frame.position),
      ),
  );
  if (matchingDocuments.length !== 1) return { state: "unknown" };

  const [ownerDocument] = matchingDocuments;
  if (ownerDocument === undefined) return { state: "unknown" };
  const hostClicks = ownerDocument.nodes.filter((node) => {
    if (node.kind !== "tag" || node.name !== "click" || node.closing) {
      return false;
    }
    const frameIndex = node.context.findIndex(
      (candidate) =>
        candidate.kind === "tag" &&
        candidate.name === "hover" &&
        samePosition(candidate.position, frame.position),
    );
    return (
      frameIndex >= 0 &&
      !node.context
        .slice(frameIndex + 1)
        .some(
          (candidate) => candidate.kind === "tag" && candidate.name === "click",
        )
    );
  });
  if (hostClicks.length === 0) return { state: "none" };
  if (hostClicks.length !== 1) return { state: "unknown" };

  const [click] = hostClicks;
  if (click?.kind !== "tag" || click.parameters.length === 0) {
    return { state: "unknown" };
  }
  return {
    state: "identified",
    identity: {
      kind: "hover-host-click",
      name: click.name,
      parameters: click.parameters,
    },
  };
}

export function translatableTextOwnerIdentity(
  project: MiniMessageParseProject,
  document: Pick<
    TranslatableTextDocument,
    "message" | "origin" | "path" | "file"
  >,
  context: readonly MiniMessageContextFrame[],
): JsonValue | undefined {
  if (context.length === 0) return [];
  const owners: JsonValue[] = [];
  for (const frame of context) {
    if (frame.kind === "hover-text") {
      owners.push({ kind: frame.kind, name: frame.name });
      const hostClick = hoverHostClick(project, document, frame);
      if (hostClick.state === "unknown") return undefined;
      if (hostClick.state === "identified") owners.push(hostClick.identity);
      if (hostClick.state === "none") {
        const identicalOwner = identicalFieldHoverOwner(
          project,
          document,
          frame,
        );
        if (identicalOwner.state === "unknown") return undefined;
        if (identicalOwner.state === "identified") {
          owners.push(identicalOwner.identity);
        }
      }
      continue;
    }
    if (frame.kind === "tag-argument") {
      owners.push({ kind: frame.kind, name: frame.name });
      continue;
    }
    if (frame.kind !== "tag" || frame.name !== "click") continue;
    const matchingTags = documentsFor(project, document)
      .flatMap((candidate) => candidate.nodes)
      .filter(
        (node) =>
          node.kind === "tag" &&
          node.name === frame.name &&
          !node.closing &&
          samePosition(node.position, frame.position),
      );
    if (matchingTags.length !== 1) return undefined;
    const owner = matchingTags[0];
    if (owner?.kind !== "tag" || owner.parameters.length === 0)
      return undefined;
    owners.push({
      kind: "tag-owner",
      name: owner.name,
      parameters: owner.parameters,
    });
  }
  return owners.length === 0 ? undefined : owners;
}

export function pairTranslatableTextDocuments(
  project: MiniMessageParseProject,
): TranslatableTextPairing {
  const groups = new Map<
    string,
    {
      readonly source: TranslatableTextDocument[];
      readonly target: TranslatableTextDocument[];
    }
  >();
  const incomplete: MiniMessageIncompleteFact[] = [];
  for (const document of project.translatableText) {
    const ownership = translatableTextOwnerIdentity(
      project,
      document,
      document.context,
    );
    if (ownership === undefined) {
      incomplete.push({
        code: "minimessage.text-owner-unknown",
        message: document.message,
        origin: document.origin,
        location: { file: document.file, path: document.path },
        reason: "正文所属的 click 或标签参数无法唯一确定",
      });
      continue;
    }
    const key = canonicalJson([document.message.id, document.path, ownership]);
    let group = groups.get(key);
    if (group === undefined) {
      group = { source: [], target: [] };
      groups.set(key, group);
    }
    group[document.origin].push(document);
  }

  const pairs: {
    sourceDocument: TranslatableTextDocument;
    targetDocument: TranslatableTextDocument;
  }[] = [];
  for (const { source, target } of groups.values()) {
    if (source.length === 1 && target.length === 1) {
      pairs.push({ sourceDocument: source[0]!, targetDocument: target[0]! });
      continue;
    }
    if (
      source.length === 1 &&
      target.length === 0 &&
      hasExplicitEmptyTranslation(source[0]!)
    ) {
      continue;
    }
    for (const document of [...source, ...target]) {
      incomplete.push({
        code: "minimessage.text-pair-not-unique",
        message: document.message,
        origin: document.origin,
        location: { file: document.file, path: document.path },
        reason:
          source.length === 0 || target.length === 0
            ? "正文范围缺少唯一的原文或译文配对"
            : "同一所属范围存在多个原文或译文文档",
      });
    }
  }
  return { pairs, incomplete };
}

export function hasExplicitEmptyTranslation(
  document: TranslatableTextDocument,
): boolean {
  const { message, path } = document;
  if (message.targetStatus !== "present") return false;
  if (
    path.length === message.path.length &&
    canonicalJson(path) === canonicalJson(message.path)
  ) {
    return message.target === "";
  }
  if (
    !Array.isArray(message.source) ||
    !Array.isArray(message.target) ||
    path.length !== message.path.length + 1 ||
    canonicalJson(path.slice(0, message.path.length)) !==
      canonicalJson(message.path)
  ) {
    return false;
  }
  const itemIndex = path.at(-1);
  return (
    typeof itemIndex === "number" &&
    (itemIndex >= message.target.length || message.target[itemIndex] === "")
  );
}
