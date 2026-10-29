import { isMap, LineCounter, parseDocument, type Document } from "yaml";

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

export function valueAtPath(
  value: JsonValue | undefined,
  path: readonly string[],
): JsonValue | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current as JsonValue | undefined;
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
