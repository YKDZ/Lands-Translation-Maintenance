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

function duplicateBasis(input: MiniMessageCheckInput): JsonValue {
  const dependencies = dependenciesOf(input.dependencies);
  return qualityBasis({
    sourceVersion: dependencies.sourceVersion,
    names: dependencies.projection.roleNames.map(
      ({ message, validation, rendering }) => ({
        id: message.id,
        sourceFile: message.sourceFile,
        targetFile: message.targetFile,
        path: message.path,
        source: message.source,
        target: message.target ?? { state: "unavailable" },
        validation,
        rendering,
      }),
    ),
    duplicates: dependencies.projection.roleNameDuplicates.map(
      ({ first, second }) => [first.message.id, second.message.id],
    ),
  });
}

function duplicateIssues(input: MiniMessageCheckInput) {
  const dependencies = dependenciesOf(input.dependencies);
  const issues = dependencies.readIssues.filter(
    (issue) =>
      issue.message === undefined ||
      issue.message.id === input.candidate.sourceKey,
  );
  for (const role of dependencies.projection.roleNames) {
    if (role.validation.status === "unavailable") {
      issues.push({
        code: "lands-role-name.duplicate-validation-unavailable",
        message: role.message,
        origin: "target",
        location: { file: role.message.targetFile, path: role.message.path },
        reason:
          role.validation.reason ?? "无法确定角色名是否会进入重复名称比较",
      });
    } else if (
      role.validation.status === "valid" &&
      role.rendering.status === "unavailable"
    ) {
      issues.push({
        code: "lands-role-name.duplicate-rendering-unavailable",
        message: role.message,
        origin: "target",
        location: { file: role.message.targetFile, path: role.message.path },
        reason:
          role.rendering.reason ?? "官方 MiniMessage 角色名渲染结果不可用",
      });
    }
  }
  return issues;
}

function duplicateFinding(
  input: MiniMessageCheckInput,
  first: NonNullable<ReturnType<typeof messageForCandidate>>,
  second: NonNullable<ReturnType<typeof messageForCandidate>>,
  renderedName: string,
): QualityFinding<MiniMessageQualityObject> {
  const object: MiniMessageQualityObject = {
    kind: "lands-message",
    key: second.id,
    language: input.candidate.language,
    origin: "target",
    code: "lands-role-name.duplicate",
  };
  const location: QualityLocation = {
    language: input.candidate.language,
    range: { file: second.targetFile, path: second.path },
  };
  return {
    severity: "error",
    object,
    location,
    message: `渲染后的角色名与 ${first.path.join(".")} 重复（忽略大小写）`,
    evidence: [
      {
        role: "expected",
        object,
        location,
        value: { state: "unique rendered role name" },
      },
      {
        role: "actual",
        object,
        location,
        value: {
          renderedName,
          duplicateOf: {
            file: first.targetFile,
            path: first.path,
          },
        },
      },
    ],
  };
}

export const landsRoleNameDuplicateCheck = defineQualityCheck<
  LandsUnit,
  LandsTranslation,
  typeof miniMessageQualityConfigurationSchema,
  MiniMessageQualityObject,
  LandsJson,
  UnavailableTranslation
>({
  id: "lands-role-name-duplicate",
  version: "1",
  configurationSchema: miniMessageQualityConfigurationSchema,
  configuration: {},
  fingerprintInput: duplicateBasis,
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
        code: "lands-role-name.rendering-missing",
        reason: "官方 MiniMessage 投影没有返回当前角色名渲染事实",
      };
      return outcome(
        "incomplete",
        [],
        [issueForQuality(issue, input.candidate)],
      );
    }

    const issues = duplicateIssues(input);
    const firstDuplicate = dependencies.projection.roleNameDuplicates.find(
      ({ second }) => second.message.id === input.candidate.sourceKey,
    );
    const firstMessage =
      firstDuplicate === undefined
        ? undefined
        : messageForCandidate(dependencies, firstDuplicate.first.message.id);
    const secondMessage =
      firstDuplicate === undefined
        ? undefined
        : messageForCandidate(dependencies, firstDuplicate.second.message.id);
    const renderedName = firstDuplicate?.second.rendering.plainText;
    const diagnostics =
      firstMessage !== undefined &&
      secondMessage !== undefined &&
      renderedName !== undefined
        ? [duplicateFinding(input, firstMessage, secondMessage, renderedName)]
        : [];
    return outcome(
      issues.length === 0 ? "complete" : "incomplete",
      diagnostics,
      issues.map((issue) => issueForQuality(issue, input.candidate)),
    );
  },
});
