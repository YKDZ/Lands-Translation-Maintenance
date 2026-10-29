import type {
  ResourcePurpose,
  TranslationFieldCategory,
  TranslationFormat,
} from "#/lioni/lands-model";

/** 将已登记的 Lands 聊天字段关联到其具体格式语义。 */
export function formatForMessagePath(
  path: readonly string[],
  category: TranslationFieldCategory,
  purpose: ResourcePurpose | undefined,
): Extract<TranslationFormat, "legacy-variable-minimessage" | "map-html-minimessage"> | undefined {
  if (category !== "chat-string" || purpose !== "chat-language") {
    return undefined;
  }

  if (
    (path.length === 5 &&
      path[0] === "general" &&
      path[1] === "land" &&
      path[2] === "title" &&
      path[3] === "land" &&
      (path[4] === "normal" || path[4] === "levels-disabled")) ||
    (path.length === 4 &&
      path[0] === "general" &&
      path[1] === "land" &&
      path[2] === "title" &&
      (path[3] === "camp" || path[3] === "admin"))
  ) {
    return "legacy-variable-minimessage";
  }

  const mapNames = new Set(["dynmap", "bluemap", "squaremap", "pl3xmap"]);
  if (
    path.length === 5 &&
    path[0] === "general" &&
    path[1] === "integration" &&
    mapNames.has(path[2]!) &&
    path[3] === "land" &&
    (path[4] === "description" || path[4] === "spawn")
  ) {
    return "map-html-minimessage";
  }
  if (
    path.length === 5 &&
    path[0] === "general" &&
    path[1] === "integration" &&
    mapNames.has(path[2]!) &&
    ((path[3] === "nation" && path[4] === "description") ||
      (path[3] === "capital" && path[4] === "spawn"))
  ) {
    return "map-html-minimessage";
  }
  return undefined;
}
