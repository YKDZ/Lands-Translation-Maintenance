import type { JsonValue, ProjectView, TranslatableTextDocument } from "#/model";
import { canonicalJson } from "#/value";

function documentOwnershipIdentity(
  project: ProjectView,
  document: TranslatableTextDocument,
): JsonValue | undefined {
  if (document.context.length === 0) return [];
  const parsedDocuments = project.miniMessage?.documents ?? [];
  const owners: JsonValue[] = [];
  for (const frame of document.context) {
    if (frame.kind === "hover-text" || frame.kind === "tag-argument") {
      owners.push({ kind: frame.kind, name: frame.name });
      continue;
    }
    if (frame.kind !== "tag" || frame.name !== "click") continue;
    const matchingTags = parsedDocuments
      .filter(
        (candidate) =>
          candidate.message.id === document.message.id &&
          candidate.origin === document.origin,
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
    const owner = matchingTags.find((node) => node.kind === "tag");
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

export function pairedTextDocuments(project: ProjectView): readonly {
  readonly sourceDocument: TranslatableTextDocument;
  readonly targetDocument: TranslatableTextDocument;
}[] {
  const groups = new Map<
    string,
    {
      readonly source: TranslatableTextDocument[];
      readonly target: TranslatableTextDocument[];
    }
  >();
  for (const document of project.miniMessage?.translatableText ?? []) {
    const ownership = documentOwnershipIdentity(project, document);
    if (ownership === undefined) continue;
    const key = canonicalJson([document.message.id, document.path, ownership]);
    let group = groups.get(key);
    if (group === undefined) {
      group = { source: [], target: [] };
      groups.set(key, group);
    }
    group[document.origin].push(document);
  }
  return [...groups.values()]
    .filter(({ source, target }) => source.length === 1 && target.length === 1)
    .map(({ source, target }) => ({
      sourceDocument: source[0]!,
      targetDocument: target[0]!,
    }));
}
