import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { parseConfiguration } from "#/configuration";
import { collectMessages } from "#/messages";
import { translationFieldCategories, translationFieldScenes } from "#/model";
import type {
  ConsumerConfiguration,
  JsonValue,
  ResourceInventoryEntry,
  TranslationMapping,
} from "#/model";
import { readTransactionPhase } from "#/transaction";
import { canonicalJson, sha256 } from "#/value";

export const configurationFileName = ".l10n/config.yml";
export const stateDirectoryName = ".l10n";
export const baselineDirectoryName = "upstream";
export const baselineFileName = "source-baseline.json";
export const lockFileName = "lock.json";
export const transactionFileName = "transaction.json";

export interface ResourceSnapshot extends ResourceInventoryEntry {
  readonly sha256: string;
}

export interface MappingSnapshot {
  readonly mapping: TranslationMapping;
  readonly sourceValue: JsonValue;
  readonly sourceSha256: string;
}

export interface SourceBaseline {
  readonly schemaVersion: 1;
  readonly source: ConsumerConfiguration["source"];
  readonly translationScope: ConsumerConfiguration["translationScope"];
  readonly jarSha256: string;
  readonly resources: readonly ResourceSnapshot[];
  readonly mappings: readonly MappingSnapshot[];
  readonly miniMessageTheme?: {
    readonly file: string;
    readonly source: string;
  };
}

export interface TranslationSeed {
  readonly id: string;
  readonly sourceSha256: string;
  readonly reason: "missing";
}

export interface SameTextCandidate {
  readonly id: string;
  readonly sourceSha256: string;
}

export interface SyncLock {
  readonly schemaVersion: 1;
  readonly sourceVersion: string;
  readonly translationHistory: string;
  readonly jarSha256: string;
  readonly syncConfigurationSha256: string;
  readonly sourceBaselineSha256: string;
  readonly resourcesSha256: string;
  readonly translationSeeds: readonly TranslationSeed[];
  readonly sameTextCandidates: readonly SameTextCandidate[];
  readonly integritySha256: string;
}

export type ReadStateResult =
  | {
      readonly ok: true;
      readonly baseline: SourceBaseline;
      readonly lock: SyncLock;
      readonly baselineText: string;
      readonly lockText: string;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly code?: string;
    };

const mappingSchema = z
  .object({
    source: z.string().min(1),
    target: z.string().min(1),
    definitionsSource: z.string().min(1).optional(),
    fields: z.array(
      z.object({
        path: z.array(z.string()),
        category: z.enum(translationFieldCategories),
        scene: z.enum(translationFieldScenes).optional(),
      }),
    ),
  })
  .strict();
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const resourceSchema = z
  .object({
    path: z.string().min(1),
    purpose: z.enum([
      "chat-language",
      "gui-language",
      "dialog-language",
      "configuration",
      "metadata",
      "documentation",
      "bedrock-excluded",
      "other-excluded",
    ]),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const baselineSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z
      .object({ version: z.string(), translationHistory: z.string() })
      .strict(),
    translationScope: z
      .object({
        sourceLanguage: z.string(),
        targetLanguage: z.string(),
        mappings: z.array(mappingSchema),
      })
      .strict(),
    jarSha256: z.string().regex(/^[0-9a-f]{64}$/),
    resources: z.array(resourceSchema),
    mappings: z.array(
      z
        .object({
          mapping: mappingSchema,
          sourceValue: jsonValueSchema,
          sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict(),
    ),
    miniMessageTheme: z
      .object({ file: z.string().min(1), source: z.string() })
      .strict()
      .optional(),
  })
  .strict();
const lockSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceVersion: z.string(),
    translationHistory: z.string(),
    jarSha256: z.string().regex(/^[0-9a-f]{64}$/),
    syncConfigurationSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sourceBaselineSha256: z.string().regex(/^[0-9a-f]{64}$/),
    resourcesSha256: z.string().regex(/^[0-9a-f]{64}$/),
    translationSeeds: z.array(
      z
        .object({
          id: z.string().regex(/^[0-9a-f]{64}$/),
          sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
          reason: z.literal("missing"),
        })
        .strict(),
    ),
    sameTextCandidates: z.array(
      z
        .object({
          id: z.string().regex(/^[0-9a-f]{64}$/),
          sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict(),
    ),
    integritySha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export function serializeBaseline(baseline: SourceBaseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export function serializeLock(lock: SyncLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export function resourceSetFingerprint(
  resources: readonly ResourceSnapshot[],
): string {
  return sha256(canonicalJson(resources));
}

export function syncLockIntegrity(
  lock: Omit<SyncLock, "integritySha256">,
): string {
  return sha256(canonicalJson(lock));
}

async function readUtf8(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function readState(
  projectDirectory: string,
): Promise<ReadStateResult> {
  let transactionPhase: "prepared" | "committed" | undefined;
  try {
    transactionPhase = await readTransactionPhase(
      projectDirectory,
      `${stateDirectoryName}/${transactionFileName}`,
    );
  } catch (error) {
    return {
      ok: false,
      code: "transaction.invalid",
      message: error instanceof Error ? error.message : "无法读取维护事务记录",
    };
  }
  if (transactionPhase === "prepared") {
    return {
      ok: false,
      code: "transaction.prepared",
      message:
        "发现尚未提交的维护事务；status/check 不会恢复，请重新执行 init 或 sync",
    };
  }

  const baselinePath = join(
    projectDirectory,
    stateDirectoryName,
    baselineDirectoryName,
    baselineFileName,
  );
  const lockPath = join(projectDirectory, stateDirectoryName, lockFileName);
  let baselineText: string;
  let lockText: string;
  try {
    [baselineText, lockText] = await Promise.all([
      readUtf8(baselinePath),
      readUtf8(lockPath),
    ]);
  } catch {
    return {
      ok: false,
      message: "项目尚未初始化，或原文基线与同步锁文件不完整",
    };
  }

  let baselineJson: unknown;
  let lockJson: unknown;
  try {
    baselineJson = JSON.parse(baselineText) as unknown;
    lockJson = JSON.parse(lockText) as unknown;
  } catch {
    return { ok: false, message: "原文基线或同步锁文件不是有效 JSON" };
  }
  const parsedBaseline = baselineSchema.safeParse(baselineJson);
  const parsedLock = lockSchema.safeParse(lockJson);
  if (!parsedBaseline.success || !parsedLock.success) {
    return { ok: false, message: "原文基线或同步锁文件不符合格式" };
  }

  const baseline = parsedBaseline.data as SourceBaseline;
  const lock = parsedLock.data as SyncLock;
  const { integritySha256, ...lockContents } = lock;
  if (syncLockIntegrity(lockContents) !== integritySha256) {
    return { ok: false, message: "同步锁文件校验失败，内部记录不一致" };
  }
  if (sha256(baselineText) !== lock.sourceBaselineSha256) {
    return { ok: false, message: "原文基线摘要与同步锁文件不一致" };
  }
  if (resourceSetFingerprint(baseline.resources) !== lock.resourcesSha256) {
    return { ok: false, message: "资源基线摘要与同步锁文件不一致" };
  }
  if (
    baseline.jarSha256 !== lock.jarSha256 ||
    baseline.source.version !== lock.sourceVersion ||
    baseline.source.translationHistory !== lock.translationHistory
  ) {
    return { ok: false, message: "原文基线与同步锁文件记录不一致" };
  }
  if (
    canonicalJson(baseline.translationScope) !==
    canonicalJson({
      sourceLanguage: baseline.translationScope.sourceLanguage,
      targetLanguage: baseline.translationScope.targetLanguage,
      mappings: baseline.mappings.map((entry) => entry.mapping),
    })
  ) {
    return { ok: false, message: "原文基线中的映射声明与已保存消息数据不一致" };
  }

  const baselineMessages = collectMessages(
    baseline.mappings,
    new Map(),
    baseline.resources,
  ).messages;
  const messageHashes = new Map(
    baselineMessages.map((message) => [
      message.id,
      sha256(canonicalJson(message.source)),
    ]),
  );
  const references = [...lock.translationSeeds, ...lock.sameTextCandidates];
  if (
    references.some(
      (reference) => messageHashes.get(reference.id) !== reference.sourceSha256,
    ) ||
    new Set(references.map((reference) => reference.id)).size !==
      references.length
  ) {
    return {
      ok: false,
      message: "同步锁文件中的译文状态无法对应原文基线",
    };
  }

  for (const entry of baseline.mappings) {
    if (sha256(canonicalJson(entry.sourceValue)) !== entry.sourceSha256) {
      return {
        ok: false,
        message: `原文基线摘要不一致：${entry.mapping.source}`,
      };
    }
  }

  return { ok: true, baseline, lock, baselineText, lockText };
}

export async function loadConfiguration(projectDirectory: string) {
  let source: string;
  try {
    source = await readUtf8(join(projectDirectory, configurationFileName));
  } catch {
    return { ok: false as const, message: `缺少 ${configurationFileName}` };
  }
  const parsed = parseConfiguration(source);
  if (!parsed.ok) {
    return {
      ok: false as const,
      message: parsed.issues
        .map((issue) => `${issue.code}：${issue.reason}（${issue.actual}）`)
        .join("；"),
    };
  }
  return { ok: true as const, configuration: parsed.value, source };
}
