export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type Severity = "error" | "warning" | "info";

export type ResourcePurpose =
  | "chat-language"
  | "gui-language"
  | "dialog-language"
  | "configuration"
  | "metadata"
  | "documentation"
  | "bedrock-excluded"
  | "other-excluded";

export type TranslationFieldCategory =
  | "chat-string"
  | "chat-string-list"
  | "gui-string"
  | "gui-lore"
  | "dialog-string"
  | "dialog-label-format"
  | "configuration-string"
  | "configuration-string-list";

export type TranslationFieldScene =
  | "gui-general"
  | "gui-title"
  | "gui-item-name"
  | "gui-item-lore"
  | "dialog-title"
  | "dialog-button-label"
  | "dialog-button-tooltip"
  | "dialog-input-label"
  | "dialog-label-format"
  | "dialog-body-text"
  | "category-name"
  | "category-description"
  | "level-title"
  | "level-attribute-description"
  | "level-requirement-title"
  | "level-requirement-description"
  | "role-name";

export type TranslationFormat =
  | "plain"
  | "minimessage"
  | "legacy-color"
  | "legacy-color-minimessage"
  | "label-format"
  | "legacy-variable"
  | "legacy-variable-minimessage"
  | "legacy-color-variable-minimessage"
  | "map-html-minimessage";

export const translationFieldScenes = [
  "gui-general",
  "gui-title",
  "gui-item-name",
  "gui-item-lore",
  "dialog-title",
  "dialog-button-label",
  "dialog-button-tooltip",
  "dialog-input-label",
  "dialog-label-format",
  "dialog-body-text",
  "category-name",
  "category-description",
  "level-title",
  "level-attribute-description",
  "level-requirement-title",
  "level-requirement-description",
  "role-name",
] as const satisfies readonly TranslationFieldScene[];

export const translationFieldCategories = [
  "chat-string",
  "chat-string-list",
  "gui-string",
  "gui-lore",
  "dialog-string",
  "dialog-label-format",
  "configuration-string",
  "configuration-string-list",
] as const satisfies readonly TranslationFieldCategory[];

export const translationFormats = [
  "plain",
  "minimessage",
  "legacy-color",
  "legacy-color-minimessage",
  "label-format",
  "legacy-variable",
  "legacy-variable-minimessage",
  "legacy-color-variable-minimessage",
  "map-html-minimessage",
] as const satisfies readonly TranslationFormat[];

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

/** MiniMessage 接收适配后的内容，同时保留到原始 UTF-16 边界的位置映射。 */
export interface AdaptedMiniMessageInput {
  readonly input: string;
  readonly sourceOffsets: readonly number[];
  readonly exact: boolean;
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
  readonly raw: string;
  /** 官方 MiniMessage 树节点实际贡献给 PlainText 的可见文本。 */
  readonly visibleText: string;
  /** visibleText 每个 UTF-16 边界对应的原始消息边界。 */
  readonly visibleSourceOffsets: readonly number[];
  readonly position: MiniMessagePosition;
  readonly context: readonly MiniMessageContextFrame[];
}

export interface MiniMessageTagNode {
  readonly kind: "tag";
  readonly raw: string;
  /** 官方插入组件或字面化节点实际贡献给 PlainText 的可见文本。 */
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
}

export interface TranslatableTextSegment {
  readonly kind: "text" | "variable" | "command" | "structure" | "boundary";
  /** 可读正文或受保护对象的身份；命令、结构片段不会作为正文检查。 */
  readonly value: string;
  readonly raw: string;
  readonly position: MiniMessagePosition;
  readonly context: readonly MiniMessageContextFrame[];
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
  /** 用于区分同一规则、消息和路径下的不同出现位置；不要包含可变内容。 */
  readonly identity?: JsonValue;
  /** 此诊断实际依赖的规则配置或外部内容。 */
  readonly fingerprint?: JsonValue;
  readonly message?: MessageIdentity;
  readonly origin: MiniMessageOrigin;
  readonly location: DiagnosticLocation;
  readonly reason: string;
  readonly expected: JsonValue;
  readonly actual: JsonValue;
}

export interface MiniMessageParseProject {
  readonly sourceVersion: string;
  readonly documents: readonly ParsedMiniMessageDocument[];
  readonly translatableText: readonly TranslatableTextDocument[];
  readonly themes: readonly MiniMessageThemeEntry[];
  readonly findings: readonly MiniMessageFinding[];
  readonly mapFindings: readonly MiniMessageFinding[];
  readonly unavailableCapabilities: readonly string[];
}

export interface ResourceInventoryEntry {
  readonly path: string;
  readonly purpose: ResourcePurpose;
}

export interface KnownExcludedResource extends ResourceInventoryEntry {
  readonly purpose: "bedrock-excluded" | "other-excluded";
}

export interface TranslationField {
  readonly path: readonly string[];
  readonly category: TranslationFieldCategory;
  readonly scene?: TranslationFieldScene;
}

export interface TranslationMapping {
  readonly source: string;
  readonly target: string;
  readonly definitionsSource?: string;
  readonly fields: readonly TranslationField[];
}

export interface RuleConfiguration {
  readonly enabled?: boolean;
  readonly severity?: Severity;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface ConsumerConfiguration {
  readonly schemaVersion: 1;
  readonly source: {
    readonly version: string;
    readonly translationHistory: string;
  };
  readonly resources: readonly ResourceInventoryEntry[];
  readonly translationScope: {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly mappings: readonly TranslationMapping[];
  };
  readonly rules?: Readonly<Record<string, RuleConfiguration>>;
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

export interface ObservedMessage extends MessageIdentity {
  readonly source: JsonValue;
  readonly target: JsonValue | undefined;
  readonly targetStatus: "present" | "missing" | "blocked";
}

export interface ProjectView {
  readonly sourceVersion?: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly resources: readonly ResourceInventoryEntry[];
  readonly messages: readonly ObservedMessage[];
  readonly targetMessages: readonly TargetMessage[];
  readonly structures: readonly ProjectStructure[];
  readonly knownOutOfScopeVisibleTexts: readonly KnownOutOfScopeVisibleText[];
  readonly fileIssues: readonly ProjectFileIssue[];
  readonly miniMessage?: MiniMessageParseProject;
}

export interface KnownOutOfScopeVisibleText {
  readonly file: string;
  readonly path: readonly string[];
  readonly value: string;
}

export interface ProjectStructure {
  readonly sourceFile: string;
  readonly definitionsSource: string;
  readonly targetFile: string;
  readonly definitions: JsonValue;
  readonly target: JsonValue | undefined;
  readonly translationPaths: readonly (readonly string[])[];
}

export interface TargetMessage extends Omit<MessageIdentity, "id"> {
  readonly id: string;
  readonly value: JsonValue;
}

export interface ProjectFileIssue {
  readonly file: string;
  readonly code: string;
  readonly reason: string;
  readonly path: readonly (string | number)[];
  readonly expected?: JsonValue;
  readonly actual?: JsonValue;
  readonly line?: number;
  readonly column?: number;
}

export interface DiagnosticLocation {
  readonly file: string;
  readonly path: readonly (string | number)[];
  readonly line?: number;
  readonly column?: number;
}

export interface Diagnostic {
  readonly diagnosticId: string;
  readonly objectId: string;
  readonly contentFingerprint: string;
  readonly ruleId: string;
  readonly severity: Severity;
  readonly code: string;
  readonly message?: MessageIdentity;
  readonly origin?: MiniMessageOrigin;
  readonly location: DiagnosticLocation;
  readonly reason: string;
  readonly expected: JsonValue;
  readonly actual: JsonValue;
}

export interface RuleFinding {
  readonly code: string;
  /** 用于区分同一规则、消息和路径下的不同问题对象；不要包含可变内容。 */
  readonly identity?: JsonValue;
  /** 此诊断实际依赖的规则配置或外部内容。 */
  readonly fingerprint?: JsonValue;
  readonly message?: MessageIdentity;
  readonly origin?: MiniMessageOrigin;
  readonly location: DiagnosticLocation;
  readonly reason: string;
  readonly expected: JsonValue;
  readonly actual: JsonValue;
}

export interface RuleContext {
  readonly severity: Severity;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export type RuleInput = "minimessage-parse";

export interface CheckRule {
  readonly id: string;
  readonly defaultSeverity: Severity;
  readonly requiredInputs?: readonly RuleInput[];
  evaluate(project: ProjectView, context: RuleContext): readonly RuleFinding[];
}

export interface ProjectSummary {
  readonly resourceFiles: number;
  readonly messages: number;
  readonly pendingTranslations: number;
  readonly sameTextCandidates: number;
  readonly confirmedSameText: number;
  readonly modifiedTranslations: number;
  readonly missingTranslations: number;
}

export interface CheckCoverage {
  readonly complete: boolean;
  readonly enabledRuleIds: readonly string[];
  readonly disabledRuleIds: readonly string[];
  readonly unsupportedRuleIds: readonly string[];
  readonly unavailableCapabilities: readonly string[];
}

export interface ProjectReport {
  readonly operation: "init" | "status" | "check";
  readonly state: "ready" | "issues" | "incomplete";
  readonly summary: ProjectSummary;
  readonly diagnostics: readonly Diagnostic[];
  readonly sameTextToConfirm: readonly {
    readonly candidateId: string;
    readonly message: MessageIdentity;
    readonly source: JsonValue;
    readonly target: JsonValue;
    readonly pendingReason: "translation-seed" | "same-text-candidate";
  }[];
  readonly knownExcludedResources: readonly KnownExcludedResource[];
  readonly knownOutOfScopeVisibleTexts: readonly KnownOutOfScopeVisibleText[];
  readonly coverage?: CheckCoverage;
}

export interface RuleEvaluation {
  readonly diagnostics: readonly Diagnostic[];
  readonly coverage: CheckCoverage;
}

export interface InitializationResult {
  readonly ok: boolean;
  readonly report: ProjectReport;
}

export interface StatusResult {
  readonly ok: boolean;
  readonly report: ProjectReport;
}

export interface CheckResult {
  readonly report: ProjectReport;
}

export interface SyncMessageChange {
  readonly id: string;
  readonly action: "preserve" | "seed" | "reset" | "delete";
  readonly reason:
    | "unchanged"
    | "target-path-blocked"
    | "missing-translation"
    | "new-message"
    | "source-changed"
    | "source-removed"
    | "orphaned-translation";
  readonly sourceFile: string;
  readonly targetFile: string;
  readonly path: readonly string[];
  readonly category: TranslationFieldCategory;
  readonly scene?: TranslationFieldScene;
  readonly format?: TranslationFormat;
  readonly previousSource?: JsonValue;
  readonly source?: JsonValue;
  readonly previousTarget?: JsonValue;
  readonly target?: JsonValue;
}

export interface SyncStructureChange {
  readonly sourceFile: string;
  readonly definitionsSource: string;
  readonly targetFile: string;
  readonly path: readonly string[];
  readonly action: "preserve" | "update" | "delete";
  readonly previous?: JsonValue;
  readonly expected?: JsonValue;
}

export interface SyncResourceChanges {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly observedOnly: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
  };
}

export interface SyncResourceDifference {
  readonly undeclared: readonly string[];
  readonly missing: readonly string[];
  readonly duplicates: readonly string[];
}

export interface SyncBlocker {
  readonly code: string;
  readonly reason: string;
}

export interface SyncInputSnapshot {
  readonly path: string;
  readonly sha256?: string;
}

export interface SyncWrite {
  readonly kind: "target" | "baseline" | "lock";
  readonly path: string;
  readonly content: string;
  readonly expectedSha256?: string;
}

export interface SyncTargetFilePlan {
  readonly path: string;
  readonly action: "write" | "unchanged";
  readonly expectedSha256?: string;
  readonly contentSha256: string;
}

export interface SyncPlan {
  readonly sourceVersion: string;
  readonly jarSha256: string;
  readonly resourceChanges: SyncResourceChanges;
  readonly messages: readonly SyncMessageChange[];
  readonly structures: readonly SyncStructureChange[];
  readonly targetFiles: readonly SyncTargetFilePlan[];
  readonly unmanagedTargets: readonly string[];
  readonly pendingTranslations: readonly string[];
  readonly inputSnapshots: readonly SyncInputSnapshot[];
  readonly writes: readonly SyncWrite[];
}

export type SyncPreviewResult =
  | {
      readonly ready: true;
      readonly plan: SyncPlan;
    }
  | {
      readonly ready: false;
      readonly blockers: readonly SyncBlocker[];
      readonly resourceDifference: SyncResourceDifference;
      readonly resourceChanges: SyncResourceChanges;
    };
