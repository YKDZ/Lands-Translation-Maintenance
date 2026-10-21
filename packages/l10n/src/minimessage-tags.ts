import type {
  CheckRule,
  JsonValue,
  MiniMessageTagNode,
  ParsedMiniMessageDocument,
  ProjectView,
  RuleFinding,
} from "#/model";
import { canonicalJson, compareText } from "#/value";

const namedColors = new Set([
  "black",
  "dark_blue",
  "dark_green",
  "dark_aqua",
  "dark_red",
  "dark_purple",
  "gold",
  "gray",
  "dark_gray",
  "blue",
  "green",
  "aqua",
  "red",
  "light_purple",
  "yellow",
  "white",
]);

const colorAliases = new Map([
  ["grey", "gray"],
  ["dark_grey", "dark_gray"],
]);

const namedColorHex = new Map([
  ["black", "000000"],
  ["dark_blue", "0000aa"],
  ["dark_green", "00aa00"],
  ["dark_aqua", "00aaaa"],
  ["dark_red", "aa0000"],
  ["dark_purple", "aa00aa"],
  ["gold", "ffaa00"],
  ["gray", "aaaaaa"],
  ["dark_gray", "555555"],
  ["blue", "5555ff"],
  ["green", "55ff55"],
  ["aqua", "55ffff"],
  ["red", "ff5555"],
  ["light_purple", "ff55ff"],
  ["yellow", "ffff55"],
  ["white", "ffffff"],
]);

const prideFlags = new Set([
  "pride",
  "progress",
  "trans",
  "bi",
  "pan",
  "nb",
  "lesbian",
  "ace",
  "agender",
  "demisexual",
  "genderqueer",
  "genderfluid",
  "intersex",
  "aro",
  "baker",
  "philly",
  "queer",
  "gay",
  "bigender",
  "demigender",
]);

const decorationAliases = new Map([
  ["bold", "bold"],
  ["b", "bold"],
  ["italic", "italic"],
  ["em", "italic"],
  ["i", "italic"],
  ["underlined", "underlined"],
  ["u", "underlined"],
  ["strikethrough", "strikethrough"],
  ["st", "strikethrough"],
  ["obfuscated", "obfuscated"],
  ["obf", "obfuscated"],
]);

const standardAliases = new Map([
  ["colour", "color"],
  ["c", "color"],
  ["key", "key"],
  ["translate", "translate"],
  ["lang", "translate"],
  ["tr", "translate"],
  ["translate_or", "translate_or"],
  ["lang_or", "translate_or"],
  ["tr_or", "translate_or"],
  ["insert", "insert"],
  ["font", "font"],
  ["gradient", "gradient"],
  ["rainbow", "rainbow"],
  ["reset", "reset"],
  ["newline", "newline"],
  ["br", "newline"],
  ["transition", "transition"],
  ["selector", "selector"],
  ["sel", "selector"],
  ["score", "score"],
  ["nbt", "nbt"],
  ["data", "nbt"],
  ["pride", "pride"],
  ["shadow", "shadow"],
  ["!shadow", "shadow"],
  ["sprite", "sprite"],
  ["head", "head"],
  ["hover", "hover"],
  ["click", "click"],
]);

const interactionTags = new Set(["click", "hover"]);
const landsControls = new Set([
  "verbose",
  "ingame",
  "java",
  "title",
  "subtitle",
  "actionbar",
  "bossbar",
  "noprefix",
]);
const landsPreprocessors = new Set(["action", "label", "desc", "indent"]);

interface TagSignature {
  readonly name: string;
  readonly parameters: readonly JsonValue[];
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly context: readonly JsonValue[];
}

interface TagOccurrence {
  readonly document: ParsedMiniMessageDocument;
  readonly node: MiniMessageTagNode;
  readonly signature: TagSignature;
  readonly key: string;
}

interface OccurrenceGroup {
  readonly signature: TagSignature;
  readonly occurrences: readonly TagOccurrence[];
}

interface ParsedMessageGroup {
  readonly messageId: string;
  readonly source: readonly ParsedMiniMessageDocument[];
  readonly target: readonly ParsedMiniMessageDocument[];
}

interface TagSemanticContext {
  readonly project: ProjectView;
  readonly nodesByPosition: ReadonlyMap<string, MiniMessageTagNode>;
  readonly landsContextByPosition: ReadonlyMap<string, readonly JsonValue[]>;
}

function normalizeColor(value: string): string {
  const lower = value.toLowerCase();
  const alias = colorAliases.get(lower);
  const named = namedColorHex.get(alias ?? lower);
  if (named !== undefined) return `#${named}`;
  const shortHex = /^#([\da-f])([\da-f])([\da-f])$/u.exec(lower);
  if (shortHex !== null) {
    const red = shortHex[1];
    const green = shortHex[2];
    const blue = shortHex[3];
    return `#${red}${red}${green}${green}${blue}${blue}`;
  }
  return lower;
}

function normalizeResourceKey(value: string): string {
  const lower = value.toLowerCase();
  return lower.includes(":") ? lower : `minecraft:${lower}`;
}

function themeEntry(
  project: ProjectView,
  surface: ParsedMiniMessageDocument["surface"],
  token: string | undefined,
) {
  if (token === undefined) return undefined;
  return [...(project.miniMessage?.themes ?? [])]
    .reverse()
    .find(
      (theme) =>
        theme.surface === surface && theme.name.toLowerCase() === token,
    );
}

function canonicalTagName(node: MiniMessageTagNode): string {
  const name = node.name.toLowerCase();
  if (
    namedColors.has(name) ||
    colorAliases.has(name) ||
    /^#(?:[\da-f]{3}|[\da-f]{6})$/u.test(name)
  ) {
    return "color";
  }
  if (name === "color") return "color";
  if (decorationAliases.has(name)) return decorationAliases.get(name)!;
  if (name.startsWith("!") && decorationAliases.has(name.slice(1))) {
    return decorationAliases.get(name.slice(1))!;
  }
  return standardAliases.get(name) ?? name;
}

function normalizeDecimal(value: string, float32 = false): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  const normalized = float32 ? Math.fround(parsed) : parsed;
  return Object.is(normalized, -0) ? "0" : String(normalized);
}

function colorChangingParameters(
  parameters: readonly string[],
  float32: boolean,
): readonly JsonValue[] {
  const colors = [...parameters];
  let phase = 0;
  const last = colors.at(-1);
  if (
    last !== undefined &&
    last !== "" &&
    colors.length > 0 &&
    Number.isFinite(Number(last))
  ) {
    phase = Number(last);
    colors.pop();
  }
  if (colors.length === 0) colors.push("white", "black");
  if (phase < 0) {
    colors.reverse();
    phase = 1 + phase;
  }
  return [
    ...colors.map(normalizeColor),
    normalizeDecimal(String(phase), float32),
  ];
}

function canonicalParameters(
  node: MiniMessageTagNode,
  project: ProjectView,
  surface: ParsedMiniMessageDocument["surface"],
): readonly JsonValue[] {
  const rawName = node.name.toLowerCase();
  const name = canonicalTagName(node);
  const parameters = [...node.parameters];

  if (name === "color") {
    if (node.closing) return [];
    const color =
      namedColors.has(rawName) ||
      colorAliases.has(rawName) ||
      rawName.startsWith("#")
        ? rawName
        : (parameters.shift() ?? "");
    return [normalizeColor(color)];
  }

  if (
    decorationAliases.has(rawName) ||
    (rawName.startsWith("!") && decorationAliases.has(rawName.slice(1)))
  ) {
    const disabled =
      rawName.startsWith("!") ||
      parameters[0] === "false" ||
      parameters[0] === "off";
    return [disabled ? "false" : "true"];
  }

  if (name === "t") {
    const token = parameters[0]?.toLowerCase();
    const entry = themeEntry(project, surface, token);
    if (entry?.style === undefined)
      return [{ token: token ?? "", state: "style-unavailable" }];
    return [
      {
        color: entry.style.color,
        decorations: Object.fromEntries(
          Object.entries(entry.style.decorations).sort(([left], [right]) =>
            compareText(left, right),
          ),
        ),
      },
    ];
  }

  if (name === "click") {
    return [
      ...(parameters[0] === undefined ? [] : [parameters[0].toLowerCase()]),
      ...(parameters[1] === undefined ? [] : [parameters[1]]),
    ];
  }

  if (name === "hover") {
    const action = parameters[0]?.toLowerCase();
    if (action === "show_text") {
      return [
        action,
        {
          state:
            parameters[1] === undefined ? "missing" : "translatable-content",
        },
      ];
    }
    if (action === "show_entity") {
      return [
        action,
        ...(parameters[1] === undefined
          ? []
          : [normalizeResourceKey(parameters[1])]),
        ...(parameters[2] === undefined ? [] : [parameters[2].toLowerCase()]),
        ...(parameters[3] === undefined
          ? []
          : [{ state: "translatable-content" }]),
      ];
    }
    if (action === "show_item") {
      const item =
        parameters[1] === undefined
          ? undefined
          : normalizeResourceKey(parameters[1]);
      const count =
        parameters[2] === undefined ? "1" : normalizeInteger(parameters[2]);
      const details = parameters.slice(3);
      if (details.length === 1 && details[0]?.startsWith("{")) {
        return [
          action,
          ...(item === undefined ? [] : [item]),
          count,
          details[0],
        ];
      }
      const valuesByKey = new Map<string, string>();
      for (let index = 0; index + 1 < details.length; index += 2) {
        valuesByKey.set(
          normalizeResourceKey(details[index]!),
          details[index + 1]!,
        );
      }
      const encodedDetails: JsonValue[] = [...valuesByKey.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, value]) => [key, value]);
      return [
        action,
        ...(item === undefined ? [] : [item]),
        count,
        ...encodedDetails,
      ];
    }
    return action === undefined ? [] : [action, ...parameters.slice(1, 2)];
  }

  if (name === "translate") {
    return [
      ...parameters.slice(0, 1),
      { translatableArgumentCount: Math.max(0, parameters.length - 1) },
    ];
  }

  if (name === "translate_or") {
    return [
      ...parameters.slice(0, 1),
      {
        state: parameters[1] === undefined ? "missing" : "translatable-content",
      },
      { translatableArgumentCount: Math.max(0, parameters.length - 2) },
    ];
  }

  if (name === "key" || name === "insert" || name === "selector") {
    return parameters.slice(0, 1);
  }

  if (name === "score") return parameters.slice(0, 2);

  if (name === "font" || name === "sprite") {
    if (parameters.length > 1) {
      return name === "font"
        ? [normalizeResourceKey(`${parameters[0]}:${parameters[1]}`)]
        : [
            normalizeResourceKey(parameters[0]!),
            normalizeResourceKey(parameters[1]!),
          ];
    }
    return parameters.slice(0, 1).map(normalizeResourceKey);
  }

  if (name === "nbt") {
    const type = parameters[0]?.toLowerCase();
    const result: JsonValue[] = [type ?? ""];
    const target = parameters[1];
    if (target !== undefined) {
      result.push(type === "storage" ? normalizeResourceKey(target) : target);
    }
    if (parameters[2] !== undefined) result.push(parameters[2]);
    let separatorIndex = 3;
    let interpret = false;
    if (parameters[separatorIndex]?.toLowerCase() === "interpret") {
      interpret = true;
    } else if (parameters[separatorIndex] !== undefined) {
      result.push({ state: "translatable-content" });
      separatorIndex += 1;
      interpret = parameters[separatorIndex]?.toLowerCase() === "interpret";
    }
    if (interpret) result.push("interpret");
    return result;
  }

  if (name === "gradient") return colorChangingParameters(parameters, false);
  if (name === "transition") return colorChangingParameters(parameters, true);

  if (name === "rainbow") {
    const raw = parameters[0] ?? "0";
    const reversed = raw.startsWith("!");
    const phase = raw.slice(reversed ? 1 : 0) || "0";
    return [reversed, normalizeInteger(phase)];
  }

  if (name === "pride") {
    const value = parameters[0]?.toLowerCase() ?? "pride";
    const flag = prideFlags.has(value) ? value : "pride";
    const phase = prideFlags.has(value) ? "0" : value;
    return [flag, normalizeDecimal(phase)];
  }

  if (name === "shadow") {
    if (rawName === "!shadow") return ["disabled"];
    const color = parameters[0];
    if (color === undefined) return [];
    const shadowHex = /^#([\da-f]{6})([\da-f]{2})$/iu.exec(color);
    if (shadowHex !== null)
      return [
        `#${shadowHex[1]!.toLowerCase()}`,
        Number.parseInt(shadowHex[2]!, 16),
      ];
    const alpha = parameters[1] === undefined ? 0.25 : Number(parameters[1]);
    return [
      normalizeColor(color),
      Number.isFinite(alpha)
        ? Math.trunc(Math.fround(alpha) * 255)
        : (parameters[1] ?? "0.25"),
    ];
  }

  if (name === "head") {
    const argument = parameters[0];
    const outerLayer = parameters[1];
    if (argument === undefined) {
      return [
        { state: "empty-head" },
        outerLayer === undefined ? "true" : normalizeHeadBoolean(outerLayer),
      ];
    }
    if (parameters.length === 1) {
      const boolean = headBoolean(argument);
      if (boolean !== undefined) return [{ state: "empty-head" }, boolean];
    }
    const payload =
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89a-f][\da-f]{3}-[\da-f]{12}$/iu.test(
        argument,
      )
        ? { kind: "uuid", value: argument.toLowerCase() }
        : argument.includes("/") &&
            /^[a-z0-9_.-]+:[a-z0-9_./-]+$/iu.test(argument)
          ? { kind: "texture", value: normalizeResourceKey(argument) }
          : { kind: "name", value: argument };
    return [
      payload,
      outerLayer === undefined ? "true" : normalizeHeadBoolean(outerLayer),
    ];
  }

  if (name === "action")
    return parameters.slice(0, 1).map((value) => value.toLowerCase());
  if (name === "title") {
    if (parameters.length === 0) return ["5", "40", "2"];
    return parameters.slice(0, 3).map(normalizeInteger);
  }
  if (name === "bossbar") {
    return [
      (parameters[0] ?? "purple").toLowerCase(),
      (parameters[1] ?? "solid").toLowerCase(),
      normalizeInteger(parameters[2] ?? "6"),
    ];
  }

  if (
    [
      "reset",
      "newline",
      "br",
      "actionbar",
      "subtitle",
      "noprefix",
      "verbose",
      "ingame",
      "java",
      "label",
      "desc",
      "indent",
    ].includes(name)
  )
    return [];

  return parameters;
}

function normalizeInteger(value: string): string {
  if (!/^[+-]?\d+$/u.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? String(parsed) : value;
}

function normalizeHeadBoolean(value: string): string {
  if (value === "true" || value === "on") return "true";
  if (value === "false" || value === "off") return "false";
  return "true";
}

function headBoolean(value: string): string | undefined {
  if (value === "true" || value === "on") return "true";
  if (value === "false" || value === "off") return "false";
  return undefined;
}

function styleProperties(
  node: MiniMessageTagNode,
  project: ProjectView,
  surface: ParsedMiniMessageDocument["surface"],
): ReadonlySet<string> {
  if (node.closing || node.selfClosing) return new Set();
  const rawName = node.name.toLowerCase();
  const name = canonicalTagName(node);
  if (
    name === "color" ||
    ["gradient", "rainbow", "transition", "pride"].includes(name)
  ) {
    return new Set(["color"]);
  }
  if (
    decorationAliases.has(rawName) ||
    (rawName.startsWith("!") && decorationAliases.has(rawName.slice(1)))
  ) {
    return new Set([`decoration:${name}`]);
  }
  if (name === "font") return new Set(["font"]);
  if (name === "shadow") return new Set(["shadow"]);
  if (name === "click") return new Set(["click"]);
  if (name === "hover") return new Set(["hover"]);
  if (name === "insert") return new Set(["insertion"]);
  if (name === "t") {
    const token = node.parameters[0]?.toLowerCase();
    const style = themeEntry(project, surface, token)?.style;
    if (style === undefined) return new Set();
    const properties = new Set<string>();
    if (style.color !== null) properties.add("color");
    for (const [decoration, state] of Object.entries(style.decorations)) {
      if (state !== "not_set") properties.add(`decoration:${decoration}`);
    }
    return properties;
  }
  if (name === "reset") {
    return new Set([
      "color",
      "font",
      "shadow",
      "click",
      "hover",
      "insertion",
      "decoration:bold",
      "decoration:italic",
      "decoration:underlined",
      "decoration:strikethrough",
      "decoration:obfuscated",
    ]);
  }
  return new Set();
}

function nodePositionKey(position: MiniMessageTagNode["position"]): string {
  return `${position.start}:${position.end}`;
}

interface LandsControlAnalysis {
  readonly contextByNodePosition: ReadonlyMap<string, readonly JsonValue[]>;
  readonly findings: readonly RuleFinding[];
}

interface TaggedDocument {
  readonly document: ParsedMiniMessageDocument;
  readonly node: MiniMessageTagNode;
}

function sourceValue(
  project: ProjectView,
  document: ParsedMiniMessageDocument,
): string | undefined {
  const message = project.messages.find(
    (candidate) => candidate.id === document.message.id,
  );
  const value =
    document.origin === "source" ? message?.source : message?.target;
  if (typeof value === "string") return value;
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  if (
    document.message.category === "gui-lore" &&
    document.message.scene === "gui-item-lore"
  ) {
    return value.join("<newline>");
  }
  const itemIndex = document.path[document.message.path.length];
  if (typeof itemIndex === "number") return value[itemIndex];
  return undefined;
}

function controlNodeKey(
  document: ParsedMiniMessageDocument,
  node: MiniMessageTagNode,
): string {
  return `${document.documentIndex}:${nodePositionKey(node.position)}:${node.name}:${node.closing}`;
}

function landsContextKey(
  document: ParsedMiniMessageDocument,
  node: { readonly position: MiniMessageTagNode["position"] },
): string {
  return `${document.documentIndex}:${nodePositionKey(node.position)}`;
}

function addControlContext(
  contexts: Map<string, JsonValue[]>,
  document: ParsedMiniMessageDocument,
  node: { readonly position: MiniMessageTagNode["position"] },
  context: JsonValue,
): void {
  const key = landsContextKey(document, node);
  const values = contexts.get(key) ?? [];
  const encoded = canonicalJson(context);
  if (!values.some((value) => canonicalJson(value) === encoded)) {
    values.push(context);
    contexts.set(key, values);
  }
}

function addContextToRange(
  contexts: Map<string, JsonValue[]>,
  documents: readonly ParsedMiniMessageDocument[],
  start: number,
  end: number,
  context: JsonValue,
): void {
  if (start < 0 || end < start) return;
  for (const document of documents) {
    if (document.status !== "parsed") continue;
    for (const node of document.nodes) {
      if (node.position.start >= start && node.position.end <= end) {
        addControlContext(contexts, document, node, context);
      }
    }
  }
}

function findControlNodes(
  documents: readonly ParsedMiniMessageDocument[],
  name: string,
  start: number,
  end: number,
  closing: boolean,
): readonly TaggedDocument[] {
  return documents.flatMap((document) =>
    document.nodes.flatMap((node) =>
      node.kind === "tag" &&
      node.name.toLowerCase() === name &&
      node.closing === closing &&
      node.position.start === start &&
      node.position.end === end
        ? [{ document, node }]
        : [],
    ),
  );
}

function addControlFinding(
  findings: RuleFinding[],
  document: ParsedMiniMessageDocument,
  name: string,
  occurrence: number,
  reason: string,
  expected: JsonValue,
  actual: JsonValue,
): void {
  findings.push({
    code: "minimessage.lands-control-invalid",
    identity: {
      documentIndex: document.documentIndex,
      tag: name,
      occurrence,
    },
    fingerprint: { tag: name, expected, actual },
    message: document.message,
    origin: document.origin,
    location: { file: document.file, path: document.path },
    reason,
    expected,
    actual,
  });
}

function guiLoreDocument(document: ParsedMiniMessageDocument): boolean {
  return (
    document.message.category === "gui-lore" &&
    document.message.scene === "gui-item-lore" &&
    document.surface === "gui"
  );
}

function chatDocument(document: ParsedMiniMessageDocument): boolean {
  return (
    document.surface === "chat" &&
    (document.message.category === "chat-string" ||
      document.message.category === "chat-string-list")
  );
}

function addConsumedControl(
  documents: readonly ParsedMiniMessageDocument[],
  contexts: Map<string, JsonValue[]>,
  consumed: Set<string>,
  name: string,
  start: number,
  end: number,
  closing: boolean,
  context: JsonValue,
): boolean {
  const matches = findControlNodes(documents, name, start, end, closing);
  if (matches.length === 0) return false;
  for (const match of matches) {
    consumed.add(controlNodeKey(match.document, match.node));
    addControlContext(contexts, match.document, match.node, context);
  }
  return true;
}

function firstTagRange(
  input: string,
  from: number,
  name: string,
): MiniMessageTagNode["position"] | undefined {
  const matcher = new RegExp(`<${name}>`, "ig");
  matcher.lastIndex = from;
  const match = matcher.exec(input);
  if (match === null) return undefined;
  return { start: match.index, end: match.index + match[0].length };
}

function conditionScopes(
  input: string,
  documents: readonly ParsedMiniMessageDocument[],
  contexts: Map<string, JsonValue[]>,
  consumed: Set<string>,
  findings: RuleFinding[],
  root: ParsedMiniMessageDocument,
): void {
  for (const name of ["verbose", "ingame", "java"]) {
    const matcher = new RegExp(`<${name}>(.*?)<\\/${name}>`, "gis");
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(input)) !== null) {
      const openStart = match.index;
      const openEnd = openStart + `<${name}>`.length;
      const closeStart = openStart + match[0].length - `</${name}>`.length;
      const closeEnd = closeStart + `</${name}>`.length;
      const context = { kind: "lands-condition", name };
      const openFound = addConsumedControl(
        documents,
        contexts,
        consumed,
        name,
        openStart,
        openEnd,
        false,
        context,
      );
      const closeFound = addConsumedControl(
        documents,
        contexts,
        consumed,
        name,
        closeStart,
        closeEnd,
        true,
        context,
      );
      if (!chatDocument(root)) {
        addControlFinding(
          findings,
          root,
          name,
          openStart,
          "Lands 条件块只在普通聊天消息中生效",
          { surface: "chat", category: ["chat-string", "chat-string-list"] },
          { tag: match[0], position: openStart, surface: root.surface },
        );
        continue;
      }
      addContextToRange(contexts, documents, openStart, closeEnd, context);
      if (!openFound || !closeFound) {
        addControlFinding(
          findings,
          root,
          name,
          openStart,
          "Lands 条件块无法与官方 MiniMessage 源节点可靠对齐",
          { openAndClose: true },
          { openFound, closeFound, position: openStart },
        );
      }
    }
  }
}

function tagScopeContext(
  contexts: Map<string, JsonValue[]>,
  documents: readonly ParsedMiniMessageDocument[],
  range: MiniMessageTagNode["position"],
  context: JsonValue,
): void {
  addContextToRange(contexts, documents, range.start, range.end, context);
}

function prefixControlScopes(
  input: string,
  root: ParsedMiniMessageDocument,
  documents: readonly ParsedMiniMessageDocument[],
  contexts: Map<string, JsonValue[]>,
  consumed: Set<string>,
  findings: RuleFinding[],
): void {
  if (!chatDocument(root)) return;
  const title = /^<title(?::(\d+):(\d+):(\d+))?>/iu.exec(input);
  const actionbar = /^<actionbar>/iu.exec(input);
  const noPrefix = /^<noprefix>/iu.exec(input);
  const titleContext = { kind: "lands-prefix", name: "title" };
  const actionbarContext = { kind: "lands-prefix", name: "actionbar" };
  let consumedPrefixEnd = 0;

  if (title !== null) {
    consumedPrefixEnd = title[0].length;
    if (
      !addConsumedControl(
        documents,
        contexts,
        consumed,
        "title",
        0,
        consumedPrefixEnd,
        false,
        titleContext,
      )
    ) {
      addControlFinding(
        findings,
        root,
        "title",
        0,
        "Lands title 前缀无法与官方 MiniMessage 源节点可靠对齐",
        { position: 0, form: "<title> or <title:fadeIn:stay:fadeOut>" },
        { tag: title[0], position: 0 },
      );
    }
    const subtitle = firstTagRange(input, consumedPrefixEnd, "subtitle");
    let titleEnd = input.length;
    let subtitleBodyStart: number | undefined;
    if (subtitle !== undefined) {
      titleEnd = subtitle.start;
      subtitleBodyStart = subtitle.end;
      if (
        !addConsumedControl(
          documents,
          contexts,
          consumed,
          "subtitle",
          subtitle.start,
          subtitle.end,
          false,
          { kind: "lands-title-section", name: "subtitle-boundary" },
        )
      ) {
        addControlFinding(
          findings,
          root,
          "subtitle",
          subtitle.start,
          "<subtitle> 只能作为 title 前缀消息的分隔符",
          { context: "title" },
          { position: subtitle.start },
        );
      }
    }
    const actionbarFrom = subtitleBodyStart ?? consumedPrefixEnd;
    const titleActionbar = firstTagRange(input, actionbarFrom, "actionbar");
    const titleBodyEnd =
      subtitle === undefined
        ? (titleActionbar?.start ?? input.length)
        : titleEnd;
    tagScopeContext(
      contexts,
      documents,
      {
        start: consumedPrefixEnd,
        end: titleBodyEnd,
      },
      { kind: "lands-title-section", name: "title" },
    );
    if (subtitleBodyStart !== undefined) {
      const subtitleEnd = titleActionbar?.start ?? input.length;
      tagScopeContext(
        contexts,
        documents,
        {
          start: subtitleBodyStart,
          end: subtitleEnd,
        },
        { kind: "lands-title-section", name: "subtitle" },
      );
    }
    if (titleActionbar !== undefined) {
      if (
        !addConsumedControl(
          documents,
          contexts,
          consumed,
          "actionbar",
          titleActionbar.start,
          titleActionbar.end,
          false,
          { kind: "lands-title-section", name: "actionbar-boundary" },
        )
      ) {
        addControlFinding(
          findings,
          root,
          "actionbar",
          titleActionbar.start,
          "title 中的 <actionbar> 不能与官方源节点可靠对齐",
          { context: "title" },
          { position: titleActionbar.start },
        );
      }
      tagScopeContext(
        contexts,
        documents,
        {
          start: titleActionbar.end,
          end: input.length,
        },
        { kind: "lands-title-section", name: "actionbar" },
      );
    }
    return;
  }

  if (actionbar !== null) {
    consumedPrefixEnd = actionbar[0].length;
    addConsumedControl(
      documents,
      contexts,
      consumed,
      "actionbar",
      0,
      consumedPrefixEnd,
      false,
      actionbarContext,
    );
    tagScopeContext(
      contexts,
      documents,
      {
        start: consumedPrefixEnd,
        end: input.length,
      },
      actionbarContext,
    );
    return;
  }

  let contentStart = 0;
  if (noPrefix !== null) {
    contentStart = noPrefix[0].length;
    addConsumedControl(
      documents,
      contexts,
      consumed,
      "noprefix",
      0,
      contentStart,
      false,
      { kind: "lands-prefix", name: "noprefix" },
    );
  }
  const bossbar = /^<bossbar(?::([a-z_]+)(?::([a-z_]+)(?::(\d+))?)?)?>/iu.exec(
    input.slice(contentStart),
  );
  if (bossbar !== null) {
    const start = contentStart;
    const end = start + bossbar[0].length;
    addConsumedControl(
      documents,
      contexts,
      consumed,
      "bossbar",
      start,
      end,
      false,
      { kind: "lands-prefix", name: "bossbar" },
    );
    tagScopeContext(
      contexts,
      documents,
      {
        start: end,
        end: input.length,
      },
      { kind: "lands-prefix", name: "bossbar" },
    );
  }
}

function actionField(
  documents: readonly ParsedMiniMessageDocument[],
  contexts: Map<string, JsonValue[]>,
  consumed: Set<string>,
  findings: RuleFinding[],
  input: string,
  bodyStart: number,
  body: string,
  name: "label" | "desc",
  action: string,
  occurrence: number,
): void {
  const match = new RegExp(`<${name}>(.*?)<\\/${name}>`, "is").exec(body);
  if (match === null) return;
  const start = bodyStart + match.index;
  const openEnd = start + `<${name}>`.length;
  const closeStart = start + match[0].length - `</${name}>`.length;
  const end = closeStart + `</${name}>`.length;
  const fieldContext = {
    kind: "lands-action-field",
    action,
    field: name,
    occurrence,
  };
  const openFound = addConsumedControl(
    documents,
    contexts,
    consumed,
    name,
    start,
    openEnd,
    false,
    fieldContext,
  );
  const closeFound = addConsumedControl(
    documents,
    contexts,
    consumed,
    name,
    closeStart,
    end,
    true,
    fieldContext,
  );
  tagScopeContext(contexts, documents, { start, end }, fieldContext);
  if (!openFound || !closeFound) {
    const root = documents.find((document) => document.documentIndex === 0);
    if (root !== undefined) {
      addControlFinding(
        findings,
        root,
        name,
        occurrence,
        "GUI lore 动作字段无法与官方 MiniMessage 源节点可靠对齐",
        { action, paired: true },
        { action, openFound, closeFound, position: start, input },
      );
    }
  }
}

function guiLoreControlScopes(
  input: string,
  sourceVersion: string | undefined,
  root: ParsedMiniMessageDocument,
  documents: readonly ParsedMiniMessageDocument[],
  contexts: Map<string, JsonValue[]>,
  consumed: Set<string>,
  findings: RuleFinding[],
): void {
  if (!guiLoreDocument(root)) return;
  const supportedVersion =
    sourceVersion === "8.0.1" || sourceVersion === "8.9.2";
  const actionPattern =
    sourceVersion === "8.9.2"
      ? /<action:([a-z]+)>(.*?)<\/action>(<newline>)?/gis
      : /<action:([a-z]+)>(.*?)<\/action>/gis;
  let occurrence = 0;
  let actionMatch: RegExpExecArray | null;
  while ((actionMatch = actionPattern.exec(input)) !== null) {
    occurrence += 1;
    const action = actionMatch[1]?.toLowerCase();
    const body = actionMatch[2];
    if (action === undefined || body === undefined) continue;
    if (!supportedVersion) {
      addControlFinding(
        findings,
        root,
        "action",
        occurrence,
        `GUI lore action 尚无 ${sourceVersion ?? "未知"} Lands 版本的已核实预处理语义`,
        { sourceVersion: ["8.0.1", "8.9.2"] },
        { tag: actionMatch[0], position: actionMatch.index },
      );
      continue;
    }
    const openRaw = `<action:${actionMatch[1]}>`;
    const openStart = actionMatch.index;
    const openEnd = openStart + openRaw.length;
    const closeOffset = actionMatch[0].search(/<\/action>/iu);
    if (closeOffset < 0) continue;
    const closeStart = openStart + closeOffset;
    const closeEnd = closeStart + "</action>".length;
    const context = { kind: "lands-action", action, occurrence };
    const openFound = addConsumedControl(
      documents,
      contexts,
      consumed,
      "action",
      openStart,
      openEnd,
      false,
      context,
    );
    const closeFound = addConsumedControl(
      documents,
      contexts,
      consumed,
      "action",
      closeStart,
      closeEnd,
      true,
      context,
    );
    tagScopeContext(
      contexts,
      documents,
      { start: openStart, end: closeEnd },
      context,
    );
    if (!openFound || !closeFound) {
      addControlFinding(
        findings,
        root,
        "action",
        occurrence,
        "GUI lore action 无法与官方 MiniMessage 源节点可靠对齐",
        { action, paired: true },
        { tag: actionMatch[0], position: openStart, openFound, closeFound },
      );
    }
    const bodyStart = openEnd;
    actionField(
      documents,
      contexts,
      consumed,
      findings,
      input,
      bodyStart,
      body,
      "label",
      action,
      occurrence,
    );
    if (sourceVersion === "8.9.2") {
      actionField(
        documents,
        contexts,
        consumed,
        findings,
        input,
        bodyStart,
        body,
        "desc",
        action,
        occurrence,
      );
    } else if (/<desc>/iu.test(body)) {
      addControlFinding(
        findings,
        root,
        "desc",
        occurrence,
        "Lands 8.0.1 GUI lore action 没有已核实的 desc 模板语义",
        { sourceVersion: "8.9.2" },
        { action, body, position: bodyStart },
      );
    }
  }

  if (supportedVersion) {
    const indentPattern = /<indent>/giu;
    let indentMatch: RegExpExecArray | null;
    const lineBreaks = [...input.matchAll(/<newline>|<br>|\n/giu)].map(
      (match) => ({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
      }),
    );
    let indentOccurrence = 0;
    while ((indentMatch = indentPattern.exec(input)) !== null) {
      indentOccurrence += 1;
      const start = indentMatch.index;
      const end = start + indentMatch[0].length;
      const lineBreakIndex = lineBreaks.findIndex(
        (lineBreak) => lineBreak.start >= start,
      );
      const previousBreaks =
        lineBreakIndex < 0
          ? lineBreaks.filter((lineBreak) => lineBreak.start < start)
          : lineBreaks
              .slice(0, lineBreakIndex)
              .filter((lineBreak) => lineBreak.start < start);
      const line = previousBreaks.length;
      const previousLineStart =
        line === 0 ? 0 : (previousBreaks.at(-2)?.end ?? 0);
      const previousLineEnd =
        line === 0 ? 0 : (previousBreaks.at(-1)?.start ?? 0);
      const previousIndent =
        input
          .slice(previousLineStart, previousLineEnd)
          .match(/^[ \t]*/u)?.[0] ?? "";
      const context = {
        kind: "lands-indent",
        line,
        previousIndent,
      };
      if (
        !addConsumedControl(
          documents,
          contexts,
          consumed,
          "indent",
          start,
          end,
          false,
          context,
        )
      ) {
        addControlFinding(
          findings,
          root,
          "indent",
          indentOccurrence,
          "GUI lore indent 无法与官方 MiniMessage 源节点可靠对齐",
          { pattern: "<indent>", previousIndent },
          { position: start, tag: indentMatch[0] },
        );
      }
    }
  }
}

function controlAnalysis(
  project: ProjectView,
  documents: readonly ParsedMiniMessageDocument[],
): LandsControlAnalysis {
  const contexts = new Map<string, JsonValue[]>();
  const consumed = new Set<string>();
  const findings: RuleFinding[] = [];
  const roots = documents.filter(
    (document) => document.documentIndex === 0 && document.status === "parsed",
  );
  for (const root of roots) {
    const input = sourceValue(project, root) ?? root.input;
    if (chatDocument(root)) {
      conditionScopes(input, documents, contexts, consumed, findings, root);
      prefixControlScopes(input, root, documents, contexts, consumed, findings);
    }
    if (guiLoreDocument(root)) {
      guiLoreControlScopes(
        input,
        project.sourceVersion,
        root,
        documents,
        contexts,
        consumed,
        findings,
      );
    }
  }

  const findingKeys = new Set<string>();
  const occurrences = new Map<string, number>();
  for (const document of documents) {
    if (document.status !== "parsed") continue;
    for (const node of document.nodes) {
      if (
        node.kind !== "tag" ||
        (!landsControls.has(node.name.toLowerCase()) &&
          !landsPreprocessors.has(node.name.toLowerCase())) ||
        consumed.has(controlNodeKey(document, node))
      ) {
        continue;
      }
      const name = node.name.toLowerCase();
      const key = `${document.origin}:${document.file}:${canonicalJson(document.path)}:${name}:${node.position.start}:${node.position.end}:${node.closing}`;
      if (findingKeys.has(key)) continue;
      findingKeys.add(key);
      const occurrenceKey = `${document.documentIndex}:${name}`;
      const occurrence = occurrences.get(occurrenceKey) ?? 0;
      occurrences.set(occurrenceKey, occurrence + 1);
      const expected = landsControls.has(name)
        ? name === "verbose" || name === "ingame" || name === "java"
          ? { form: `(?is)<${name}>(.*?)</${name}>`, context: "chat" }
          : name === "subtitle"
            ? { context: "title message" }
            : { context: "message prefix" }
        : name === "indent"
          ? { context: "GUI item lore", form: "<indent>" }
          : name === "action"
            ? { context: "GUI item lore", form: "<action:[a-z]+>...</action>" }
            : { context: "inside a supported GUI lore action" };
      const actual: { readonly [key: string]: JsonValue } = {
        tag: node.raw,
        closing: node.closing,
        ...(node.position.start < 0 ? {} : { position: node.position.start }),
        category: document.message.category,
        scene: document.message.scene ?? "",
        sourceVersion: project.sourceVersion ?? "unknown",
      };
      addControlFinding(
        findings,
        document,
        name,
        occurrence,
        landsControls.has(name)
          ? `Lands 控制 <${name}> 的位置、范围或参数不符合已核实读取语义`
          : `Lands 预处理 <${name}> 不在已核实的 GUI lore 动作上下文中`,
        expected,
        actual,
      );
    }
  }
  return { contextByNodePosition: contexts, findings };
}

export function miniMessageTagCoverageUnavailable(
  project: ProjectView,
): readonly string[] {
  const documents = project.miniMessage?.documents ?? [];
  const controls = documents.flatMap((document) =>
    document.nodes.flatMap((node) =>
      node.kind === "tag" &&
      (landsControls.has(node.name.toLowerCase()) ||
        landsPreprocessors.has(node.name.toLowerCase()))
        ? [{ name: node.name.toLowerCase() }]
        : [],
    ),
  );
  if (controls.length === 0) return [];

  const unavailable: string[] = [];
  if (project.sourceVersion !== "8.0.1" && project.sourceVersion !== "8.9.2") {
    unavailable.push(
      `Lands 控制语义只核实了 8.0.1 与 8.9.2；当前版本 ${project.sourceVersion ?? "未知"} 仍需核实`,
    );
  }
  if (
    project.sourceVersion === "8.0.1" &&
    controls.some(({ name }) => name === "desc")
  ) {
    unavailable.push(
      "Lands 8.0.1 GUI lore action 没有 desc 模板语义；相关内容只能报告限制",
    );
  }
  return unavailable;
}

function signatureForContext(
  node: MiniMessageTagNode,
  project: ProjectView,
  surface: ParsedMiniMessageDocument["surface"],
): JsonValue {
  return {
    name: canonicalTagName(node),
    parameters: canonicalParameters(node, project, surface),
    closing: node.closing,
    selfClosing: node.selfClosing,
  };
}

function tagContext(
  node: MiniMessageTagNode,
  document: ParsedMiniMessageDocument,
  semantic: TagSemanticContext,
  extraContext: readonly JsonValue[] = [],
): readonly JsonValue[] {
  const context: JsonValue[] = [];
  for (const frame of node.context) {
    if (frame.kind === "hover-text" || frame.kind === "tag-argument") {
      context.push({ kind: frame.kind, name: frame.name });
      if (frame.kind === "hover-text") {
        const parent = semantic.nodesByPosition.get(
          `${frame.position.start}:${frame.position.end}`,
        );
        if (parent !== undefined && canonicalTagName(parent) === "hover") {
          context.push({
            kind: "interaction",
            tag: signatureForContext(
              parent,
              semantic.project,
              document.surface,
            ),
          });
        }
      }
      continue;
    }
    const parent = semantic.nodesByPosition.get(
      nodePositionKey(frame.position),
    );
    if (parent === undefined) continue;
    const name = canonicalTagName(parent);
    if (interactionTags.has(name)) {
      context.push({
        kind: "interaction",
        tag: signatureForContext(parent, semantic.project, document.surface),
      });
    }
  }

  const ownProperties = styleProperties(
    node,
    semantic.project,
    document.surface,
  );
  if (ownProperties.size > 0) {
    for (const frame of node.context) {
      if (frame.kind !== "tag" && frame.kind !== "hover-text") continue;
      const parent = semantic.nodesByPosition.get(
        `${frame.position.start}:${frame.position.end}`,
      );
      if (parent === undefined || parent.closing) continue;
      const parentName = canonicalTagName(parent);
      const parentProperties = styleProperties(
        parent,
        semantic.project,
        document.surface,
      );
      const shared = [...ownProperties].filter((property) =>
        parentProperties.has(property),
      );
      if (parentName === "reset") shared.push(...ownProperties);
      if (shared.length === 0) continue;
      context.push({
        kind: "style-order",
        tag: signatureForContext(parent, semantic.project, document.surface),
        properties: [...new Set(shared)].sort(compareText),
      });
    }
  }
  return [...context, ...extraContext];
}

function tagOccurrences(
  project: ProjectView,
  documents: readonly ParsedMiniMessageDocument[],
  landsContextByPosition: ReadonlyMap<string, readonly JsonValue[]> = new Map(),
): readonly TagOccurrence[] {
  const occurrences: TagOccurrence[] = [];
  const semanticNodes = (
    node: ParsedMiniMessageDocument["nodes"][number],
  ): readonly MiniMessageTagNode[] => {
    if (node.kind === "tag") return [node];
    return [...node.raw.matchAll(/\n/gu)].map((match) => {
      const offset = match.index!;
      const position =
        node.position.start < 0 ||
        node.position.end - node.position.start !== node.raw.length
          ? { start: -1, end: -1 }
          : {
              start: node.position.start + offset,
              end: node.position.start + offset + 1,
            };
      return {
        kind: "tag",
        raw: "\n",
        name: "newline",
        parameters: [],
        parameterPositions: [],
        closing: false,
        selfClosing: false,
        semanticKind: "content",
        position,
        context: node.context,
      };
    });
  };
  const nodesByPosition = new Map<string, MiniMessageTagNode>();
  for (const document of documents) {
    if (document.status !== "parsed") continue;
    for (const sourceNode of document.nodes) {
      for (const node of semanticNodes(sourceNode)) {
        if (node.kind !== "tag" || node.raw === "") continue;
        const key = nodePositionKey(node.position);
        const current = nodesByPosition.get(key);
        if (current === undefined || (current.closing && !node.closing)) {
          nodesByPosition.set(key, node);
        }
      }
    }
  }
  const semantic = { project, nodesByPosition, landsContextByPosition };
  for (const document of documents) {
    if (document.status !== "parsed") continue;
    for (const sourceNode of document.nodes) {
      for (const node of semanticNodes(sourceNode)) {
        if (node.kind !== "tag" || node.raw === "") continue;
        const signature: TagSignature = {
          name: canonicalTagName(node),
          parameters: canonicalParameters(node, project, document.surface),
          closing: node.closing,
          selfClosing: node.selfClosing,
          context: tagContext(
            node,
            document,
            semantic,
            landsContextByPosition.get(landsContextKey(document, node)) ?? [],
          ),
        };
        occurrences.push({
          document,
          node,
          signature,
          key: canonicalJson(signature),
        });
      }
    }
  }
  return occurrences;
}

function groupOccurrences(
  occurrences: readonly TagOccurrence[],
): ReadonlyMap<string, OccurrenceGroup> {
  const groups = new Map<string, TagOccurrence[]>();
  for (const occurrence of occurrences) {
    const group = groups.get(occurrence.key) ?? [];
    group.push(occurrence);
    groups.set(occurrence.key, group);
  }
  return new Map(
    [...groups.entries()].map(([key, group]) => [
      key,
      { signature: group[0]!.signature, occurrences: group },
    ]),
  );
}

function messageGroups(
  documents: readonly ParsedMiniMessageDocument[],
): readonly ParsedMessageGroup[] {
  const groups = new Map<
    string,
    { source: ParsedMiniMessageDocument[]; target: ParsedMiniMessageDocument[] }
  >();
  for (const document of documents) {
    const key = canonicalJson({
      messageId: document.message.id,
      path: document.path,
    });
    const group = groups.get(key) ?? { source: [], target: [] };
    group[document.origin].push(document);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ source, target }) => ({
    messageId: source[0]?.message.id ?? target[0]!.message.id,
    source,
    target,
  }));
}

function contextArray(context: readonly JsonValue[]): JsonValue {
  return context;
}

function themeDependency(
  project: ProjectView,
  surface: ParsedMiniMessageDocument["surface"],
  token: string,
): JsonValue {
  const entry = [...(project.miniMessage?.themes ?? [])]
    .reverse()
    .find(
      (theme) =>
        theme.surface === surface && theme.name.toLowerCase() === token,
    );
  return entry === undefined
    ? { token, state: "undefined" }
    : {
        token,
        file: entry.file,
        path: entry.path,
        surface: entry.surface,
        name: entry.name,
        source: entry.source,
      };
}

function themeDependencies(
  project: ProjectView,
  occurrences: readonly TagOccurrence[],
): JsonValue {
  return occurrences
    .filter((occurrence) => occurrence.signature.name === "t")
    .map((occurrence) => {
      const token = occurrence.node.parameters[0]?.toLowerCase() ?? "";
      return {
        side: occurrence.document.origin,
        surface: occurrence.document.surface,
        definition: themeDependency(
          project,
          occurrence.document.surface,
          token,
        ),
      };
    });
}

function mismatchFinding(
  project: ProjectView,
  source: OccurrenceGroup | undefined,
  target: OccurrenceGroup | undefined,
  documents: readonly ParsedMiniMessageDocument[],
): RuleFinding {
  const signature = (source ?? target)!.signature;
  const sourceCount = source?.occurrences.length ?? 0;
  const targetCount = target?.occurrences.length ?? 0;
  const targetDocument =
    target?.occurrences[0]?.document ??
    documents.find((item) => item.origin === "target");
  const sourceDocument =
    source?.occurrences[0]?.document ??
    documents.find((item) => item.origin === "source");
  const locationDocument = targetDocument ?? sourceDocument!;
  const occurrence = Math.min(sourceCount, targetCount);
  const affectedOccurrences = [
    ...(source?.occurrences.slice(targetCount) ?? []),
    ...(target?.occurrences.slice(sourceCount) ?? []),
  ];
  const expected: JsonValue = {
    tag: signature.name,
    parameters: signature.parameters,
    closing: signature.closing,
    selfClosing: signature.selfClosing,
    context: contextArray(signature.context),
    expectedCount: sourceCount,
    positions: (source?.occurrences ?? []).map(
      ({ node }) =>
        ({ start: node.position.start, end: node.position.end }) as JsonValue,
    ),
  };
  const actual: JsonValue = {
    tag: signature.name,
    parameters: signature.parameters,
    closing: signature.closing,
    selfClosing: signature.selfClosing,
    context: contextArray(signature.context),
    actualCount: targetCount,
    positions: (target?.occurrences ?? []).map(
      ({ node }) =>
        ({ start: node.position.start, end: node.position.end }) as JsonValue,
    ),
  };
  return {
    code: "minimessage.tag-mismatch",
    identity: {
      documentIndex:
        (target?.occurrences[0] ?? source?.occurrences[0])?.document
          .documentIndex ?? 0,
      signature: {
        tag: signature.name,
        parameters: signature.parameters,
        closing: signature.closing,
        selfClosing: signature.selfClosing,
        context: contextArray(signature.context),
      },
      occurrence,
    },
    fingerprint: {
      tag: signature.name,
      parameters: signature.parameters,
      context: signature.context,
      themes: themeDependencies(project, affectedOccurrences),
    },
    message: locationDocument.message,
    origin: "target",
    location: {
      file: locationDocument.file,
      path: locationDocument.path,
    },
    reason: `译文中的 MiniMessage 标签 <${signature.name}> 出现次数或参数与原文不一致`,
    expected,
    actual,
  };
}

function closeMatches(
  open: MiniMessageTagNode,
  close: MiniMessageTagNode,
): boolean {
  if (open.name.toLowerCase() !== close.name.toLowerCase()) return false;
  if (close.parameters.length > open.parameters.length) return false;
  return close.parameters.every(
    (parameter, index) => open.parameters[index] === parameter,
  );
}

function nestingFindings(
  documents: readonly ParsedMiniMessageDocument[],
): readonly RuleFinding[] {
  const findings: RuleFinding[] = [];
  for (const document of documents) {
    if (document.status !== "parsed") continue;
    const opensByPosition = new Map<string, MiniMessageTagNode>();
    for (const node of document.nodes) {
      if (node.kind === "tag" && !node.closing && !node.selfClosing) {
        opensByPosition.set(
          `${node.position.start}:${node.position.end}`,
          node,
        );
      }
    }
    for (const [occurrence, node] of document.nodes.entries()) {
      if (node.kind !== "tag" || !node.closing) continue;
      if (
        landsControls.has(node.name.toLowerCase()) ||
        landsPreprocessors.has(node.name.toLowerCase())
      ) {
        continue;
      }
      const localContext = node.context.filter(
        (frame) =>
          frame.kind === "tag" &&
          frame.position.start >= document.range.start &&
          frame.position.end <= document.range.end,
      );
      let matchedIndex = -1;
      for (let index = localContext.length - 1; index >= 0; index -= 1) {
        const frame = localContext[index]!;
        const open = opensByPosition.get(
          `${frame.position.start}:${frame.position.end}`,
        );
        if (open !== undefined && closeMatches(open, node)) {
          matchedIndex = index;
          break;
        }
      }
      if (matchedIndex >= 0 && matchedIndex === localContext.length - 1)
        continue;
      const current = canonicalTagName(node);
      const expectedOpen =
        matchedIndex >= 0
          ? localContext[matchedIndex]!.name
          : localContext.at(-1)?.name;
      findings.push({
        code: "minimessage.tag-nesting-invalid",
        identity: {
          documentIndex: document.documentIndex,
          tag: current,
          occurrence,
        },
        fingerprint: {
          closingTag: node.raw,
          context: localContext.map((frame) => frame.name.toLowerCase()),
        },
        message: document.message,
        origin: document.origin,
        location: { file: document.file, path: document.path },
        reason: `MiniMessage 结束标签 </${current}> 与当前嵌套结构不匹配`,
        expected: {
          state: "matching top-level open tag",
          ...(expectedOpen === undefined ? {} : { openTag: expectedOpen }),
        },
        actual: {
          tag: node.raw,
          position: node.position.start,
          context: localContext.map((frame) => frame.name.toLowerCase()),
        },
      });
    }
  }
  return findings;
}

export const miniMessageTagsRule: CheckRule = {
  id: "minimessage-tags",
  defaultSeverity: "error",
  requiredInputs: ["minimessage-parse"],
  evaluate(project) {
    const documents = project.miniMessage?.documents ?? [];
    const findings: RuleFinding[] = [...nestingFindings(documents)];
    for (const group of messageGroups(documents)) {
      const sourceControls = controlAnalysis(project, group.source);
      const targetControls = controlAnalysis(project, group.target);
      findings.push(...sourceControls.findings, ...targetControls.findings);
      const sourceOccurrences = tagOccurrences(
        project,
        group.source,
        sourceControls.contextByNodePosition,
      );
      const targetOccurrences = tagOccurrences(
        project,
        group.target,
        targetControls.contextByNodePosition,
      );
      const sourceGroups = groupOccurrences(sourceOccurrences);
      const targetGroups = groupOccurrences(targetOccurrences);
      const targetDocuments = group.target;
      const allKeys = new Set([...sourceGroups.keys(), ...targetGroups.keys()]);
      for (const key of [...allKeys].sort(compareText)) {
        const source = sourceGroups.get(key);
        const target = targetGroups.get(key);
        if (
          (source?.occurrences.length ?? 0) ===
          (target?.occurrences.length ?? 0)
        ) {
          continue;
        }
        findings.push(
          mismatchFinding(project, source, target, [
            ...group.source,
            ...targetDocuments,
          ]),
        );
      }
    }
    return findings;
  },
};
