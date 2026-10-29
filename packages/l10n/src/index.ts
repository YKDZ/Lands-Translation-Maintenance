export { cli } from "#/cli-contract";
export { ProjectOperationError } from "#/operations";
export {
  initializeProject,
  inspectProject,
  operationExitCode,
  recordException,
} from "#/operations";
export { builtInRules, evaluateRules } from "#/rules";
export type {
  InitializationOptions,
  ExceptionRecordingOptions,
  ExceptionReceipt,
} from "#/operations";
export type { RuleEvaluationOptions } from "#/rules";
export type {
  CheckCoverage,
  CheckRule,
  ConsumerConfiguration,
  Diagnostic,
  JsonValue,
  KnownOutOfScopeVisibleText,
  MessageIdentity,
  ProjectReport,
  ProjectStructure,
  ProjectView,
  ResourceInventoryDifference,
  ResourceInventoryEntry,
  ResourcePurpose,
  RuleContext,
  RuleFinding,
  RuleEvaluation,
  TranslationField,
  TranslationFieldCategory,
  TranslationFieldScene,
  TranslationFormat,
  TranslationMapping,
} from "#/model";
export { formatForScene, sceneMatchesCategory } from "#/field-metadata";

export type { CheckConclusion, ExceptionRecord } from "#/model";
