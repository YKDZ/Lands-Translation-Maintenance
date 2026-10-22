import { stringify } from "yaml";
import { z } from "zod";

import type { ExceptionRecord } from "#/model";
import { parseYaml } from "#/yaml-data";

export interface ExceptionRecords {
  readonly schemaVersion: 3;
  readonly records: readonly ExceptionRecord[];
}

const messageIdentitySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  sourceFile: z.string().min(1),
  targetFile: z.string().min(1),
  path: z.array(z.string()),
  category: z.string().min(1),
  scene: z.string().optional(),
  format: z.string().optional(),
});
const locationSchema = z.object({
  file: z.string().min(1),
  path: z.array(z.union([z.string(), z.number()])),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
});
const requiredInputDependencySchema = z
  .object({
    input: z.literal("minimessage-parse"),
    messageId: z.string().regex(/^[0-9a-f]{64}$/),
    origin: z.enum(["source", "target", "theme"]),
    documentIndex: z.number().int().nonnegative(),
    path: z.array(z.union([z.string(), z.number()])),
  })
  .strict();
const subjectShape = {
  id: z.string().regex(/^[0-9a-f]{64}$/),
  objectId: z.string().regex(/^[0-9a-f]{64}$/),
  contentFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  location: locationSchema,
};
const conclusionSubjectSchema = z.object({
  ...subjectShape,
  ruleId: z.string().min(1),
  code: z.string().min(1),
  message: messageIdentitySchema.optional(),
  origin: z.enum(["source", "target", "theme"]).optional(),
  requiredInputDependencies: z.array(requiredInputDependencySchema).optional(),
});
export const checkConclusionSchema = conclusionSubjectSchema
  .extend({
    description: z.string(),
    expected: z.json(),
    actual: z.json(),
  })
  .strict();
const exceptionRecordsSchema = z
  .object({
    schemaVersion: z.literal(3),
    records: z.array(
      conclusionSubjectSchema
        .extend({ reason: z.string().trim().min(1) })
        .strict(),
    ),
  })
  .strict();

export function emptyExceptionRecords(): ExceptionRecords {
  return { schemaVersion: 3, records: [] };
}

export function parseExceptionRecords(source: string): ExceptionRecords {
  const parsed = parseYaml(source, ".l10n/exceptions.yml");
  if (!parsed.ok) {
    throw new Error(
      parsed.issues.map((issue) => issue.reason).join("；") ||
        "例外文件无法解析",
    );
  }
  const result = exceptionRecordsSchema.safeParse(parsed.parsed.value);
  if (!result.success) {
    throw new Error("例外文件不符合格式");
  }
  const records = result.data as ExceptionRecords;
  if (
    new Set(records.records.map((record) => record.objectId)).size !==
      records.records.length ||
    new Set(records.records.map((record) => record.id)).size !==
      records.records.length
  ) {
    throw new Error("例外文件包含重复的例外对象或 ID");
  }
  return records;
}

export function serializeExceptionRecords(records: ExceptionRecords): string {
  const independentRecords = JSON.parse(
    JSON.stringify(records),
  ) as ExceptionRecords;
  return stringify(independentRecords, { lineWidth: 0 });
}
