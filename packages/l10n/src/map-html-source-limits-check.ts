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

function sourceLimitBasis(input: MiniMessageCheckInput): JsonValue {
  const dependencies = dependenciesOf(input.dependencies);
  const message = dependencies.messages.find(
    (candidate) => candidate.id === input.candidate.sourceKey,
  );
  return qualityBasis({
    sourceVersion: dependencies.sourceVersion,
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
    findings: mapHtmlFindings(
      dependencies,
      input.candidate.sourceKey,
      "source",
    ).map((finding) => ({
      code: finding.code,
      location: finding.location,
      position: finding.position ?? null,
      reason: finding.reason,
      expected: finding.expected,
      actual: finding.actual,
    })),
    incomplete: mapHtmlIssues(input, input.candidate.sourceKey).map(
      ({ code, reason, location }) => ({
        code,
        reason,
        location: location ?? null,
      }),
    ),
  });
}

export const mapHtmlSourceLimitsCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof miniMessageQualityConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "map-html-source-limits",
  version: "1",
  configurationSchema: miniMessageQualityConfigurationSchema,
  configuration: {},
  fingerprintInput: sourceLimitBasis,
  check(input) {
    const dependencies = dependenciesOf(input.dependencies);
    const message = mapHtmlMessage(input);
    if (message === undefined) return outcome("not-applicable", [], []);
    if (input.sourceUnit === null) {
      return outcome(
        "incomplete",
        [],
        [
          issueForQuality(
            {
              code: "minimessage.source-unit-unavailable",
              message,
              reason: "原生 QA 候选没有对应 Lands 原文事实",
            },
            input.candidate,
          ),
        ],
      );
    }

    const issues = mapHtmlIssues(input, message.id);
    const diagnostics = mapHtmlFindings(dependencies, message.id, "source").map(
      (finding) => ({
        ...findingForQuality(finding, input.candidate),
        severity: "warning" as const,
      }),
    );
    return outcome(
      issues.length === 0 ? "complete" : "incomplete",
      diagnostics,
      issues.map((issue) => issueForQuality(issue, input.candidate)),
    );
  },
});
