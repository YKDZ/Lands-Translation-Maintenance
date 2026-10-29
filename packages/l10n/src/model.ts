import type {
  MiniMessageOrigin,
  MiniMessageParseProject,
  MiniMessagePosition,
} from "#/mini-message-model";

export type {
  AdaptedMiniMessageInput,
  MiniMessageContextFrame,
  MiniMessageFinding,
  MiniMessageIncompleteFact,
  MiniMessageInputMessage,
  MiniMessageListItemRange,
  MiniMessageOrigin,
  MiniMessageParseProject,
  MiniMessagePosition,
  MiniMessageSourceNode,
  MiniMessageSurface,
  MiniMessageTagNode,
  MiniMessageTextNode,
  MiniMessageThemeEntry,
  MiniMessageThemeInput,
  MiniMessageThemeSnapshot,
  MiniMessageThemeStyle,
  ParsedMiniMessageDocument,
  TranslatableTextDocument,
  TranslatableTextSegment,
} from "#/mini-message-model";

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
  readonly translationReview?: {
    readonly pendingReason?: "translation-seed" | "same-text-candidate";
    readonly confirmedSameText: boolean;
  };
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
  /** 单条诊断的默认严重级别；规则配置中的严重级别仍可统一覆盖。 */
  readonly severity?: Severity;
  /** 用于区分同一规则、消息和路径下的不同问题对象；不要包含可变内容。 */
  readonly identity?: JsonValue;
  /** 此诊断实际依赖的规则配置或外部内容。 */
  readonly fingerprint?: JsonValue;
  /** 此诊断评估所需的局部输入文档，用于例外判断输入是否仍可用。 */
  readonly requiredInputDependencies?: readonly RuleInputDependency[];
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

export interface RuleInputDependency {
  readonly input: RuleInput;
  readonly messageId: string;
  readonly origin: MiniMessageOrigin;
  readonly documentIndex: number;
  readonly path: readonly (string | number)[];
}

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

export interface ConclusionSubject {
  readonly id: string;
  readonly objectId: string;
  readonly contentFingerprint: string;
  readonly ruleId: string;
  readonly code: string;
  readonly message?: MessageIdentity;
  readonly origin?: MiniMessageOrigin;
  readonly requiredInputDependencies?: readonly RuleInputDependency[];
  readonly location: DiagnosticLocation;
}

export interface CheckConclusion extends ConclusionSubject {
  readonly description: string;
  readonly expected: JsonValue;
  readonly actual: JsonValue;
}

export interface ExceptionRecord extends ConclusionSubject {
  readonly reason: string;
}

export type SameTextPendingReason = "translation-seed" | "same-text-candidate";

export interface ProjectReport {
  readonly operation: "init" | "status" | "check";
  readonly state: "ready" | "issues" | "incomplete";
  readonly summary: ProjectSummary;
  readonly diagnostics: readonly Diagnostic[];
  readonly exceptionCandidates: readonly CheckConclusion[];
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
