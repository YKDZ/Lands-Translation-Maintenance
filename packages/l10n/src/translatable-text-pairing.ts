import type {
  MiniMessageContextFrame,
  MiniMessageIncompleteFact,
  MiniMessageParseProject,
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
    if (frame.kind === "hover-text" || frame.kind === "tag-argument") {
      owners.push({ kind: frame.kind, name: frame.name });
      continue;
    }
    if (frame.kind !== "tag" || frame.name !== "click") continue;
    const matchingTags = project.documents
      .filter(
        (candidate) =>
          candidate.message.id === document.message.id &&
          candidate.origin === document.origin &&
          candidate.file === document.file &&
          candidate.path.length <= document.path.length &&
          canonicalJson(candidate.path) ===
            canonicalJson(document.path.slice(0, candidate.path.length)),
      )
      .flatMap((candidate) => candidate.nodes)
      .filter(
        (node) =>
          node.kind === "tag" &&
          node.name === frame.name &&
          !node.closing &&
          node.position.start === frame.position.start &&
          node.position.end === frame.position.end,
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
