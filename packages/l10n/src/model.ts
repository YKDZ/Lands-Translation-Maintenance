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
  | "configuration"
  | "metadata"
  | "documentation"
  | "bedrock-excluded"
  | "other-excluded";

export type ChatFieldCategory = "chat-string" | "chat-string-list";

export interface ResourceInventoryEntry {
  readonly path: string;
  readonly purpose: ResourcePurpose;
}

export interface TranslationField {
  readonly path: readonly string[];
  readonly category: ChatFieldCategory;
}

export interface TranslationMapping {
  readonly source: string;
  readonly target: string;
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
  readonly category: ChatFieldCategory;
}

export interface ObservedMessage extends MessageIdentity {
  readonly source: JsonValue;
  readonly target: JsonValue | undefined;
}

export interface ProjectView {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly resources: readonly ResourceInventoryEntry[];
  readonly messages: readonly ObservedMessage[];
  readonly targetMessages: readonly TargetMessage[];
  readonly fileIssues: readonly ProjectFileIssue[];
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
  readonly ruleId: string;
  readonly severity: Severity;
  readonly code: string;
  readonly message?: MessageIdentity;
  readonly location: DiagnosticLocation;
  readonly reason: string;
  readonly expected: JsonValue;
  readonly actual: JsonValue;
}

export interface RuleFinding {
  readonly code: string;
  readonly message?: MessageIdentity;
  readonly location: DiagnosticLocation;
  readonly reason: string;
  readonly expected: JsonValue;
  readonly actual: JsonValue;
}

export interface RuleContext {
  readonly severity: Severity;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface CheckRule {
  readonly id: string;
  readonly defaultSeverity: Severity;
  evaluate(project: ProjectView, context: RuleContext): readonly RuleFinding[];
}

export interface ProjectSummary {
  readonly resourceFiles: number;
  readonly messages: number;
  readonly pendingTranslations: number;
  readonly sameTextCandidates: number;
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
