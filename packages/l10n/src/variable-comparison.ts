import type {
  VariableCountDifference,
  VariableOccurrence,
} from "#/mini-message-model";
import { canonicalJson } from "#/value";

interface VariableCount {
  readonly name: string;
  readonly context: VariableOccurrence["context"];
  readonly count: number;
  readonly positions: readonly NonNullable<VariableOccurrence["position"]>[];
}

function countVariables(
  occurrences: readonly VariableOccurrence[],
): ReadonlyMap<string, VariableCount> {
  const counts = new Map<string, VariableCount>();
  for (const occurrence of occurrences) {
    const key = canonicalJson({
      context: occurrence.context,
      name: occurrence.name,
    });
    const existing = counts.get(key);
    counts.set(key, {
      name: occurrence.name,
      context: occurrence.context,
      count: (existing?.count ?? 0) + 1,
      positions: [
        ...(existing?.positions ?? []),
        ...(occurrence.position === undefined ? [] : [occurrence.position]),
      ],
    });
  }
  return counts;
}

export function compareVariableOccurrences(
  expected: readonly VariableOccurrence[],
  actual: readonly VariableOccurrence[],
): readonly VariableCountDifference[] {
  const expectedCounts = countVariables(expected);
  const actualCounts = countVariables(actual);
  const keys = [
    ...new Set([...expectedCounts.keys(), ...actualCounts.keys()]),
  ].sort();
  const differences: VariableCountDifference[] = [];

  for (const key of keys) {
    const expectedVariable = expectedCounts.get(key);
    const actualVariable = actualCounts.get(key);
    const expectedCount = expectedVariable?.count ?? 0;
    const actualCount = actualVariable?.count ?? 0;
    if (expectedCount === actualCount) continue;
    const variable = expectedVariable ?? actualVariable;
    if (variable === undefined) continue;
    differences.push({
      name: variable.name,
      context: variable.context,
      expectedCount,
      actualCount,
      expectedPositions: expectedVariable?.positions ?? [],
      actualPositions: actualVariable?.positions ?? [],
    });
  }
  return differences;
}
