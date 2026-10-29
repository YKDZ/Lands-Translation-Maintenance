import type { JsonValue } from "#/json-value";
import type {
  ResourceInventoryEntry,
  TranslationFieldCategory,
  TranslationFieldScene,
  TranslationFormat,
} from "#/lioni/lands-model";

export type MiniMessageSurface = "chat" | "gui" | "dialog" | "bedrock";

export type MiniMessageOrigin = "source" | "target" | "theme";

export interface MiniMessageThemeSnapshot {
  readonly file: string;
  readonly source: string;
}

export interface MiniMessagePosition {
  readonly start: number;
  readonly end: number;
}

export interface DiagnosticLocation {
  readonly file: string;
  readonly path: readonly (string | number)[];
  readonly line?: number;
  readonly column?: number;
}

export interface MessageIdentity {
  readonly id: string;
  readonly sourceFile: string;
  readonly targetFile: string;
  readonly path: readonly string[];
  readonly category: TranslationFieldCategory;
  readonly scene?: TranslationFieldScene;
  readonly format?: TranslationFormat;
}

export interface VariableContextPart {
  readonly kind: string;
  readonly identity: JsonValue;
}

export interface VariableOccurrence {
  readonly name: string;
  readonly context: readonly VariableContextPart[];
  readonly position?: MiniMessagePosition;
}

export interface VariableCountDifference {
  readonly name: string;
  readonly context: readonly VariableContextPart[];
  readonly expectedCount: number;
  readonly actualCount: number;
  readonly expectedPositions: readonly MiniMessagePosition[];
  readonly actualPositions: readonly MiniMessagePosition[];
}

/** MiniMessage 接收适配后的内容，同时保留到原始 UTF-16 边界的位置映射。 */
export interface AdaptedMiniMessageInput {
  readonly input: string;
  readonly sourceOffsets: readonly number[];
  readonly exact: boolean;
}

export interface MiniMessageContextFrame {
  readonly kind:
    | "tag"
    | "hover-text"
    | "tag-argument"
    | "html-element"
    | "html-attribute";
  readonly name: string;
  readonly position: MiniMessagePosition;
}

export interface MiniMessageTextNode {
  readonly kind: "text";
  /** 官方 MiniMessage 树节点实际贡献给 PlainText 的可见文本。 */
  readonly raw: string;
  readonly visibleText: string;
  /** visibleText 每个 UTF-16 边界对应的原始消息边界。 */
  readonly visibleSourceOffsets: readonly number[];
  readonly position: MiniMessagePosition;
  readonly context: readonly MiniMessageContextFrame[];
}

export interface MiniMessageTagNode {
  readonly kind: "tag";
  /** 官方插入组件或字面化节点实际贡献给 PlainText 的可见文本。 */
  readonly raw: string;
  readonly visibleText: string;
  /** visibleText 每个 UTF-16 边界对应的原始消息边界。 */
  readonly visibleSourceOffsets: readonly number[];
  readonly name: string;
  readonly parameters: readonly string[];
  readonly parameterPositions: readonly MiniMessagePosition[];
  readonly parameterSourceOffsets: readonly (readonly number[])[];
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly semanticKind:
    | "style"
    | "content"
    | "lands-control"
    | "lands-preprocess"
    | "unknown";
  readonly position: MiniMessagePosition;
  readonly context: readonly MiniMessageContextFrame[];
}

export type MiniMessageSourceNode = MiniMessageTextNode | MiniMessageTagNode;

export interface MiniMessageListItemRange {
  readonly path: readonly (string | number)[];
  readonly position: MiniMessagePosition;
}

export interface MiniMessageInputMessage extends MessageIdentity {
  readonly source: JsonValue;
  readonly target?: JsonValue | undefined;
  readonly targetStatus: "present" | "missing" | "blocked";
  /** GUI lore 仍按完整字段解析；此映射把解析位置还原到原列表项。 */
  readonly listItems?: readonly MiniMessageListItemRange[];
}

export interface ParsedMiniMessageDocument {
  readonly message: MessageIdentity;
  readonly documentIndex: number;
  readonly origin: "source" | "target";
  readonly file: string;
  readonly path: readonly (string | number)[];
  readonly surface: MiniMessageSurface;
  readonly input: string;
  readonly range: MiniMessagePosition;
  readonly status: "parsed" | "syntax-invalid" | "parser-failed";
  readonly plainText?: string;
  readonly nodes: readonly MiniMessageSourceNode[];
  readonly context: readonly MiniMessageContextFrame[];
  readonly parent?: MiniMessageContextFrame;
  readonly listItems?: readonly MiniMessageListItemRange[];
}

export interface TranslatableTextSegment {
  readonly kind: "text" | "variable" | "command" | "structure" | "boundary";
  /** 可读正文或受保护对象的身份；命令、结构片段不会作为正文检查。 */
  readonly value: string;
  readonly raw: string;
  readonly position: MiniMessagePosition;
  readonly context: readonly MiniMessageContextFrame[];
  readonly path?: readonly (string | number)[];
}

/** 供术语和文风检查只读消费的正文视图；每个嵌套 hover 仍是独立文档。 */
export interface TranslatableTextDocument {
  readonly message: MessageIdentity;
  readonly documentIndex: number;
  readonly origin: "source" | "target";
  readonly file: string;
  readonly path: readonly (string | number)[];
  readonly surface: MiniMessageSurface;
  readonly range: MiniMessagePosition;
  readonly context: readonly MiniMessageContextFrame[];
  readonly segments: readonly TranslatableTextSegment[];
}

export interface MiniMessageThemeStyle {
  readonly color: string | null;
  readonly decorations: Readonly<Record<string, "true" | "false" | "not_set">>;
}

export interface MiniMessageThemeEntry {
  readonly file: string;
  readonly path: readonly (string | number)[];
  readonly surface: MiniMessageSurface;
  readonly name: string;
  readonly source: string;
  readonly style?: MiniMessageThemeStyle;
}

export interface MiniMessageFinding {
  readonly code: string;
  /** 旧只读调用仍消费这些载荷；原生质量适配不据此构造身份或指纹。 */
  readonly identity?: JsonValue;
  readonly fingerprint?: JsonValue;
  readonly message?: MessageIdentity;
  readonly origin: MiniMessageOrigin;
  readonly location: DiagnosticLocation;
  readonly position?: MiniMessagePosition;
  readonly reason: string;
  readonly expected: JsonValue;
  readonly actual: JsonValue;
}

export interface MiniMessageIncompleteFact {
  readonly code: string;
  readonly message?: MessageIdentity;
  readonly origin?: MiniMessageOrigin;
  readonly location?: DiagnosticLocation;
  readonly reason: string;
}

export interface MiniMessageParseProject {
  readonly sourceVersion: string;
  readonly documents: readonly ParsedMiniMessageDocument[];
  readonly translatableText: readonly TranslatableTextDocument[];
  readonly themes: readonly MiniMessageThemeEntry[];
  readonly findings: readonly MiniMessageFinding[];
  readonly syntaxFindings: readonly MiniMessageFinding[];
  readonly themeFindings: readonly MiniMessageFinding[];
  readonly formatFindings: readonly MiniMessageFinding[];
  readonly mapFindings: readonly MiniMessageFinding[];
  readonly incompleteFacts: readonly MiniMessageIncompleteFact[];
  readonly unavailableCapabilities: readonly string[];
}

export interface MiniMessageThemeInput {
  readonly theme?: MiniMessageThemeSnapshot;
  readonly issues: readonly MiniMessageIncompleteFact[];
}

export interface MiniMessageProjectionInput {
  readonly messages: readonly MiniMessageInputMessage[];
  readonly resources: readonly ResourceInventoryEntry[];
  readonly theme: MiniMessageThemeInput;
  readonly sourceVersion: string;
}
