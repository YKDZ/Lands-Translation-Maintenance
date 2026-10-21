import type {
  CheckRule,
  JsonValue,
  ProjectView,
  RuleFinding,
  VariableOccurrence,
} from "#/model";
import { compareVariableOccurrences } from "#/variable-comparison";

const legacyTitleVariables = new Set(["owner", "player", "nation", "level"]);

function mapFindings(project: ProjectView): readonly RuleFinding[] {
  return (project.miniMessage?.mapFindings ?? []).filter(
    (finding) =>
      finding.origin === "target" &&
      finding.code !== "map-html.source-variable-not-supplied",
  );
}

export const mapHtmlRule: CheckRule = {
  id: "map-html",
  defaultSeverity: "error",
  requiredInputs: ["minimessage-parse"],
  evaluate(project) {
    return mapFindings(project);
  },
};

export const mapHtmlSourceLimitRule: CheckRule = {
  id: "map-html-source-limits",
  defaultSeverity: "warning",
  requiredInputs: ["minimessage-parse"],
  evaluate(project) {
    return (project.miniMessage?.mapFindings ?? []).filter(
      (finding) =>
        finding.origin === "source" ||
        finding.code === "map-html.source-variable-not-supplied",
    );
  },
};

function fieldContext(message: ProjectView["messages"][number]): JsonValue {
  return {
    surface: "chat",
    path: [...message.path],
  };
}

function occurrencesForSide(
  project: ProjectView,
  message: ProjectView["messages"][number],
  origin: "source" | "target",
): readonly VariableOccurrence[] {
  const documents = project.miniMessage?.translatableText.filter(
    (document) =>
      document.message.id === message.id &&
      document.origin === origin &&
      document.documentIndex === 0 &&
      document.context.every((frame) => frame.kind !== "hover-text"),
  );
  const field = fieldContext(message);
  return (documents ?? []).flatMap((document) =>
    document.segments
      .filter(
        (segment) =>
          segment.kind === "variable" &&
          legacyTitleVariables.has(segment.value),
      )
      .map((segment) => ({
        name: segment.value,
        context: [
          { kind: "field", identity: field },
          { kind: "body", identity: {} },
        ],
        position: segment.position,
      })),
  );
}

function variableFinding(
  message: ProjectView["messages"][number],
  code: string,
  name: string,
  expected: JsonValue,
  actual: JsonValue,
  sourceVersion: string,
): RuleFinding {
  const context = [{ kind: "field", identity: fieldContext(message) }];
  return {
    code,
    identity: { name, context },
    fingerprint: {
      sourceVersion,
      supportedVariables: ["owner", "player", "nation", "level"],
      runtime: "MiniMessage plain text followed by exact replacement",
    },
    message,
    origin: "target",
    location: { file: message.targetFile, path: message.path },
    reason:
      code === "legacy-variable.missing"
        ? `旧变量 ${name} 在译文中遗漏或次数不足`
        : `译文新增旧变量 ${name} 或出现次数过多`,
    expected,
    actual,
  };
}

function positionValues(
  positions: readonly NonNullable<VariableOccurrence["position"]>[],
): JsonValue {
  return positions.map(({ start, end }) => ({ start, end }));
}

export const legacyVariableRule: CheckRule = {
  id: "legacy-variable",
  defaultSeverity: "error",
  requiredInputs: ["minimessage-parse"],
  evaluate(project) {
    const parsed = project.miniMessage;
    if (parsed === undefined) return [];
    const findings: RuleFinding[] = [];
    for (const message of project.messages) {
      if (message.format !== "legacy-variable-minimessage") continue;
      const expected = occurrencesForSide(project, message, "source");
      const actual = occurrencesForSide(project, message, "target");
      for (const difference of compareVariableOccurrences(expected, actual)) {
        const base = {
          name: difference.name,
          expectedCount: difference.expectedCount,
          actualCount: difference.actualCount,
          context: difference.context as unknown as JsonValue,
        };
        if (difference.expectedCount > difference.actualCount) {
          findings.push(
            variableFinding(
              message,
              "legacy-variable.missing",
              difference.name,
              {
                ...base,
                remainingCount:
                  difference.expectedCount - difference.actualCount,
                positions: positionValues(difference.expectedPositions),
              },
              {
                ...base,
                positions: positionValues(difference.actualPositions),
              },
              parsed.sourceVersion,
            ),
          );
        }
        if (difference.actualCount > difference.expectedCount) {
          findings.push(
            variableFinding(
              message,
              "legacy-variable.added",
              difference.name,
              {
                ...base,
                positions: positionValues(difference.expectedPositions),
              },
              {
                ...base,
                addedCount: difference.actualCount - difference.expectedCount,
                positions: positionValues(difference.actualPositions),
              },
              parsed.sourceVersion,
            ),
          );
        }
      }
    }
    return findings;
  },
};
