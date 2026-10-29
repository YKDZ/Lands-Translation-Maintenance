import type {
  CheckCoverage,
  CheckRule,
  ConsumerConfiguration,
  Diagnostic,
  ProjectView,
  RuleEvaluation,
  RuleFinding,
  RuleConfiguration,
  RuleContext,
  Severity,
  RuleInputDependency,
} from "#/model";
import { canonicalJson, compareText, deepFreeze, sha256 } from "#/value";

const diagnosticInputDependencies = new WeakMap<
  Diagnostic,
  readonly RuleInputDependency[]
>();

export function inputDependenciesForDiagnostic(
  diagnostic: Diagnostic,
): readonly RuleInputDependency[] | undefined {
  return diagnosticInputDependencies.get(diagnostic);
}

const structureRule: CheckRule = {
  id: "structure",
  defaultSeverity: "error",
  evaluate(project) {
    const findings: RuleFinding[] = [];
    for (const issue of project.fileIssues) {
      findings.push({
        code: issue.code,
        location: {
          file: issue.file,
          path: issue.path,
          ...(issue.line === undefined ? {} : { line: issue.line }),
          ...(issue.column === undefined ? {} : { column: issue.column }),
        },
        reason: issue.reason,
        expected:
          issue.expected === undefined ? { state: "valid" } : issue.expected,
        actual:
          issue.actual === undefined
            ? {
                issue: issue.code,
                ...(issue.line === undefined ? {} : { line: issue.line }),
                ...(issue.column === undefined ? {} : { column: issue.column }),
              }
            : issue.actual,
      });
    }

    for (const message of project.messages) {
      if (message.targetStatus === "missing") {
        findings.push({
          code: "message.missing",
          message,
          location: { file: message.targetFile, path: message.path },
          reason: "受管理的译文消息缺失",
          expected: message.source,
          actual: { state: "missing" },
        });
      }
    }
    return findings;
  },
};

export const builtInRules: readonly CheckRule[] = [structureRule];

export interface RuleEvaluationOptions {
  readonly configuration?: ConsumerConfiguration["rules"];
  readonly unavailableCapabilities?: readonly string[];
}

function ruleSettings(
  configuration: ConsumerConfiguration["rules"],
  id: string,
): RuleConfiguration {
  return configuration?.[id] ?? {};
}

function diagnosticFromFinding(
  rule: CheckRule,
  severity: Severity,
  finding: RuleFinding,
  project: ProjectView,
): Diagnostic {
  const message = finding.message;
  const observed =
    message === undefined
      ? undefined
      : project.messages.find((entry) => entry.id === message.id);
  const objectId = sha256(
    canonicalJson({
      ruleId: rule.id,
      code: finding.code,
      messageId: message?.id,
      origin: finding.origin,
      location: {
        file: finding.location.file,
        path: finding.location.path,
      },
      identity: finding.identity ?? null,
    }),
  );
  const contentFingerprint = sha256(
    canonicalJson({
      ruleId: rule.id,
      severity,
      message:
        observed === undefined
          ? null
          : {
              source: observed.source,
              target:
                observed.target === undefined
                  ? { state: observed.targetStatus }
                  : observed.target,
              targetStatus: observed.targetStatus,
            },
      dependencies: finding.fingerprint ?? null,
      requiredInputDependencies: finding.requiredInputDependencies ?? null,
      expected: finding.expected,
      actual: finding.actual,
    }),
  );
  const diagnosticId = sha256(
    canonicalJson({
      ruleId: rule.id,
      code: finding.code,
      objectId,
      contentFingerprint,
    }),
  );
  const diagnostic: Diagnostic = {
    diagnosticId,
    objectId,
    contentFingerprint,
    ruleId: rule.id,
    severity,
    code: finding.code,
    ...(message === undefined ? {} : { message }),
    ...(finding.origin === undefined ? {} : { origin: finding.origin }),
    location: finding.location,
    reason: finding.reason,
    expected: finding.expected,
    actual: finding.actual,
  };
  if (finding.requiredInputDependencies !== undefined) {
    diagnosticInputDependencies.set(
      diagnostic,
      finding.requiredInputDependencies,
    );
  }
  return diagnostic;
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return compareText(canonicalJson(left), canonicalJson(right));
}

export function evaluateRules(
  project: ProjectView,
  registeredRules: readonly CheckRule[] = builtInRules,
  options: RuleEvaluationOptions = {},
): RuleEvaluation {
  const rulesById = new Map<string, CheckRule>();
  for (const rule of registeredRules) {
    if (rulesById.has(rule.id)) throw new Error(`重复注册规则：${rule.id}`);
    rulesById.set(rule.id, rule);
  }

  const enabledRuleIds: string[] = [];
  const disabledRuleIds: string[] = [];
  const unsupportedRuleIds: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const configured = options.configuration ?? {};

  for (const configuredId of Object.keys(configured).sort()) {
    if (!rulesById.has(configuredId)) unsupportedRuleIds.push(configuredId);
  }

  for (const rule of [...registeredRules].sort((left, right) =>
    compareText(left.id, right.id),
  )) {
    const settings = ruleSettings(configured, rule.id);
    if (settings.enabled === false) {
      disabledRuleIds.push(rule.id);
      continue;
    }
    enabledRuleIds.push(rule.id);
    const severity = settings.severity ?? rule.defaultSeverity;
    const context: RuleContext = deepFreeze({
      severity,
      parameters: structuredClone(settings.parameters ?? {}),
    });
    const ruleInput = deepFreeze(structuredClone(project));
    try {
      const findings = rule.evaluate(ruleInput, context);
      for (const finding of findings) {
        const findingSeverity =
          settings.severity ?? finding.severity ?? severity;
        diagnostics.push(
          diagnosticFromFinding(rule, findingSeverity, finding, project),
        );
      }
    } catch (error) {
      diagnostics.push(
        diagnosticFromFinding(
          rule,
          severity,
          {
            code: "rule.execution-failed",
            location: { file: rule.id, path: [] },
            reason: `规则执行失败：${error instanceof Error ? error.message : String(error)}`,
            expected: { state: "rule-result" },
            actual: { state: "execution-failed" },
          },
          project,
        ),
      );
      unsupportedRuleIds.push(rule.id);
    }
  }

  diagnostics.sort(compareDiagnostics);
  const disabled = [...new Set(disabledRuleIds)].sort();
  const unsupported = [...new Set(unsupportedRuleIds)].sort();
  const unavailable = [...(options.unavailableCapabilities ?? [])].sort();
  const coverage: CheckCoverage = {
    complete:
      disabled.length === 0 &&
      unsupported.length === 0 &&
      unavailable.length === 0,
    enabledRuleIds: enabledRuleIds.sort(),
    disabledRuleIds: disabled,
    unsupportedRuleIds: unsupported,
    unavailableCapabilities: unavailable,
  };
  return { diagnostics, coverage };
}
