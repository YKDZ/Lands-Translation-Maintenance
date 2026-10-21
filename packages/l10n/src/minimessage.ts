import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptLegacyMiniMessageInput } from "#/legacy-format";
import {
  analyzeMapHtml,
  isMapHtmlAttributeTag,
  isKnownMapVariable,
  isMapHtmlParserTag,
  mapHtmlSegments,
  mapHtmlTagRanges,
  supportsMapHtmlVersion,
} from "#/map-html";
import type {
  AdaptedMiniMessageInput,
  JsonValue,
  MiniMessageContextFrame,
  MiniMessageFinding,
  MiniMessageParseProject,
  MiniMessagePosition,
  MiniMessageSourceNode,
  MiniMessageSurface,
  MiniMessageTagNode,
  MiniMessageThemeEntry,
  MiniMessageThemeSnapshot,
  ObservedMessage,
  ParsedMiniMessageDocument,
  ResourceInventoryEntry,
  TranslatableTextDocument,
  TranslatableTextSegment,
} from "#/model";
import { parseYaml } from "#/yaml-data";

interface ThemeDefinition {
  readonly index: number;
  readonly file: string;
  readonly path: readonly (string | number)[];
  readonly surface: MiniMessageSurface;
  readonly name: string;
  readonly source: string;
}

interface MessageInput {
  readonly index: number;
  readonly message: ObservedMessage;
  readonly origin: "source" | "target";
  readonly surface: MiniMessageSurface;
  readonly file: string;
  readonly path: readonly (string | number)[];
  readonly input: string;
  readonly adapted: AdaptedMiniMessageInput;
  readonly legacyAdapterUnsupported: boolean;
  readonly legacyIssues: readonly {
    readonly code: string;
    readonly position: MiniMessagePosition;
    readonly expected: string;
    readonly actual: string;
  }[];
  readonly range: MiniMessagePosition;
}

interface ThemeParseResult {
  readonly definitions: readonly ThemeDefinition[];
  readonly entries: readonly MiniMessageThemeEntry[];
  readonly findings: readonly MiniMessageFinding[];
}

interface JavaThemeResult {
  readonly index: number;
  readonly ok: boolean;
  readonly style?: {
    readonly color: string | null;
    readonly decorations: Readonly<
      Record<string, "true" | "false" | "not_set">
    >;
  };
  readonly error?: string;
  readonly start: number;
  readonly end: number;
}

interface JavaMessageResult {
  readonly index: number;
  readonly status: "ok" | "invalid" | "failed";
  readonly plainText?: string;
  readonly error?: string;
  readonly start: number;
  readonly end: number;
}

interface JavaUnresolvedTag {
  readonly messageIndex: number;
  readonly documentIndex: number;
  readonly name: string;
  readonly position: number;
  readonly detail: string;
  readonly raw: string;
  readonly context: readonly MiniMessageContextFrame[];
}

interface JavaSourceDocument {
  readonly messageIndex: number;
  readonly documentIndex: number;
  readonly parentDocumentIndex: number;
  readonly range: MiniMessagePosition;
  readonly context: readonly MiniMessageContextFrame[];
  readonly nodes: readonly MiniMessageSourceNode[];
}

interface JavaParseResult {
  readonly themes: ReadonlyMap<number, JavaThemeResult>;
  readonly messages: ReadonlyMap<number, JavaMessageResult>;
  readonly documents: readonly JavaSourceDocument[];
  readonly unresolved: readonly JavaUnresolvedTag[];
  readonly warnings: readonly {
    readonly messageIndex: number;
    readonly reason: string;
  }[];
  readonly unavailable?: string;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(moduleDirectory, "..");
const helperDirectory = join(packageDirectory, "target", "minimessage");
const helperJar = join(helperDirectory, "lands-l10n-minimessage.jar");
const dependencyDirectory = join(helperDirectory, "deps");
const dependencyLock = join(helperDirectory, "DEPENDENCIES.json");

const surfaceOverrides = [
  "gui",
  "dialog",
  "bedrock",
] as const satisfies readonly MiniMessageSurface[];
const guiScenes = new Set([
  "gui-general",
  "gui-title",
  "gui-item-name",
  "gui-item-lore",
  "category-name",
  "category-description",
  "level-title",
  "level-attribute-description",
  "level-requirement-title",
  "level-requirement-description",
  "role-name",
]);
const dialogScenes = new Set([
  "dialog-title",
  "dialog-button-label",
  "dialog-button-tooltip",
  "dialog-input-label",
  "dialog-body-text",
]);
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
const standardTags = new Set([
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
  "color",
  "colour",
  "c",
  "grey",
  "dark_grey",
  "gradient",
  "rainbow",
  "transition",
  "reset",
  "bold",
  "b",
  "italic",
  "em",
  "i",
  "underlined",
  "u",
  "strikethrough",
  "st",
  "obfuscated",
  "obf",
  "!bold",
  "!b",
  "!italic",
  "!em",
  "!i",
  "!underlined",
  "!u",
  "!strikethrough",
  "!st",
  "!obfuscated",
  "!obf",
  "key",
  "translate",
  "lang",
  "tr",
  "translate_or",
  "lang_or",
  "tr_or",
  "insert",
  "font",
  "selector",
  "sel",
  "score",
  "nbt",
  "data",
  "newline",
  "br",
  "click",
  "hover",
  "pride",
  "shadow",
  "!shadow",
  "head",
  "sprite",
]);

function isRecord(value: JsonValue | undefined): value is {
  readonly [key: string]: JsonValue;
} {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function styleKind(name: string): MiniMessageTagNode["semanticKind"] {
  if (name === "t") return "style";
  if (name === "v") return "content";
  if (landsControls.has(name)) return "lands-control";
  if (landsPreprocessors.has(name)) return "lands-preprocess";
  if (standardTags.has(name) || /^#[\da-f]{3,8}$/iu.test(name)) {
    if (
      [
        "key",
        "lang",
        "lang_or",
        "translate",
        "translate_or",
        "tr",
        "tr_or",
        "sel",
        "selector",
        "score",
        "nbt",
        "data",
        "newline",
        "br",
        "head",
        "sprite",
      ].includes(name)
    ) {
      return "content";
    }
    return "style";
  }
  return "unknown";
}

function themeFinding(
  file: string,
  path: readonly (string | number)[],
  code: string,
  reason: string,
  expected: JsonValue,
  actual: JsonValue,
): MiniMessageFinding {
  return {
    code,
    origin: "theme",
    location: { file, path },
    reason,
    expected,
    actual,
  };
}

function parseTheme(
  snapshot: MiniMessageThemeSnapshot | undefined,
): ThemeParseResult {
  if (snapshot === undefined) {
    return {
      definitions: [],
      entries: [],
      findings: [],
    };
  }
  const yaml = parseYaml(snapshot.source, snapshot.file);
  if (!yaml.ok) {
    return {
      definitions: [],
      entries: [],
      findings: yaml.issues.map((issue) => ({
        code: issue.code,
        origin: "theme",
        location: {
          file: issue.file,
          path: issue.path,
          ...(issue.line === undefined ? {} : { line: issue.line }),
          ...(issue.column === undefined ? {} : { column: issue.column }),
        },
        reason: `主题 YAML 无法可靠解析：${issue.reason}`,
        expected: { state: "unambiguous YAML" },
        actual: { issue: issue.code },
      })),
    };
  }

  const findings: MiniMessageFinding[] = [];
  const definitions: ThemeDefinition[] = [];
  const entries: MiniMessageThemeEntry[] = [];
  const themeFile = snapshot.file;
  let nextIndex = 0;
  const root = yaml.parsed.value;
  const theme = isRecord(root) ? root.theme : undefined;
  if (!isRecord(theme)) {
    return {
      definitions,
      entries,
      findings: [
        themeFinding(
          themeFile,
          ["theme"],
          "minimessage.theme-invalid",
          "主题文件缺少 theme 映射，无法读取主题 token",
          { state: "mapping" },
          theme ?? { state: "missing" },
        ),
      ],
    };
  }

  function appendSection(
    sectionValue: JsonValue | undefined,
    sectionPath: readonly (string | number)[],
    surfaces: readonly MiniMessageSurface[],
    required: boolean,
  ): void {
    if (sectionValue === undefined && !required) return;
    if (!isRecord(sectionValue)) {
      findings.push(
        themeFinding(
          themeFile,
          sectionPath,
          "minimessage.theme-invalid",
          "主题 token 区段必须是映射",
          { state: "mapping" },
          sectionValue ?? { state: "missing" },
        ),
      );
      return;
    }
    for (const originalName of Object.keys(sectionValue).sort()) {
      const value = sectionValue[originalName]!;
      const path = [...sectionPath, originalName];
      const name = originalName.toLowerCase();
      if (!/^[a-z0-9_-]+$/u.test(name)) {
        findings.push(
          themeFinding(
            themeFile,
            path,
            "minimessage.theme-name-invalid",
            "主题 token 名必须只含小写字母、数字、下划线或连字符",
            "[a-z0-9_-]+",
            originalName,
          ),
        );
        continue;
      }
      const source =
        value === null
          ? ""
          : typeof value === "string"
            ? value.trim() === ""
              ? ""
              : value
            : undefined;
      if (source === undefined) {
        findings.push(
          themeFinding(
            themeFile,
            path,
            "minimessage.theme-value-invalid",
            "主题 token 定义必须是 MiniMessage 字符串",
            "字符串",
            value,
          ),
        );
        continue;
      }
      for (const surface of surfaces) {
        const definition: ThemeDefinition = {
          index: nextIndex,
          file: themeFile,
          path,
          surface,
          name,
          source,
        };
        definitions.push(definition);
        entries.push({
          file: themeFile,
          path,
          surface,
          name,
          source,
        });
        nextIndex += 1;
      }
    }
  }

  const globalTokens = theme.tokens;
  appendSection(
    globalTokens,
    ["theme", "tokens"],
    ["chat", "gui", "dialog", "bedrock"],
    true,
  );
  appendSection(
    theme.custom,
    ["theme", "custom"],
    ["chat", "gui", "dialog", "bedrock"],
    false,
  );
  for (const surface of surfaceOverrides) {
    appendSection(theme[surface], ["theme", surface], [surface], false);
  }
  return { definitions, entries, findings };
}

function messageSurface(
  message: ObservedMessage,
  resourcePurpose: ReadonlyMap<string, ResourceInventoryEntry["purpose"]>,
): MiniMessageSurface {
  if (message.scene !== undefined && guiScenes.has(message.scene)) return "gui";
  if (message.scene !== undefined && dialogScenes.has(message.scene))
    return "dialog";
  const path = message.path.map((segment) => segment.toLowerCase());
  const file = message.sourceFile.toLowerCase();
  if (
    file.includes("bedrock") ||
    resourcePurpose.get(message.sourceFile) === "bedrock-excluded"
  ) {
    return "bedrock";
  }
  if (resourcePurpose.get(message.sourceFile) === "gui-language") return "gui";
  if (
    path.includes("dialogs") ||
    file.includes("dialogs") ||
    resourcePurpose.get(message.sourceFile) === "dialog-language"
  ) {
    return "dialog";
  }
  return "chat";
}

function usesMiniMessage(message: ObservedMessage): boolean {
  if (message.format !== undefined)
    return (
      message.format.includes("minimessage") ||
      message.format.includes("legacy-color")
    );
  return (
    message.category === "chat-string" ||
    message.category === "chat-string-list"
  );
}

function messagesToParseInputs(
  messages: readonly ObservedMessage[],
  resources: readonly ResourceInventoryEntry[],
  sourceVersion: string,
): readonly MessageInput[] {
  const purposes = new Map(
    resources.map((resource) => [resource.path, resource.purpose]),
  );
  const inputs: MessageInput[] = [];
  let nextIndex = 0;

  function appendInput(
    message: ObservedMessage,
    origin: "source" | "target",
    surface: MiniMessageSurface,
    file: string,
    path: readonly (string | number)[],
    input: string,
  ): void {
    const isLegacyColor = message.format?.includes("legacy-color") ?? false;
    const legacy = isLegacyColor
      ? adaptLegacyMiniMessageInput(input, sourceVersion)
      : undefined;
    const adapted =
      legacy ??
      ({
        input,
        sourceOffsets: Array.from(
          { length: input.length + 1 },
          (_, index) => index,
        ),
        exact: true,
      } satisfies AdaptedMiniMessageInput);
    inputs.push({
      index: nextIndex,
      message,
      origin,
      surface,
      file,
      path,
      input,
      adapted,
      legacyAdapterUnsupported: isLegacyColor && legacy === undefined,
      legacyIssues: legacy?.issues ?? [],
      range: { start: 0, end: input.length },
    });
    nextIndex += 1;
  }

  for (const message of messages) {
    if (!usesMiniMessage(message)) continue;
    if (
      message.sourceFile.toLowerCase().split("/").includes("bedrock") ||
      purposes.get(message.sourceFile) === "bedrock-excluded"
    ) {
      continue;
    }
    const surface = messageSurface(message, purposes);
    const values: readonly {
      readonly origin: "source" | "target";
      readonly value: JsonValue | undefined;
    }[] = [
      { origin: "source", value: message.source },
      { origin: "target", value: message.target },
    ];
    for (const { origin, value } of values) {
      if (typeof value === "string") {
        const file =
          origin === "source" ? message.sourceFile : message.targetFile;
        appendInput(message, origin, surface, file, message.path, value);
      } else if (
        (message.category === "chat-string-list" ||
          message.category === "configuration-string-list" ||
          (message.category === "gui-lore" &&
            message.scene === "gui-item-lore")) &&
        Array.isArray(value) &&
        value.every((item): item is string => typeof item === "string")
      ) {
        const file =
          origin === "source" ? message.sourceFile : message.targetFile;
        if (message.category === "gui-lore") {
          const input = value.join("<newline>");
          appendInput(message, origin, surface, file, message.path, input);
        } else {
          for (const [itemIndex, item] of value.entries()) {
            const itemPath = [...message.path, itemIndex];
            appendInput(message, origin, surface, file, itemPath, item);
          }
        }
      }
    }
  }
  return inputs;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function readContextFrames(
  fields: readonly string[],
  startIndex: number,
):
  | {
      readonly frames: readonly MiniMessageContextFrame[];
      readonly nextIndex: number;
    }
  | undefined {
  const count = Number(fields[startIndex]);
  if (!Number.isSafeInteger(count) || count < 0) return undefined;
  const frames: MiniMessageContextFrame[] = [];
  let index = startIndex + 1;
  for (let frameIndex = 0; frameIndex < count; frameIndex += 1) {
    const kind = fields[index];
    const name = fields[index + 1];
    const start = Number(fields[index + 2]);
    const end = Number(fields[index + 3]);
    if (
      (kind !== "tag" && kind !== "hover-text") ||
      name === undefined ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end)
    ) {
      return undefined;
    }
    frames.push({
      kind,
      name: decode(name),
      position: { start, end },
    });
    index += 4;
  }
  return { frames, nextIndex: index };
}

function javaUnavailable(reason: string): JavaParseResult {
  return {
    themes: new Map(),
    messages: new Map(),
    documents: [],
    unresolved: [],
    warnings: [],
    unavailable: reason,
  };
}

async function runOfficialParser(
  definitions: readonly ThemeDefinition[],
  inputs: readonly MessageInput[],
): Promise<JavaParseResult> {
  let dependencyData: unknown;
  try {
    dependencyData = JSON.parse(
      await readFile(dependencyLock, "utf8"),
    ) as unknown;
    await readFile(helperJar);
  } catch {
    return javaUnavailable(
      "官方 MiniMessage 固定依赖或辅助程序未构建；完整检查未完成",
    );
  }
  if (
    typeof dependencyData !== "object" ||
    dependencyData === null ||
    !("artifacts" in dependencyData) ||
    !Array.isArray(
      (dependencyData as { readonly artifacts?: unknown }).artifacts,
    )
  ) {
    return javaUnavailable(
      "官方 MiniMessage 固定依赖清单无法读取；完整检查未完成",
    );
  }

  const artifacts = (
    dependencyData as {
      readonly artifacts: readonly {
        readonly artifact: string;
        readonly version: string;
        readonly sha256: string;
      }[];
    }
  ).artifacts;
  const classpath = [helperJar];
  try {
    for (const artifact of artifacts) {
      const file = join(
        dependencyDirectory,
        `${artifact.artifact}-${artifact.version}.jar`,
      );
      const bytes = await readFile(file);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== artifact.sha256) {
        return javaUnavailable(
          `官方 MiniMessage 固定依赖摘要不匹配：${artifact.artifact}; 完整检查未完成`,
        );
      }
      classpath.push(file);
    }
  } catch {
    return javaUnavailable("官方 MiniMessage 固定依赖不完整；完整检查未完成");
  }
  try {
    await readdir(dependencyDirectory);
  } catch {
    return javaUnavailable(
      "官方 MiniMessage 固定依赖目录不可用；完整检查未完成",
    );
  }

  const lines: string[] = [];
  for (const definition of definitions) {
    lines.push(
      [
        "T",
        definition.index,
        encode(definition.surface),
        encode(definition.name),
        encode(definition.source),
      ].join("\t"),
    );
  }
  for (const input of inputs) {
    lines.push(
      [
        "M",
        input.index,
        encode(input.surface),
        encode(input.input),
        encode(input.adapted.input),
        input.adapted.sourceOffsets.join(","),
        String(input.adapted.exact),
      ].join("\t"),
    );
  }
  const result = spawnSync(
    process.env.JAVA_COMMAND ?? "java",
    [
      "-cp",
      classpath.join(delimiter),
      "org.landsl10n.minimessage.MiniMessageBridge",
    ],
    {
      input: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  if (result.error !== undefined) {
    const missingJava =
      "code" in result.error &&
      (result.error.code === "ENOENT" || result.error.code === "EACCES");
    const reason = missingJava
      ? "找不到 Java 运行环境；完整 MiniMessage 检查未完成"
      : `官方 MiniMessage 辅助程序无法运行；完整检查未完成：${result.error.message}`;
    return javaUnavailable(reason);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return javaUnavailable(
      `官方 MiniMessage 辅助程序执行失败；完整检查未完成${detail === "" ? "" : `：${detail}`}`,
    );
  }

  const themes = new Map<number, JavaThemeResult>();
  const messages = new Map<number, JavaMessageResult>();
  const documentMetadata = new Map<string, Omit<JavaSourceDocument, "nodes">>();
  const nodesByDocument = new Map<string, MiniMessageSourceNode[]>();
  const unresolved: JavaUnresolvedTag[] = [];
  const warnings: { messageIndex: number; reason: string }[] = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line === "") continue;
    const fields = line.split("\t");
    if (fields[0] === "T" && fields.length === 7) {
      if (fields[2] !== "ok" && fields[2] !== "invalid") {
        return javaUnavailable(
          "官方 MiniMessage 辅助程序返回未知主题状态；完整检查未完成",
        );
      }
      const index = Number(fields[1]);
      let style: JavaThemeResult["style"];
      if (fields[2] === "ok") {
        style = JSON.parse(decode(fields[3]!)) as JavaThemeResult["style"];
      }
      themes.set(index, {
        index,
        ok: fields[2] === "ok",
        ...(style === undefined ? {} : { style }),
        ...(fields[6] === "" ? {} : { error: decode(fields[6]!) }),
        start: Number(fields[4]),
        end: Number(fields[5]),
      });
    } else if (fields[0] === "M" && fields.length === 7) {
      if (
        fields[2] !== "ok" &&
        fields[2] !== "invalid" &&
        fields[2] !== "failed"
      ) {
        return javaUnavailable(
          "官方 MiniMessage 辅助程序返回未知消息状态；完整检查未完成",
        );
      }
      const index = Number(fields[1]);
      messages.set(index, {
        index,
        status: fields[2],
        ...(fields[2] === "ok" ? { plainText: decode(fields[3]!) } : {}),
        ...(fields[6] === "" ? {} : { error: decode(fields[6]!) }),
        start: Number(fields[4]),
        end: Number(fields[5]),
      });
    } else if (fields[0] === "D" && fields.length >= 7) {
      const messageIndex = Number(fields[1]);
      const documentIndex = Number(fields[2]);
      const parentDocumentIndex = Number(fields[3]);
      const rangeStart = Number(fields[4]);
      const rangeEnd = Number(fields[5]);
      const context = readContextFrames(fields, 6);
      if (
        !Number.isSafeInteger(messageIndex) ||
        !Number.isSafeInteger(documentIndex) ||
        !Number.isSafeInteger(parentDocumentIndex) ||
        !Number.isSafeInteger(rangeStart) ||
        !Number.isSafeInteger(rangeEnd) ||
        context === undefined ||
        context.nextIndex !== fields.length
      ) {
        return javaUnavailable(
          "官方 MiniMessage 辅助程序返回无效文档结构；完整检查未完成",
        );
      }
      const key = `${messageIndex}:${documentIndex}`;
      documentMetadata.set(key, {
        messageIndex,
        documentIndex,
        parentDocumentIndex,
        range: { start: rangeStart, end: rangeEnd },
        context: context.frames,
      });
      nodesByDocument.set(key, []);
    } else if (fields[0] === "N" && fields.length >= 12) {
      const messageIndex = Number(fields[1]);
      const documentIndex = Number(fields[2]);
      const kind = fields[3];
      const start = Number(fields[4]);
      const end = Number(fields[5]);
      const raw = fields[6];
      const name = fields[7];
      const closing = fields[8];
      const selfClosing = fields[9];
      const parameterCount = Number(fields[10]);
      const paramsEnd = 11 + parameterCount * 3;
      const context = readContextFrames(fields, paramsEnd);
      if (
        !Number.isSafeInteger(messageIndex) ||
        !Number.isSafeInteger(documentIndex) ||
        (kind !== "text" && kind !== "tag") ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        raw === undefined ||
        name === undefined ||
        (closing !== "true" && closing !== "false") ||
        (selfClosing !== "true" && selfClosing !== "false") ||
        !Number.isSafeInteger(parameterCount) ||
        parameterCount < 0 ||
        context === undefined ||
        context.nextIndex !== fields.length ||
        !nodesByDocument.has(`${messageIndex}:${documentIndex}`)
      ) {
        return javaUnavailable(
          "官方 MiniMessage 辅助程序返回无效源节点；完整检查未完成",
        );
      }
      const parameters: string[] = [];
      const parameterPositions: MiniMessagePosition[] = [];
      for (let index = 11; index < paramsEnd; index += 3) {
        const value = fields[index];
        const parameterStart = Number(fields[index + 1]);
        const parameterEnd = Number(fields[index + 2]);
        if (
          value === undefined ||
          !Number.isSafeInteger(parameterStart) ||
          !Number.isSafeInteger(parameterEnd)
        ) {
          return javaUnavailable(
            "官方 MiniMessage 辅助程序返回无效标签参数；完整检查未完成",
          );
        }
        parameters.push(decode(value));
        parameterPositions.push({ start: parameterStart, end: parameterEnd });
      }
      let node: MiniMessageSourceNode;
      if (kind === "text") {
        node = {
          kind,
          raw: decode(raw),
          position: { start, end },
          context: context.frames,
        };
      } else {
        const tagName = decode(name).toLowerCase();
        node = {
          kind,
          raw: decode(raw),
          name: tagName,
          parameters,
          parameterPositions,
          closing: closing === "true",
          selfClosing: selfClosing === "true",
          semanticKind: styleKind(tagName),
          position: { start, end },
          context: context.frames,
        };
      }
      nodesByDocument.get(`${messageIndex}:${documentIndex}`)!.push(node);
    } else if (fields[0] === "U" && fields.length >= 8) {
      const messageIndex = Number(fields[1]);
      const documentIndex = Number(fields[2]);
      const position = Number(fields[3]);
      const name = fields[4];
      const detail = fields[5];
      const raw = fields[6];
      const context = readContextFrames(fields, 7);
      if (
        !Number.isSafeInteger(messageIndex) ||
        !Number.isSafeInteger(documentIndex) ||
        !Number.isSafeInteger(position) ||
        name === undefined ||
        detail === undefined ||
        raw === undefined ||
        context === undefined ||
        context.nextIndex !== fields.length
      ) {
        return javaUnavailable(
          "官方 MiniMessage 辅助程序返回无效解析事件；完整检查未完成",
        );
      }
      unresolved.push({
        messageIndex,
        documentIndex,
        name: decode(name).toLowerCase(),
        position,
        detail: decode(detail),
        raw: decode(raw),
        context: context.frames,
      });
    } else if (fields[0] === "W" && fields.length === 3) {
      warnings.push({
        messageIndex: Number(fields[1]),
        reason: decode(fields[2]!),
      });
    } else {
      return javaUnavailable(
        "官方 MiniMessage 辅助程序返回无法识别的数据；完整检查未完成",
      );
    }
  }
  const documents = [...documentMetadata.entries()].map(([key, document]) => ({
    ...document,
    nodes: nodesByDocument.get(key) ?? [],
  }));
  return { themes, messages, documents, unresolved, warnings };
}

function findingForMessage(
  input: MessageInput,
  code: string,
  reason: string,
  expected: JsonValue,
  actual: JsonValue,
  identity?: JsonValue,
  fingerprint?: JsonValue,
): MiniMessageFinding {
  return {
    code,
    ...(identity === undefined ? {} : { identity }),
    ...(fingerprint === undefined ? {} : { fingerprint }),
    message: input.message,
    origin: input.origin,
    location: { file: input.file, path: input.path },
    reason,
    expected,
    actual,
  };
}

function parserStatus(
  input: MessageInput,
  java: JavaParseResult,
): ParsedMiniMessageDocument["status"] {
  if (java.unavailable !== undefined) return "parser-failed";
  const result = java.messages.get(input.index);
  if (result?.status === "failed") return "parser-failed";
  return result?.status === "invalid" ? "syntax-invalid" : "parsed";
}

function themeEntryResults(
  definitions: readonly ThemeDefinition[],
  javaThemes: ReadonlyMap<number, JavaThemeResult>,
): readonly MiniMessageThemeEntry[] {
  return definitions.map((definition) => {
    const result = javaThemes.get(definition.index);
    return {
      file: definition.file,
      path: definition.path,
      surface: definition.surface,
      name: definition.name,
      source: definition.source,
      ...(result?.style === undefined ? {} : { style: result.style }),
    };
  });
}

function appendParserFindings(
  inputs: readonly MessageInput[],
  java: JavaParseResult,
  findings: MiniMessageFinding[],
  unavailable: Set<string>,
  themeDefinitions: readonly ThemeDefinition[],
): void {
  if (java.unavailable !== undefined) {
    unavailable.add(java.unavailable);
    return;
  }
  const inputsByIndex = new Map(inputs.map((input) => [input.index, input]));
  const mapNodesByIndex = new Map(
    inputs
      .filter((input) => input.message.format === "map-html-minimessage")
      .map((input) => [
        input.index,
        java.documents.find(
          (document) =>
            document.messageIndex === input.index &&
            document.documentIndex === 0,
        )?.nodes ?? [],
      ]),
  );
  const mapTagRangesByIndex = new Map(
    inputs
      .filter((input) => input.message.format === "map-html-minimessage")
      .map((input) => [
        input.index,
        mapHtmlTagRanges(input.input, mapNodesByIndex.get(input.index) ?? []),
      ]),
  );
  for (const warning of java.warnings) {
    if (inputsByIndex.has(warning.messageIndex))
      unavailable.add(warning.reason);
  }
  const seenOccurrences = new Set<string>();
  const occurrenceIndices = new Map<string, number>();

  for (const input of inputs) {
    const result = java.messages.get(input.index);
    if (result === undefined) {
      unavailable.add(
        "官方 MiniMessage 辅助程序未返回全部消息结果；完整检查未完成",
      );
      continue;
    }
    if (result.status === "failed") {
      unavailable.add(
        `官方 MiniMessage 解析器处理消息失败：${result.error ?? "未知运行时错误"}`,
      );
      continue;
    }
    if (result.status === "invalid") {
      const sourceName = input.origin === "source" ? "原文" : "译文";
      findings.push(
        findingForMessage(
          input,
          "minimessage.syntax-invalid",
          `${sourceName}中的 MiniMessage 语法不被官方解析器接受：${result.error ?? "未知解析错误"}`,
          { state: "valid MiniMessage" },
          {
            state: "syntax-invalid",
            start: result.start,
            end: result.end,
            input: input.input,
            parserMessage: result.error ?? "未知解析错误",
          },
          { kind: "syntax-invalid" },
        ),
      );
    }
  }

  for (const unresolved of java.unresolved) {
    const input = inputsByIndex.get(unresolved.messageIndex);
    if (input === undefined) continue;
    const occurrence = `${unresolved.messageIndex}\0${unresolved.documentIndex}\0${unresolved.position}\0${unresolved.name}\0${unresolved.detail}`;
    if (seenOccurrences.has(occurrence)) continue;
    seenOccurrences.add(occurrence);
    const occurrenceKey = `${unresolved.messageIndex}\0${unresolved.documentIndex}`;
    const occurrenceIndex = occurrenceIndices.get(occurrenceKey) ?? 0;
    occurrenceIndices.set(occurrenceKey, occurrenceIndex + 1);
    if (unresolved.position < 0) {
      unavailable.add("存在 MiniMessage 解析诊断无法可靠映射回原文位置");
    }
    const context: JsonValue = unresolved.context.map(
      (frame) =>
        [
          frame.kind,
          frame.name,
          frame.position.start,
          frame.position.end,
        ] as const,
    );
    const actualTag: { readonly [key: string]: JsonValue } = {
      tag: unresolved.raw,
      ...(unresolved.position < 0 ? {} : { position: unresolved.position }),
      documentIndex: unresolved.documentIndex,
      context,
      parserDetail: unresolved.detail,
    };
    const name = unresolved.name;
    const isMapTemplate = input.message.format === "map-html-minimessage";
    if (isMapTemplate && name === "v") continue;
    if (
      isMapTemplate &&
      isMapHtmlAttributeTag(input.input, unresolved.position, unresolved.raw)
    ) {
      continue;
    }
    if (
      isMapTemplate &&
      isMapHtmlParserTag(
        input.input,
        unresolved.position,
        unresolved.raw,
        mapTagRangesByIndex.get(input.index) ?? [],
      )
    ) {
      continue;
    }
    if (landsControls.has(name) || landsPreprocessors.has(name)) {
      const finding = findingForMessage(
        input,
        "minimessage.extension-unsupported",
        `Lands 扩展 <${name}> 的预处理语义尚未实现；本次检查没有判定该扩展正确`,
        { state: "Lands extension semantics checked" },
        actualTag,
        {
          documentIndex: unresolved.documentIndex,
          occurrence: occurrenceIndex,
        },
      );
      findings.push(finding);
      unavailable.add("Lands 控制和预处理语义尚未完成");
      continue;
    }
    if (name === "t") {
      const unknownToken = /^Unknown theme token: (.*)$/u.exec(
        unresolved.detail,
      )?.[1];
      const token = unknownToken?.toLowerCase();
      findings.push(
        findingForMessage(
          input,
          token === undefined
            ? "minimessage.theme-reference-invalid"
            : "minimessage.theme-unknown",
          token === undefined
            ? `主题引用无法解析：${unresolved.detail || "缺少 token 名"}`
            : `引用了未定义的主题 token：${token}`,
          { state: "defined theme token" },
          {
            tagName: "t",
            ...(token === undefined ? {} : { token }),
            ...actualTag,
          },
          {
            documentIndex: unresolved.documentIndex,
            occurrence: occurrenceIndex,
          },
          {
            themeToken: token ?? "",
            definitions: themeDefinitions
              .filter(
                (definition) =>
                  definition.surface === input.surface &&
                  definition.name.toLowerCase() === token,
              )
              .map((definition) => ({
                file: definition.file,
                path: definition.path,
                surface: definition.surface,
                name: definition.name,
                source: definition.source,
              })),
          },
        ),
      );
      continue;
    }
    if (standardTags.has(name) || name === "v") {
      findings.push(
        findingForMessage(
          input,
          "minimessage.tag-unresolved",
          `官方解析器未能解析标签 <${name}>：${unresolved.detail || "标签参数或形式无法识别"}`,
          { state: "recognized MiniMessage tag" },
          { tagName: name, ...actualTag },
          {
            documentIndex: unresolved.documentIndex,
            occurrence: occurrenceIndex,
          },
        ),
      );
      continue;
    }
    findings.push(
      findingForMessage(
        input,
        "minimessage.tag-unknown",
        `官方默认模式将未识别标签 <${name}> 保留为文本，无法确认其扩展语义`,
        { state: "recognized tag or supported extension" },
        {
          ...actualTag,
        },
        {
          documentIndex: unresolved.documentIndex,
          occurrence: occurrenceIndex,
        },
      ),
    );
    unavailable.add("存在尚未识别的自定义 MiniMessage 标签");
  }
}

const legacyTitleVariablePattern = /%(owner|player|nation|level)%/gu;

function appendTextSegment(
  segments: TranslatableTextSegment[],
  value: string,
  raw: string,
  position: MiniMessagePosition,
  context: readonly MiniMessageContextFrame[],
): void {
  if (value === "") return;
  segments.push({ kind: "text", value, raw, position, context });
}

function legacyVariableSegments(
  document: ParsedMiniMessageDocument,
): readonly TranslatableTextSegment[] {
  interface TextChunk {
    readonly node: Extract<MiniMessageSourceNode, { readonly kind: "text" }>;
    readonly start: number;
    readonly end: number;
  }

  const segments: TranslatableTextSegment[] = [];
  let chunks: TextChunk[] = [];
  let visibleText = "";

  const flush = (): void => {
    if (chunks.length === 0) return;
    const positionAt = (offset: number, end: boolean): number => {
      for (const chunk of chunks) {
        if (
          (end && chunk.start < offset && offset <= chunk.end) ||
          (!end && chunk.start <= offset && offset < chunk.end)
        ) {
          return chunk.node.position.start + offset - chunk.start;
        }
      }
      const last = chunks.at(-1)!;
      return offset <= 0
        ? chunks[0]!.node.position.start
        : last.node.position.end;
    };

    const appendVisibleRange = (start: number, end: number): void => {
      for (const chunk of chunks) {
        const overlapStart = Math.max(start, chunk.start);
        const overlapEnd = Math.min(end, chunk.end);
        if (overlapStart >= overlapEnd) continue;
        const localStart = overlapStart - chunk.start;
        const localEnd = overlapEnd - chunk.start;
        const raw = chunk.node.raw.slice(localStart, localEnd);
        appendTextSegment(
          segments,
          raw,
          raw,
          {
            start: chunk.node.position.start + localStart,
            end: chunk.node.position.start + localEnd,
          },
          chunk.node.context,
        );
      }
    };

    let visibleOffset = 0;
    for (const match of visibleText.matchAll(legacyTitleVariablePattern)) {
      const start = match.index;
      const raw = match[0];
      const name = match[1];
      if (raw === undefined || name === undefined) continue;
      appendVisibleRange(visibleOffset, start);
      const position = {
        start: positionAt(start, false),
        end: positionAt(start + raw.length, true),
      };
      const context =
        chunks.find((chunk) => chunk.start <= start && start < chunk.end)?.node
          .context ?? [];
      segments.push({
        kind: "variable",
        value: name,
        raw: document.input.slice(position.start, position.end),
        position,
        context,
      });
      visibleOffset = start + raw.length;
    }
    appendVisibleRange(visibleOffset, visibleText.length);
    chunks = [];
    visibleText = "";
  };

  for (const node of document.nodes) {
    if (node.kind === "text") {
      const start = visibleText.length;
      visibleText += node.raw;
      chunks.push({ node, start, end: visibleText.length });
      continue;
    }
    if (node.semanticKind === "style") continue;
    flush();
  }
  flush();
  return segments;
}

function translatableSegments(
  document: ParsedMiniMessageDocument,
): readonly TranslatableTextSegment[] {
  const segments: TranslatableTextSegment[] = [];
  const hasLegacyTitleVariables =
    document.message.format === "legacy-variable-minimessage" &&
    document.parent === undefined;
  if (hasLegacyTitleVariables) return legacyVariableSegments(document);

  for (const node of document.nodes) {
    if (node.kind === "text") {
      appendTextSegment(
        segments,
        node.raw,
        node.raw,
        node.position,
        node.context,
      );
      continue;
    }
    if (
      node.name === "v" &&
      !node.closing &&
      node.parameters[0] !== undefined
    ) {
      segments.push({
        kind: "variable",
        value: node.parameters[0],
        raw: node.raw,
        position: node.position,
        context: node.context,
      });
      continue;
    }
    if (node.closing || node.semanticKind === "style") continue;
    if (node.name === "click") {
      segments.push({
        kind: "command",
        value: node.parameters.join(":"),
        raw: node.raw,
        position: node.position,
        context: node.context,
      });
      continue;
    }
    if (node.name === "br" || node.name === "newline") {
      segments.push({
        kind: "boundary",
        value: "\n",
        raw: node.raw,
        position: node.position,
        context: node.context,
      });
      continue;
    }
    segments.push({
      kind: "structure",
      value: node.parameters.join(":"),
      raw: node.raw,
      position: node.position,
      context: node.context,
    });
  }
  return segments;
}

function translatableTextDocuments(
  documents: readonly ParsedMiniMessageDocument[],
  mapSegments: ReadonlyMap<
    ParsedMiniMessageDocument,
    readonly TranslatableTextSegment[]
  >,
): readonly TranslatableTextDocument[] {
  return documents.map((document) => ({
    message: document.message,
    documentIndex: document.documentIndex,
    origin: document.origin,
    file: document.file,
    path: document.path,
    surface: document.surface,
    range: document.range,
    context: document.context,
    segments: mapSegments.get(document) ?? translatableSegments(document),
  }));
}

function appendMapVariableFindings(
  inputs: readonly MessageInput[],
  documents: readonly ParsedMiniMessageDocument[],
  findings: MiniMessageFinding[],
  unavailable: Set<string>,
  sourceVersion: string,
): void {
  const mapInputs = inputs.filter(
    (input) => input.message.format === "map-html-minimessage",
  );
  if (!supportsMapHtmlVersion(sourceVersion)) {
    for (const input of mapInputs) {
      if (input.origin !== "source") continue;
      findings.push(
        findingForMessage(
          input,
          "map-html.source-version-unsupported",
          "地图模板的来源版本未受支持；动态变量供值无法完整核对",
          { supportedVersions: ["8.0.1", "8.9.2"] },
          { sourceVersion },
          { kind: "source-version" },
          { sourceVersion, supportedVersions: ["8.0.1", "8.9.2"] },
        ),
      );
    }
    if (mapInputs.length > 0) {
      unavailable.add("Lands 地图模板变量供值不支持此来源版本");
    }
    return;
  }

  const inputByDocument = new Map(
    mapInputs.map((input) => [`${input.message.id}\0${input.origin}`, input]),
  );
  const occurrences = new Map<string, number>();
  for (const document of documents) {
    if (
      document.message.format !== "map-html-minimessage" ||
      document.status !== "parsed"
    ) {
      continue;
    }
    const input = inputByDocument.get(
      `${document.message.id}\0${document.origin}`,
    );
    if (input === undefined) continue;
    for (const node of document.nodes) {
      if (
        node.kind !== "tag" ||
        node.name !== "v" ||
        node.closing ||
        node.parameters[0] === undefined ||
        isMapHtmlAttributeTag(input.input, node.position.start, node.raw)
      ) {
        continue;
      }
      const variable = node.parameters[0];
      if (isKnownMapVariable(variable, sourceVersion)) continue;
      const key = `${input.index}\0${document.documentIndex}\0${variable}`;
      const occurrenceIndex = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrenceIndex + 1);
      const context: JsonValue = node.context.map(
        (frame) =>
          [
            frame.kind,
            frame.name,
            frame.position.start,
            frame.position.end,
          ] as const,
      );
      findings.push(
        findingForMessage(
          input,
          "map-html.variable-unknown",
          "地图模板使用了 Lands 未提供的动态变量",
          { state: "known map v variable" },
          {
            variable,
            tag: node.raw,
            position: { start: node.position.start, end: node.position.end },
            documentIndex: document.documentIndex,
            context,
          },
          { documentIndex: document.documentIndex, variable, occurrenceIndex },
          { sourceVersion, supportedVariables: "Lands map resolver" },
        ),
      );
    }
  }
}

export async function parseMiniMessages(
  messages: readonly ObservedMessage[],
  resources: readonly ResourceInventoryEntry[],
  themeSnapshot?: MiniMessageThemeSnapshot,
  sourceVersion = "",
): Promise<MiniMessageParseProject> {
  const theme = parseTheme(themeSnapshot);
  const inputs = messagesToParseInputs(messages, resources, sourceVersion);
  const java = await runOfficialParser(theme.definitions, inputs);
  const findings = [...theme.findings];
  const mapFindings: MiniMessageFinding[] = [];
  const unavailable = new Set<string>();
  const legacyIssueOccurrences = new Map<string, number>();
  for (const input of inputs) {
    if (input.legacyAdapterUnsupported) {
      unavailable.add(
        "旧颜色格式的来源 Lands 版本未受支持；运行时转换规则无法确认",
      );
      findings.push(
        findingForMessage(
          input,
          "legacy-format.source-version-unsupported",
          `无法按未知 Lands 版本 ${sourceVersion} 确认旧颜色码转换行为`,
          { supportedVersions: ["8.0.1", "8.9.2"] },
          { sourceVersion, format: input.message.format ?? "unknown" },
          { format: input.message.format ?? "unknown", occurrence: 0 },
          { sourceVersion },
        ),
      );
    }
    for (const issue of input.legacyIssues) {
      const key = `${input.index}\0${issue.code}`;
      const occurrence = legacyIssueOccurrences.get(key) ?? 0;
      legacyIssueOccurrences.set(key, occurrence + 1);
      findings.push(
        findingForMessage(
          input,
          issue.code,
          "旧颜色格式与该 Lands 版本支持的转换形式不一致",
          {
            expected: issue.expected,
            position: {
              start: issue.position.start,
              end: issue.position.end,
            },
          },
          {
            actual: issue.actual,
            position: {
              start: issue.position.start,
              end: issue.position.end,
            },
          },
          { format: input.message.format ?? "legacy-color", occurrence },
          { sourceVersion },
        ),
      );
    }
  }
  if (java.unavailable === undefined) {
    for (const definition of theme.definitions) {
      const result = java.themes.get(definition.index);
      if (result === undefined) {
        unavailable.add(
          "官方 MiniMessage 辅助程序未返回全部主题结果；完整检查未完成",
        );
      } else if (!result.ok) {
        findings.push(
          themeFinding(
            definition.file,
            definition.path,
            "minimessage.theme-definition-invalid",
            `主题 token ${definition.name} 不是有效的颜色/装饰样式：${result.error ?? "未知解析错误"}`,
            { state: "color, decoration or reset style" },
            {
              source: definition.source,
              start: result.start,
              end: result.end,
              parserMessage: result.error ?? "未知解析错误",
            },
          ),
        );
      }
    }
  }
  appendParserFindings(inputs, java, findings, unavailable, theme.definitions);
  const inputsByIndex = new Map(inputs.map((input) => [input.index, input]));
  const documentResults: ParsedMiniMessageDocument[] = [];
  const rootDocuments = new Set<number>();
  for (const parsed of java.documents) {
    const input = inputsByIndex.get(parsed.messageIndex);
    if (input === undefined) continue;
    const result = java.messages.get(input.index);
    const parent =
      parsed.parentDocumentIndex < 0
        ? undefined
        : [...parsed.context]
            .reverse()
            .find((frame) => frame.kind === "hover-text");
    documentResults.push({
      message: input.message,
      documentIndex: parsed.documentIndex,
      origin: input.origin,
      file: input.file,
      path: input.path,
      surface: input.surface,
      input: input.input,
      range: parsed.range,
      status: parserStatus(input, java),
      ...(parsed.documentIndex === 0 && result?.plainText !== undefined
        ? { plainText: result.plainText }
        : {}),
      nodes: parsed.nodes,
      context: parsed.context,
      ...(parent === undefined ? {} : { parent }),
    });
    if (parsed.parentDocumentIndex < 0) rootDocuments.add(input.index);
  }
  for (const input of inputs) {
    if (rootDocuments.has(input.index)) continue;
    const result = java.messages.get(input.index);
    documentResults.push({
      message: input.message,
      documentIndex: 0,
      origin: input.origin,
      file: input.file,
      path: input.path,
      surface: input.surface,
      input: input.input,
      range: input.range,
      status: parserStatus(input, java),
      ...(result?.plainText === undefined
        ? {}
        : { plainText: result.plainText }),
      nodes: [],
      context: [],
    });
  }
  appendMapVariableFindings(
    inputs,
    documentResults,
    mapFindings,
    unavailable,
    sourceVersion,
  );
  const mapSegmentOverrides = new Map<
    ParsedMiniMessageDocument,
    readonly TranslatableTextSegment[]
  >();
  for (const document of documentResults) {
    if (
      document.message.format === "map-html-minimessage" &&
      document.parent === undefined &&
      document.status === "parsed"
    ) {
      mapSegmentOverrides.set(document, mapHtmlSegments(document));
    }
  }
  for (const message of messages) {
    if (message.format !== "map-html-minimessage") continue;
    const sourceDocument = documentResults.find(
      (document) =>
        document.message.id === message.id &&
        document.origin === "source" &&
        document.parent === undefined &&
        document.documentIndex === 0,
    );
    const targetDocument = documentResults.find(
      (document) =>
        document.message.id === message.id &&
        document.origin === "target" &&
        document.parent === undefined &&
        document.documentIndex === 0,
    );
    if (
      sourceDocument === undefined ||
      targetDocument === undefined ||
      sourceDocument.status !== "parsed" ||
      targetDocument.status !== "parsed"
    ) {
      continue;
    }
    const analysis = analyzeMapHtml(
      sourceDocument,
      targetDocument,
      sourceVersion,
    );
    mapFindings.push(...analysis.findings);
    mapSegmentOverrides.set(sourceDocument, analysis.sourceSegments);
    mapSegmentOverrides.set(targetDocument, analysis.targetSegments);
  }
  return {
    sourceVersion,
    documents: documentResults,
    translatableText: translatableTextDocuments(
      documentResults,
      mapSegmentOverrides,
    ),
    themes: themeEntryResults(theme.definitions, java.themes),
    findings,
    mapFindings,
    unavailableCapabilities: [...unavailable].sort(),
  };
}
