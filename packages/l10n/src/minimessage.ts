import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
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
  readonly nodes: readonly MiniMessageSourceNode[];
  readonly documentIndex: number;
  readonly parent?: MiniMessageContextFrame;
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
  readonly name: string;
  readonly position: number;
  readonly detail: string;
}

interface JavaParseResult {
  readonly themes: ReadonlyMap<number, JavaThemeResult>;
  readonly messages: ReadonlyMap<number, JavaMessageResult>;
  readonly unresolved: readonly JavaUnresolvedTag[];
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

function isEscaped(input: string, index: number): boolean {
  let slashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && input[cursor] === "\\";
    cursor -= 1
  ) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

interface TagSlice {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly body: string;
}

function findTagEnd(input: string, start: number): TagSlice | undefined {
  let quote: "'" | '"' | undefined;
  for (let index = start + 1; index < input.length; index += 1) {
    const character = input[index]!;
    if (isEscaped(input, index)) continue;
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === ">") {
      return {
        start,
        end: index + 1,
        raw: input.slice(start, index + 1),
        body: input.slice(start + 1, index),
      };
    }
  }
  return undefined;
}

interface ParameterSlice {
  readonly value: string;
  readonly position: MiniMessagePosition;
}

function splitParameters(
  input: string,
  contentStart: number,
  body: string,
): readonly ParameterSlice[] {
  const result: ParameterSlice[] = [];
  let quote: "'" | '"' | undefined;
  let partStart = 0;
  for (let index = 0; index <= body.length; index += 1) {
    const character = body[index];
    if (index < body.length && isEscaped(body, index)) continue;
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === ":" || index === body.length) {
      const from = contentStart + partStart;
      const to = contentStart + index;
      result.push({
        value: input.slice(from, to),
        position: { start: from, end: to },
      });
      partStart = index + 1;
    }
  }
  return result;
}

function tagNode(
  input: string,
  slice: TagSlice,
  context: readonly MiniMessageContextFrame[],
  baseOffset: number,
): MiniMessageTagNode {
  const absoluteStart = baseOffset + slice.start;
  const absoluteEnd = baseOffset + slice.end;
  const hasClosingSlash = slice.body.startsWith("/");
  const withoutClosingSlash = hasClosingSlash
    ? slice.body.slice(1)
    : slice.body;
  const selfClosing = withoutClosingSlash.endsWith("/");
  const body = selfClosing
    ? withoutClosingSlash.slice(0, -1)
    : withoutClosingSlash;
  const pieces = splitParameters(
    input,
    slice.start + 1 + Number(hasClosingSlash),
    body,
  );
  const rawName = pieces[0]?.value ?? body;
  const name = rawName.toLowerCase();
  const parameters = pieces.slice(1);
  return {
    kind: "tag",
    raw: slice.raw,
    name,
    parameters: parameters.map((parameter) => parameter.value),
    parameterPositions: parameters.map((parameter) => ({
      start: baseOffset + parameter.position.start,
      end: baseOffset + parameter.position.end,
    })),
    closing: hasClosingSlash,
    selfClosing,
    semanticKind: styleKind(name),
    position: { start: absoluteStart, end: absoluteEnd },
    context,
  };
}

interface ScannedNodes {
  readonly nodes: readonly MiniMessageSourceNode[];
  readonly hoverRanges: readonly {
    readonly start: number;
    readonly end: number;
    readonly parent: MiniMessageContextFrame;
  }[];
}

function scanMiniMessage(
  input: string,
  baseOffset = 0,
  initialContext: readonly MiniMessageContextFrame[] = [],
): ScannedNodes {
  const nodes: MiniMessageSourceNode[] = [];
  const stack: MiniMessageContextFrame[] = [...initialContext];
  const hoverRanges: {
    readonly start: number;
    readonly end: number;
    readonly parent: MiniMessageContextFrame;
  }[] = [];
  let cursor = 0;
  let index = 0;

  while (index < input.length) {
    if (input[index] !== "<" || isEscaped(input, index)) {
      index += 1;
      continue;
    }
    const slice = findTagEnd(input, index);
    if (slice === undefined) {
      index += 1;
      continue;
    }
    if (slice.start > cursor) {
      nodes.push({
        kind: "text",
        raw: input.slice(cursor, slice.start),
        position: { start: baseOffset + cursor, end: baseOffset + slice.start },
        context: [...stack],
      });
    }
    const tag = tagNode(input, slice, [...stack], baseOffset);
    nodes.push(tag);
    if (tag.name === "hover" && !tag.closing && !tag.selfClosing) {
      const parsedTag = splitParameters(input, slice.start + 1, slice.body);
      const mode = parsedTag[1]?.value.toLowerCase();
      const textParameter = parsedTag[2];
      if (mode === "show_text" && textParameter !== undefined) {
        const quoteStart = textParameter.value[0];
        const quoteEnd = textParameter.value.at(-1);
        if (
          (quoteStart === "'" || quoteStart === '"') &&
          quoteEnd === quoteStart &&
          textParameter.value.length >= 2
        ) {
          const start = textParameter.position.start + 1;
          const end = textParameter.position.end - 1;
          hoverRanges.push({
            start: baseOffset + start,
            end: baseOffset + end,
            parent: {
              kind: "hover-text",
              name: "hover:show_text",
              position: tag.position,
            },
          });
        }
      }
    }
    if (tag.closing) {
      for (
        let stackIndex = stack.length - 1;
        stackIndex >= 0;
        stackIndex -= 1
      ) {
        if (stack[stackIndex]?.name === tag.name) {
          stack.splice(stackIndex, 1);
          break;
        }
      }
    } else if (!tag.selfClosing) {
      stack.push({ kind: "tag", name: tag.name, position: tag.position });
    }
    cursor = slice.end;
    index = slice.end;
  }
  if (cursor < input.length) {
    nodes.push({
      kind: "text",
      raw: input.slice(cursor),
      position: { start: baseOffset + cursor, end: baseOffset + input.length },
      context: [...stack],
    });
  }
  return { nodes, hoverRanges };
}

function sliceTextRange(input: string, range: MiniMessagePosition): string {
  return input.slice(range.start, range.end);
}

function scanDocuments(
  message: ObservedMessage,
  origin: "source" | "target",
  surface: MiniMessageSurface,
  file: string,
  path: readonly (string | number)[],
  input: string,
): {
  readonly inputs: readonly MessageInput[];
  readonly documents: readonly ParsedMiniMessageDocument[];
} {
  const rootScan = scanMiniMessage(input);
  const root: ParsedMiniMessageDocument = {
    message,
    origin,
    file,
    path,
    surface,
    input,
    range: { start: 0, end: input.length },
    status: "parsed",
    nodes: rootScan.nodes,
    context: [],
  };
  const docs: ParsedMiniMessageDocument[] = [root];
  function addHoverDocuments(
    hoverRanges: ScannedNodes["hoverRanges"],
    parentContext: readonly MiniMessageContextFrame[],
  ): void {
    for (const hover of hoverRanges) {
      const nestedInput = sliceTextRange(input, {
        start: hover.start,
        end: hover.end,
      });
      const context = [...parentContext, hover.parent];
      const scan = scanMiniMessage(nestedInput, hover.start, context);
      docs.push({
        message,
        origin,
        file,
        path,
        surface,
        input,
        range: { start: hover.start, end: hover.end },
        status: "parsed",
        nodes: scan.nodes,
        context,
        parent: hover.parent,
      });
      addHoverDocuments(scan.hoverRanges, context);
    }
  }
  addHoverDocuments(rootScan.hoverRanges, []);
  const inputs = [
    {
      index: -1,
      message,
      origin,
      surface,
      file,
      path,
      input,
      nodes: root.nodes,
      documentIndex: 0,
      range: root.range,
    },
  ];
  return { inputs, documents: docs };
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
    for (const name of Object.keys(sectionValue).sort()) {
      const value = sectionValue[name]!;
      const path = [...sectionPath, name];
      if (!/^[a-z0-9_-]+$/u.test(name)) {
        findings.push(
          themeFinding(
            themeFile,
            path,
            "minimessage.theme-name-invalid",
            "主题 token 名必须只含小写字母、数字、下划线或连字符",
            "[a-z0-9_-]+",
            name,
          ),
        );
        continue;
      }
      if (typeof value !== "string") {
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
          source: value,
        };
        definitions.push(definition);
        entries.push({
          file: themeFile,
          path,
          surface,
          name,
          source: value,
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
  const path = message.path.map((segment) => segment.toLowerCase());
  const file = message.sourceFile.toLowerCase();
  if (path.includes("dialogs")) return "dialog";
  if (
    file.includes("bedrock") ||
    resourcePurpose.get(message.sourceFile) === "bedrock-excluded"
  ) {
    return "bedrock";
  }
  if (resourcePurpose.get(message.sourceFile) === "gui-language") return "gui";
  return "chat";
}

function messagesToParseInputs(
  messages: readonly ObservedMessage[],
  resources: readonly ResourceInventoryEntry[],
): {
  readonly inputs: readonly MessageInput[];
  readonly documents: readonly ParsedMiniMessageDocument[];
} {
  const purposes = new Map(
    resources.map((resource) => [resource.path, resource.purpose]),
  );
  const inputs: MessageInput[] = [];
  const documents: ParsedMiniMessageDocument[] = [];
  let nextIndex = 0;

  for (const message of messages) {
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
        const scan = scanDocuments(
          message,
          origin,
          surface,
          file,
          message.path,
          value,
        );
        for (const input of scan.inputs) {
          inputs.push({ ...input, index: nextIndex });
          nextIndex += 1;
        }
        documents.push(...scan.documents);
      } else if (
        message.category === "chat-string-list" &&
        Array.isArray(value) &&
        value.every((item): item is string => typeof item === "string")
      ) {
        const file =
          origin === "source" ? message.sourceFile : message.targetFile;
        if (
          surface === "gui" &&
          message.path.at(-1)?.toLowerCase() === "lore"
        ) {
          const scan = scanDocuments(
            message,
            origin,
            surface,
            file,
            message.path,
            value.join("\n"),
          );
          for (const input of scan.inputs) {
            inputs.push({ ...input, index: nextIndex });
            nextIndex += 1;
          }
          documents.push(...scan.documents);
        } else {
          for (const [itemIndex, item] of value.entries()) {
            const itemPath = [...message.path, itemIndex];
            const scan = scanDocuments(
              message,
              origin,
              surface,
              file,
              itemPath,
              item,
            );
            for (const input of scan.inputs) {
              inputs.push({ ...input, index: nextIndex });
              nextIndex += 1;
            }
            documents.push(...scan.documents);
          }
        }
      }
    }
  }
  return { inputs, documents };
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function javaUnavailable(reason: string): JavaParseResult {
  return {
    themes: new Map(),
    messages: new Map(),
    unresolved: [],
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
      ["M", input.index, encode(input.surface), encode(input.input)].join("\t"),
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
  const unresolved: JavaUnresolvedTag[] = [];
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
    } else if (fields[0] === "U" && fields.length === 5) {
      unresolved.push({
        messageIndex: Number(fields[1]),
        name: decode(fields[2]!).toLowerCase(),
        position: Number(fields[3]),
        detail: decode(fields[4]!),
      });
    } else {
      return javaUnavailable(
        "官方 MiniMessage 辅助程序返回无法识别的数据；完整检查未完成",
      );
    }
  }
  return { themes, messages, unresolved };
}

function nodesForMessage(
  documents: readonly ParsedMiniMessageDocument[],
  input: MessageInput,
  message: ObservedMessage,
  origin: "source" | "target",
  file: string,
): readonly MiniMessageTagNode[] {
  const seen = new Set<string>();
  const result: MiniMessageTagNode[] = [];
  const candidates = [
    ...input.nodes,
    ...documents
      .filter(
        (document) =>
          document.message.id === message.id &&
          document.origin === origin &&
          document.file === file,
      )
      .flatMap((document) => document.nodes),
  ];
  for (const node of candidates) {
    if (node.kind !== "tag") continue;
    const key = `${node.position.start}:${node.position.end}:${node.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(node);
  }
  return result;
}

function nodeForUnresolvedTag(
  nodes: readonly MiniMessageTagNode[],
  unresolved: JavaUnresolvedTag,
  claimed: ReadonlySet<MiniMessageTagNode>,
): MiniMessageTagNode | undefined {
  const sameName = nodes.filter((node) => node.name === unresolved.name);
  return (
    sameName.find(
      (node) =>
        node.position.start === unresolved.position && !claimed.has(node),
    ) ?? sameName.find((node) => !claimed.has(node))
  );
}

function findingForMessage(
  input: MessageInput,
  code: string,
  reason: string,
  expected: JsonValue,
  actual: JsonValue,
): MiniMessageFinding {
  return {
    code,
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
  documents: readonly ParsedMiniMessageDocument[],
  java: JavaParseResult,
  findings: MiniMessageFinding[],
  unavailable: Set<string>,
): void {
  if (java.unavailable !== undefined) {
    unavailable.add(java.unavailable);
    return;
  }
  const inputsByIndex = new Map(inputs.map((input) => [input.index, input]));
  const nodesByInput = new Map<number, readonly MiniMessageTagNode[]>();
  const claimedNodesByInput = new Map<number, Set<MiniMessageTagNode>>();
  const seenThemeErrorsByInput = new Map<number, Set<string>>();
  const seenKnownTagErrorsByInput = new Map<number, Set<string>>();

  function tagForUnresolved(
    input: MessageInput,
    unresolved: JavaUnresolvedTag,
  ): MiniMessageTagNode | undefined {
    let nodes = nodesByInput.get(input.index);
    if (nodes === undefined) {
      nodes = nodesForMessage(
        documents,
        input,
        input.message,
        input.origin,
        input.file,
      );
      nodesByInput.set(input.index, nodes);
    }
    let claimed = claimedNodesByInput.get(input.index);
    if (claimed === undefined) {
      claimed = new Set();
      claimedNodesByInput.set(input.index, claimed);
    }
    const tag = nodeForUnresolvedTag(nodes, unresolved, claimed);
    if (tag !== undefined) claimed.add(tag);
    return tag;
  }

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
        ),
      );
    }
  }

  for (const unresolved of java.unresolved) {
    if (unresolved.position < 0) continue;
    const input = inputsByIndex.get(unresolved.messageIndex);
    if (input === undefined) continue;
    const name = unresolved.name;
    const isMapTemplate =
      input.message.path.slice(0, 2).join(".") === "general.integration";
    if (isMapTemplate) {
      unavailable.add("地图 HTML 与 MiniMessage 混合字段尚未完成专用检查");
      continue;
    }
    if (landsControls.has(name) || landsPreprocessors.has(name)) {
      const tag = tagForUnresolved(input, unresolved);
      const finding = findingForMessage(
        input,
        "minimessage.extension-unsupported",
        `Lands 扩展 <${name}> 的预处理语义尚未实现；本次检查没有判定该扩展正确`,
        { state: "Lands extension semantics checked" },
        {
          tag: tag?.raw ?? `<${name}>`,
          ...(tag === undefined ? {} : { position: tag.position.start }),
          parserDetail: unresolved.detail,
        },
      );
      findings.push(finding);
      unavailable.add("Lands 控制和预处理语义尚未完成");
      continue;
    }
    if (name === "t") {
      const seen = seenThemeErrorsByInput.get(input.index) ?? new Set<string>();
      if (seen.has(unresolved.detail)) continue;
      seen.add(unresolved.detail);
      seenThemeErrorsByInput.set(input.index, seen);
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
            parserDetail: unresolved.detail,
          },
        ),
      );
      continue;
    }
    if (standardTags.has(name) || name === "v") {
      const seen =
        seenKnownTagErrorsByInput.get(input.index) ?? new Set<string>();
      if (seen.has(`${name}\0${unresolved.detail}`)) continue;
      seen.add(`${name}\0${unresolved.detail}`);
      seenKnownTagErrorsByInput.set(input.index, seen);
      findings.push(
        findingForMessage(
          input,
          "minimessage.tag-unresolved",
          `官方解析器未能解析标签 <${name}>：${unresolved.detail || "标签参数或形式无法识别"}`,
          { state: "recognized MiniMessage tag" },
          { tagName: name, parserDetail: unresolved.detail },
        ),
      );
      continue;
    }
    const tag = tagForUnresolved(input, unresolved);
    findings.push(
      findingForMessage(
        input,
        "minimessage.tag-unknown",
        `官方默认模式将未识别标签 <${name}> 保留为文本，无法确认其扩展语义`,
        { state: "recognized tag or supported extension" },
        {
          tag: tag?.raw ?? `<${name}>`,
          ...(tag === undefined ? {} : { position: tag.position.start }),
        },
      ),
    );
    unavailable.add("存在尚未识别的自定义 MiniMessage 标签");
  }
}

export async function parseMiniMessages(
  messages: readonly ObservedMessage[],
  resources: readonly ResourceInventoryEntry[],
  themeSnapshot?: MiniMessageThemeSnapshot,
): Promise<MiniMessageParseProject> {
  const theme = parseTheme(themeSnapshot);
  const collected = messagesToParseInputs(messages, resources);
  const java = await runOfficialParser(theme.definitions, collected.inputs);
  const findings = [...theme.findings];
  const unavailable = new Set<string>();
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
  appendParserFindings(
    collected.inputs,
    collected.documents,
    java,
    findings,
    unavailable,
  );
  const documentResults = collected.documents.map((document) => {
    const matchingInput = collected.inputs.find(
      (input) =>
        input.message.id === document.message.id &&
        input.origin === document.origin &&
        input.file === document.file &&
        JSON.stringify(input.path) === JSON.stringify(document.path) &&
        input.range.start <= document.range.start &&
        input.range.end >= document.range.end,
    );
    if (matchingInput === undefined) return document;
    const result = java.messages.get(matchingInput.index);
    return {
      ...document,
      status: parserStatus(matchingInput, java),
      ...(document.parent === undefined && result?.plainText !== undefined
        ? { plainText: result.plainText }
        : {}),
    };
  });
  return {
    documents: documentResults,
    themes: themeEntryResults(theme.definitions, java.themes),
    findings,
    unavailableCapabilities: [...unavailable].sort(),
  };
}
