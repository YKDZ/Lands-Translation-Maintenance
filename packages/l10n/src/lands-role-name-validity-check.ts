import { defineQualityCheck } from "@lioni/lioni";
import type { QualityFinding, QualityLocation } from "@lioni/lioni";

import type { JsonValue } from "#/json-value";
import type {
  LandsJson,
  LandsTranslation,
  LandsUnit,
  UnavailableTranslation,
} from "#/lioni/lands-facts";
import type { MiniMessageIncompleteFact } from "#/mini-message-model";
import {
  dependenciesOf,
  hasMiniMessageInput,
  issueForQuality,
  messageForCandidate,
  miniMessageQualityConfigurationSchema,
  outcome,
  qualityBasis,
  type MiniMessageCheckInput,
  type MiniMessageQualityObject,
} from "#/minimessage-quality";

function roleNameBasis(input: MiniMessageCheckInput): JsonValue {
  const dependencies = dependenciesOf(input.dependencies);
  const role = dependencies.projection.roleNames.find(
    ({ message }) => message.id === input.candidate.sourceKey,
  );
  return qualityBasis({
    sourceVersion: dependencies.sourceVersion,
    message:
      role === undefined
        ? null
        : {
            id: role.message.id,
            sourceFile: role.message.sourceFile,
            targetFile: role.message.targetFile,
            path: role.message.path,
            category: role.message.category,
            scene: role.message.scene ?? null,
            format: role.message.format ?? null,
            source: role.message.source,
            target: input.candidate.content ?? { state: "unavailable" },
          },
    validation: role?.validation ?? { status: "unavailable" },
  });
}

function roleNameIssues(input: MiniMessageCheckInput) {
  const dependencies = dependenciesOf(input.dependencies);
  return dependencies.readIssues.filter(
    (issue) =>
      issue.message === undefined ||
      issue.message.id === input.candidate.sourceKey,
  );
}

function reasonForRule(rule: string): string {
  switch (rule) {
    case "blank":
      return "角色名不能为空或只含空白";
    case "reserved":
      return "角色名不能使用 here 或 all";
    case "markup":
      return "角色名渲染文本不能留下尖括号标记";
    case "space":
      return "角色名不能包含普通 ASCII 空格";
    case "character":
      return "角色名包含 Lands 固定规则不允许的字符";
    default:
      return "角色名不符合 Lands 固定规则";
  }
}

function roleNameFinding(
  input: MiniMessageCheckInput,
  message: NonNullable<ReturnType<typeof messageForCandidate>>,
  rule: string,
  plainText: string | undefined,
): QualityFinding<MiniMessageQualityObject> {
  const object: MiniMessageQualityObject = {
    kind: "lands-message",
    key: message.id,
    language: input.candidate.language,
    origin: "target",
    code: `lands-role-name.${rule}`,
  };
  const location: QualityLocation = {
    language: input.candidate.language,
    range: { file: message.targetFile, path: message.path },
  };
  const actual: JsonValue = {
    value: input.candidate.content ?? { state: "unavailable" },
    renderedPlainText: plainText ?? { state: "unavailable" },
    rule,
  };
  return {
    severity: "error",
    object,
    location,
    message: reasonForRule(rule),
    evidence: [
      {
        role: "expected",
        object,
        location,
        value: { state: "valid role name" },
      },
      { role: "actual", object, location, value: actual },
    ],
  };
}

export const landsRoleNameValidityCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof miniMessageQualityConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "lands-role-name-validity",
  version: "1",
  configurationSchema: miniMessageQualityConfigurationSchema,
  configuration: {},
  fingerprintInput: roleNameBasis,
  check(input) {
    const dependencies = dependenciesOf(input.dependencies);
    const message = messageForCandidate(
      dependencies,
      input.candidate.sourceKey,
    );
    if (message?.scene !== "role-name")
      return outcome("not-applicable", [], []);
    if (!hasMiniMessageInput(input, dependencies))
      return outcome("not-applicable", [], []);
    if (dependencies.sourceVersion !== "9.1.1")
      return outcome("not-applicable", [], []);
    if (input.sourceUnit === null) {
      const issue: MiniMessageIncompleteFact = {
        code: "lands-role-name.source-unavailable",
        reason: "原生 QA 候选没有对应 Lands 角色名原文事实",
      };
      return outcome(
        "incomplete",
        [],
        [issueForQuality(issue, input.candidate)],
      );
    }

    const role = dependencies.projection.roleNames.find(
      ({ message }) => message.id === input.candidate.sourceKey,
    );
    if (role === undefined) {
      const issue: MiniMessageIncompleteFact = {
        code: "lands-role-name.validation-missing",
        reason: "官方 MiniMessage 投影没有返回当前角色名固定校验事实",
      };
      return outcome(
        "incomplete",
        [],
        [issueForQuality(issue, input.candidate)],
      );
    }

    const issues = roleNameIssues(input);
    if (role.validation.status === "unavailable") {
      issues.push({
        code: "lands-role-name.validation-unavailable",
        message: role.message,
        origin: "target",
        location: { file: role.message.targetFile, path: role.message.path },
        reason:
          role.validation.reason ?? "官方 MiniMessage 角色名固定校验未完成",
      });
    }
    const diagnostics =
      role.validation.status === "invalid" && role.validation.rule !== undefined
        ? [
            roleNameFinding(
              input,
              message,
              role.validation.rule,
              role.validation.plainText,
            ),
          ]
        : [];
    return outcome(
      issues.length === 0 ? "complete" : "incomplete",
      diagnostics,
      issues.map((issue) => issueForQuality(issue, input.candidate)),
    );
  },
});
