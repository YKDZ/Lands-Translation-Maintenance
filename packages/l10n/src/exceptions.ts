import { stringify } from "yaml";
import { z } from "zod";

import type {
  ExceptionRecord,
  JsonValue,
  MessageIdentity,
  SameTextPendingReason,
} from "#/model";
import { canonicalJson, sha256 } from "#/value";
import { parseYaml } from "#/yaml-data";

export interface ExceptionRecords {
  readonly schemaVersion: 2;
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
const diagnosticExceptionSchema = z.object({
  ...subjectShape,
  kind: z.literal("diagnostic"),
  ruleId: z.string().min(1),
  code: z.string().min(1),
  message: messageIdentitySchema.optional(),
  origin: z.enum(["source", "target", "theme"]).optional(),
  requiredInputDependencies: z.array(requiredInputDependencySchema).optional(),
});
const sameTextExceptionSchema = z.object({
  ...subjectShape,
  kind: z.literal("same-text"),
  pendingReason: z.enum(["translation-seed", "same-text-candidate"]),
  message: messageIdentitySchema,
});
export const exceptionCandidateSchema = z.discriminatedUnion("kind", [
  diagnosticExceptionSchema.extend({ description: z.string() }).strict(),
  sameTextExceptionSchema
    .extend({
      description: z.string(),
      source: z.json(),
      target: z.json(),
    })
    .strict(),
]);
const recordShape = { reason: z.string().trim().min(1) };
const exceptionRecordsSchema = z
  .object({
    schemaVersion: z.literal(2),
    records: z.array(
      z.discriminatedUnion("kind", [
        diagnosticExceptionSchema.extend(recordShape).strict(),
        sameTextExceptionSchema.extend(recordShape).strict(),
      ]),
    ),
  })
  .strict();

export function emptyExceptionRecords(): ExceptionRecords {
  return { schemaVersion: 2, records: [] };
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

export function sameTextContentFingerprint(
  message: MessageIdentity,
  source: JsonValue,
  target: JsonValue,
): string {
  return sha256(
    canonicalJson({
      message,
      source,
      target,
    }),
  );
}

export function sameTextCandidateId(
  message: MessageIdentity,
  source: JsonValue,
  target: JsonValue,
  pendingReason: SameTextPendingReason,
): string {
  return sha256(
    canonicalJson({
      kind: "same-text-candidate",
      messageId: message.id,
      pendingReason,
      contentFingerprint: sameTextContentFingerprint(message, source, target),
    }),
  );
}

export function sameTextObjectId(message: MessageIdentity): string {
  return sha256(canonicalJson({ kind: "same-text", messageId: message.id }));
}
