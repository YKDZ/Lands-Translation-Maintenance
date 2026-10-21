export { cli } from "#/cli-contract";
export { ProjectOperationError } from "#/operations";
export {
  initializeProject,
  inspectProject,
  operationExitCode,
} from "#/operations";
export { builtInRules, evaluateRules } from "#/rules";
export type { InitializationOptions } from "#/operations";
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
} from "#/model";
