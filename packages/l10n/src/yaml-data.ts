import {
  isMap,
  isScalar,
  LineCounter,
  Pair,
  parseDocument,
  Scalar,
  YAMLMap,
  type Document,
} from "yaml";

import type { JsonValue } from "#/json-value";
import { toJsonValue } from "#/value";

export interface YamlIssue {
  readonly file: string;
  readonly code: string;
  readonly reason: string;
  readonly path: readonly (string | number)[];
  readonly line?: number;
  readonly column?: number;
}

export interface ParsedYaml {
  readonly document: Document;
  readonly value: JsonValue;
}

export type ParsedYamlResult =
  | { readonly ok: true; readonly parsed: ParsedYaml }
  | { readonly ok: false; readonly issues: readonly YamlIssue[] };

export type YamlMappingAtPath =
  | { readonly status: "found"; readonly mapping: YAMLMap }
  | { readonly status: "missing" }
  | { readonly status: "unavailable" };

export type YamlMappingKeys =
  | { readonly status: "found"; readonly keys: readonly string[] }
  | { readonly status: "missing" }
  | { readonly status: "unavailable" };

function pairKey(pair: Pair): string | undefined {
  if (typeof pair.key === "string") return pair.key;
  if (!isScalar(pair.key)) return undefined;
  return String(pair.key.value);
}

/** 保留 YAML 节点读取映射路径，避免经 JS 对象丢失原始键序。 */
export function findYamlMappingAtPath(
  document: Document,
  path: readonly string[],
): YamlMappingAtPath {
  let current: unknown = document.contents;
  for (const segment of path) {
    if (!isMap(current)) return { status: "unavailable" };
    const pair = current.items.find((item) => pairKey(item) === segment);
    if (pair === undefined) return { status: "missing" };
    current = pair.value;
  }
  return isMap(current)
    ? { status: "found", mapping: current }
    : { status: "unavailable" };
}

/** 读取映射键序；给定受管键集时会忽略自定义键。 */
export function readYamlMappingKeys(
  document: Document,
  path: readonly string[],
  managedKeys?: ReadonlySet<string>,
): YamlMappingKeys {
  const found = findYamlMappingAtPath(document, path);
  if (found.status !== "found") return found;

  const keys: string[] = [];
  for (const pair of found.mapping.items) {
    const key = pairKey(pair);
    if (key === undefined) {
      if (managedKeys !== undefined) continue;
      return { status: "unavailable" };
    }
    if (managedKeys === undefined || managedKeys.has(key)) keys.push(key);
  }
  return { status: "found", keys };
}

/** 只移动受管键对应的 Pair，自定义 Pair 与节点注释保持原位。 */
export function reorderYamlMapping(
  document: Document,
  path: readonly string[],
  orderedKeys: readonly string[],
): void {
  const managedKeys = new Set(orderedKeys);
  if (managedKeys.size !== orderedKeys.length) {
    throw new Error(`YAML 映射顺序包含重复键：${path.join(".")}`);
  }

  let found = findYamlMappingAtPath(document, path);
  if (found.status === "missing") {
    setDocumentPath(document, path, {});
    found = findYamlMappingAtPath(document, path);
  }
  if (found.status !== "found") {
    throw new Error(`YAML 映射路径不可写：${path.join(".")}`);
  }

  const pairsByKey = new Map<string, Pair>();
  for (const pair of found.mapping.items) {
    const key = pairKey(pair);
    if (key !== undefined && managedKeys.has(key)) pairsByKey.set(key, pair);
  }
  const orderedPairs = orderedKeys.map(
    (key) => pairsByKey.get(key) ?? new Pair(new Scalar(key), new YAMLMap()),
  );
  let nextManagedPair = 0;
  const reordered = found.mapping.items.map((pair) => {
    const key = pairKey(pair);
    if (key === undefined || !managedKeys.has(key)) return pair;
    return orderedPairs[nextManagedPair++]!;
  });
  reordered.push(...orderedPairs.slice(nextManagedPair));
  found.mapping.items = reordered;
}

export function parseYaml(source: string, file: string): ParsedYamlResult {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    uniqueKeys: true,
    prettyErrors: false,
    lineCounter,
    stringKeys: true,
  });
  if (document.errors.length > 0) {
    return {
      ok: false,
      issues: document.errors.map((error) => {
        const location = lineCounter.linePos(error.pos[0]);
        return {
          file,
          code:
            error.code === "DUPLICATE_KEY"
              ? "yaml-duplicate-key"
              : "yaml-invalid",
          reason: error.message,
          path: [],
          ...(location === null
            ? {}
            : { line: location.line, column: location.col }),
        };
      }),
    };
  }

  try {
    return {
      ok: true,
      parsed: {
        document,
        value: toJsonValue(
          document.toJS({ mapAsMap: false, maxAliasCount: 0 }),
        ),
      },
    };
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          file,
          code: "yaml-invalid",
          reason: error instanceof Error ? error.message : String(error),
          path: [],
        },
      ],
    };
  }
}

export function setDocumentPath(
  document: Document,
  path: readonly string[],
  value: JsonValue,
): void {
  document.setIn(path, value);
}

export function isYamlDocumentRootMap(document: Document): boolean {
  return isMap(document.contents);
}
