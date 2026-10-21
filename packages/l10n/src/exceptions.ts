import { stringify } from "yaml";
import { z } from "zod";

import type {
  DiagnosticLocation,
  JsonValue,
  MessageIdentity,
  MiniMessageOrigin,
  RuleInputDependency,
} from "#/model";
import { canonicalJson, sha256 } from "#/value";
import { parseYaml } from "#/yaml-data";

export interface DiagnosticExemptionRecord {
  readonly diagnosticId: string;
  readonly objectId: string;
  readonly contentFingerprint: string;
  readonly ruleId: string;
  readonly code: string;
  readonly message?: MessageIdentity;
  readonly origin?: MiniMessageOrigin;
  readonly requiredInputDependencies?: readonly RuleInputDependency[];
  readonly location: DiagnosticLocation;
  readonly reason: string;
}

export interface SameTextConfirmationRecord {
  readonly candidateId: string;
  readonly pendingReason: "translation-seed" | "same-text-candidate";
  readonly message: MessageIdentity;
  readonly contentFingerprint: string;
  readonly reason: string;
}

export type SameTextPendingReason = "translation-seed" | "same-text-candidate";

export interface ExceptionRecords {
  readonly schemaVersion: 1;
  readonly diagnosticExemptions: readonly DiagnosticExemptionRecord[];
  readonly sameTextConfirmations: readonly SameTextConfirmationRecord[];
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
const diagnosticExemptionSchema = z
  .object({
    diagnosticId: z.string().regex(/^[0-9a-f]{64}$/),
    objectId: z.string().regex(/^[0-9a-f]{64}$/),
    contentFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    ruleId: z.string().min(1),
    code: z.string().min(1),
    message: messageIdentitySchema.optional(),
    origin: z.enum(["source", "target", "theme"]).optional(),
    requiredInputDependencies: z
      .array(requiredInputDependencySchema)
      .optional(),
    location: locationSchema,
    reason: z.string().trim().min(1),
  })
  .strict();
const sameTextConfirmationSchema = z
  .object({
    candidateId: z.string().regex(/^[0-9a-f]{64}$/),
    pendingReason: z.enum(["translation-seed", "same-text-candidate"]),
    message: messageIdentitySchema,
    contentFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    reason: z.string().trim().min(1),
  })
  .strict();
const exceptionRecordsSchema = z
  .object({
    schemaVersion: z.literal(1),
    diagnosticExemptions: z.array(diagnosticExemptionSchema),
    sameTextConfirmations: z.array(sameTextConfirmationSchema),
  })
  .strict();

export function emptyExceptionRecords(): ExceptionRecords {
  return {
    schemaVersion: 1,
    diagnosticExemptions: [],
    sameTextConfirmations: [],
  };
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
    new Set(records.diagnosticExemptions.map((record) => record.objectId))
      .size !== records.diagnosticExemptions.length ||
    new Set(records.sameTextConfirmations.map((record) => record.message.id))
      .size !== records.sameTextConfirmations.length
  ) {
    throw new Error("例外文件包含重复的诊断对象或消息记录");
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
