export { cli } from "#/cli-contract";
export { ProjectOperationError } from "#/operations";
export {
  initializeProject,
  inspectProject,
  operationExitCode,
  applySyncProject,
  previewSyncProject,
  recordDiagnosticExemption,
  confirmSameText,
} from "#/operations";
export { builtInRules, evaluateRules } from "#/rules";
export type {
  InitializationOptions,
  SyncApplyOptions,
  SyncApplyResult,
  ExceptionRecordingOptions,
  ConfirmationReceipt,
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
  ResourceInventoryEntry,
  ResourcePurpose,
  RuleContext,
  RuleFinding,
  RuleEvaluation,
  SyncBlocker,
  SyncInputSnapshot,
  SyncMessageChange,
  SyncPlan,
  SyncPreviewResult,
  SyncResourceChanges,
  SyncResourceDifference,
  SyncStructureChange,
  SyncTargetFilePlan,
  SyncWrite,
  TranslationField,
  TranslationFieldCategory,
  TranslationFieldScene,
  TranslationFormat,
  TranslationMapping,
} from "#/model";
export { formatForScene, sceneMatchesCategory } from "#/field-metadata";
