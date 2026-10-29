import { defineQualityCheck } from "@lioni/lioni";

import type {
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import {
  mapHtmlFindings,
  mapHtmlIssues,
  mapHtmlMessage,
} from "#/map-html-quality";
import type { MiniMessageIncompleteFact } from "#/mini-message-model";
import {
  dependenciesOf,
  findingForQuality,
  issueForQuality,
  miniMessageQualityConfigurationSchema,
  outcome,
  qualityBasis,
  type MiniMessageCheckInput,
  type MiniMessageQualityObject,
} from "#/minimessage-quality";
import type { JsonValue } from "#/json-value";

function mapBasis(input: MiniMessageCheckInput): JsonValue {
  const dependencies = dependenciesOf(input.dependencies);
  const message = dependencies.messages.find(
    (candidate) => candidate.id === input.candidate.sourceKey,
  );
  const findings = mapHtmlFindings(
    dependencies,
    input.candidate.sourceKey,
    "target",
  );
  const issues = mapHtmlIssues(input, input.candidate.sourceKey);
  return qualityBasis({
    message:
      message === undefined
        ? null
        : {
            id: message.id,
            sourceFile: message.sourceFile,
            targetFile: message.targetFile,
            path: message.path,
            format: message.format ?? null,
            source: message.source,
            target: input.candidate.content,
          },
    sourceVersion: findings.some(({ code }) =>
      code.startsWith("map-html.variable-"),
    )
      ? dependencies.sourceVersion
      : null,
    findings: findings.map((finding) => ({
      code: finding.code,
      origin: finding.origin,
      location: finding.location,
      position: finding.position ?? null,
      reason: finding.reason,
      expected: finding.expected,
      actual: finding.actual,
    })),
    incomplete: issues.map(({ code, reason, location }) => ({
      code,
      reason,
      location: location ?? null,
    })),
  });
}

export const mapHtmlCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof miniMessageQualityConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "map-html",
  version: "1",
  configurationSchema: miniMessageQualityConfigurationSchema,
  configuration: {},
  fingerprintInput: mapBasis,
  check(input) {
    const dependencies = dependenciesOf(input.dependencies);
    const message = mapHtmlMessage(input);
    if (message === undefined) return outcome("not-applicable", [], []);
    if (input.sourceUnit === null) {
      const issue: MiniMessageIncompleteFact = {
        code: "minimessage.source-unit-unavailable",
        message,
        reason: "原生 QA 候选没有对应 Lands 原文事实",
      };
      return outcome(
        "incomplete",
        [],
        [issueForQuality(issue, input.candidate)],
      );
    }

    const issues = mapHtmlIssues(input, message.id);
    const diagnostics = mapHtmlFindings(dependencies, message.id, "target").map(
      (finding) => findingForQuality(finding, input.candidate),
    );
    return outcome(
      issues.length === 0 ? "complete" : "incomplete",
      diagnostics,
      issues.map((issue) => issueForQuality(issue, input.candidate)),
    );
  },
});
