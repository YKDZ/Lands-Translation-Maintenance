export { cli } from "#/cli-contract";
export { ProjectOperationError } from "#/operations";
export {
  initializeProject,
  inspectProject,
  operationExitCode,
  applySyncProject,
  previewSyncProject,
} from "#/operations";
export { builtInRules, evaluateRules } from "#/rules";
export type {
  InitializationOptions,
  SyncApplyOptions,
  SyncApplyResult,
} from "#/operations";
export type { RuleEvaluationOptions } from "#/rules";
export type {
  CheckCoverage,
  CheckRule,
  ConsumerConfiguration,
  Diagnostic,
  ProjectReport,
  ProjectView,
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
  SyncTargetFilePlan,
  SyncWrite,
} from "#/model";
