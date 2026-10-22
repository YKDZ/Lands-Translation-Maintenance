import {
  defineCli,
  helpCapability,
  outputCapability,
  text,
} from "@ykdz/cli-contract";
import { z } from "zod";

import { checkConclusionSchema } from "#/exceptions";
import {
  translationFieldCategories,
  translationFieldScenes,
  translationFormats,
} from "#/model";
import type { ProjectReport, SyncPlan, SyncPreviewResult } from "#/model";
import {
  applySyncProject,
  initializeProject,
  inspectProject,
  operationExitCode,
  previewSyncProject,
  recordException,
} from "#/operations";

export interface CliDependencies {
  readonly manifest: unknown;
}

const jsonValueSchema = z.json();
const messageIdentitySchema = z.object({
  id: z.string(),
  sourceFile: z.string(),
  targetFile: z.string(),
  path: z.array(z.string()),
  category: z.enum(translationFieldCategories),
  scene: z.enum(translationFieldScenes).optional(),
  format: z.enum(translationFormats).optional(),
});
const diagnosticSchema = z.object({
  diagnosticId: z.string(),
  objectId: z.string(),
  contentFingerprint: z.string(),
  ruleId: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: messageIdentitySchema.optional(),
  origin: z.enum(["source", "target", "theme"]).optional(),
  location: z.object({
    file: z.string(),
    path: z.array(z.union([z.string(), z.number()])),
    line: z.number().optional(),
    column: z.number().optional(),
  }),
  reason: z.string(),
  expected: jsonValueSchema,
  actual: jsonValueSchema,
});
const reportSchema = z.object({
  operation: z.enum(["init", "status", "check"]),
  state: z.enum(["ready", "issues", "incomplete"]),
  summary: z.object({
    resourceFiles: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    pendingTranslations: z.number().int().nonnegative(),
    sameTextCandidates: z.number().int().nonnegative(),
    confirmedSameText: z.number().int().nonnegative(),
    modifiedTranslations: z.number().int().nonnegative(),
    missingTranslations: z.number().int().nonnegative(),
  }),
  diagnostics: z.array(diagnosticSchema),
  exceptionCandidates: z.array(checkConclusionSchema),
  knownExcludedResources: z.array(
    z.object({
      path: z.string(),
      purpose: z.enum(["bedrock-excluded", "other-excluded"]),
    }),
  ),
  knownOutOfScopeVisibleTexts: z.array(
    z.object({
      file: z.string(),
      path: z.array(z.string()),
      value: z.string(),
    }),
  ),
  coverage: z
    .object({
      complete: z.boolean(),
      enabledRuleIds: z.array(z.string()),
      disabledRuleIds: z.array(z.string()),
      unsupportedRuleIds: z.array(z.string()),
      unavailableCapabilities: z.array(z.string()),
    })
    .optional(),
});

const resourceChangesSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
  unchanged: z.array(z.string()),
  observedOnly: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    changed: z.array(z.string()),
  }),
});
const syncPlanSchema = z.object({
  sourceVersion: z.string(),
  jarSha256: z.string().regex(/^[0-9a-f]{64}$/),
  resourceChanges: resourceChangesSchema,
  messages: z.array(
    z.object({
      id: z.string(),
      action: z.enum(["preserve", "seed", "reset", "delete"]),
      reason: z.enum([
        "unchanged",
        "target-path-blocked",
        "missing-translation",
        "new-message",
        "source-changed",
        "source-removed",
        "orphaned-translation",
      ]),
      sourceFile: z.string(),
      targetFile: z.string(),
      path: z.array(z.string()),
      category: z.enum(translationFieldCategories),
      scene: z.enum(translationFieldScenes).optional(),
      format: z.enum(translationFormats).optional(),
      previousSource: jsonValueSchema.optional(),
      source: jsonValueSchema.optional(),
      previousTarget: jsonValueSchema.optional(),
      target: jsonValueSchema.optional(),
    }),
  ),
  structures: z.array(
    z.object({
      sourceFile: z.string(),
      definitionsSource: z.string(),
      targetFile: z.string(),
      path: z.array(z.string()),
      action: z.enum(["preserve", "update", "delete"]),
      previous: jsonValueSchema.optional(),
      expected: jsonValueSchema.optional(),
    }),
  ),
  targetFiles: z.array(
    z.object({
      path: z.string(),
      action: z.enum(["write", "unchanged"]),
      expectedSha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
      contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
  unmanagedTargets: z.array(z.string()),
  pendingTranslations: z.array(z.string()),
  inputSnapshots: z.array(
    z.object({
      path: z.string(),
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    }),
  ),
  writes: z.array(
    z.object({
      kind: z.enum(["target", "baseline", "lock"]),
      path: z.string(),
      content: z.string(),
      expectedSha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    }),
  ),
});
const syncPreviewSchema = z.union([
  z.object({
    ready: z.literal(true),
    plan: syncPlanSchema,
  }),
  z.object({
    ready: z.literal(false),
    blockers: z.array(z.object({ code: z.string(), reason: z.string() })),
    resourceDifference: z.object({
      undeclared: z.array(z.string()),
      missing: z.array(z.string()),
      duplicates: z.array(z.string()),
    }),
    resourceChanges: resourceChangesSchema,
  }),
]);
const exceptionReceiptSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  contentFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string(),
});

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

function textLineValue(value: string): string {
  return value
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("\0", "\\0");
}

type ReportPayload = z.output<typeof reportSchema>;

function reportPayload(report: ProjectReport): ReportPayload {
  return structuredClone(report) as ReportPayload;
}

type SyncPlanPayload = z.output<typeof syncPlanSchema>;

function syncPlanPayload(plan: SyncPlan): SyncPlanPayload {
  return structuredClone(plan) as SyncPlanPayload;
}

type SyncPreviewPayload = z.output<typeof syncPreviewSchema>;

function syncPreviewPayload(preview: SyncPreviewResult): SyncPreviewPayload {
  return structuredClone(preview) as SyncPreviewPayload;
}

function renderReport(report: ReportPayload) {
  const stateNames = {
    ready: "正常",
    issues: "发现问题",
    incomplete: "覆盖不完整",
  } as const;
  const lines = [
    `${report.operation}：${stateNames[report.state]}`,
    `资源文件 ${report.summary.resourceFiles} 项；消息 ${report.summary.messages} 条；待翻译 ${report.summary.pendingTranslations} 条；历史同文候选 ${report.summary.sameTextCandidates} 条；已确认同文 ${report.summary.confirmedSameText} 条；已修改 ${report.summary.modifiedTranslations} 条；缺失 ${report.summary.missingTranslations} 条。`,
  ];
  for (const candidate of report.exceptionCandidates) {
    lines.push(
      `例外候选 ${candidate.id}：${textLineValue(candidate.location.file)}:${candidate.location.path.map((part) => textLineValue(String(part))).join(".")}；${textLineValue(candidate.description)}；期望 ${jsonLine(candidate.expected)}，实际 ${jsonLine(candidate.actual)}。`,
    );
  }
  if (report.knownExcludedResources.length > 0) {
    lines.push("已知排除资源（已登记，本次不解析）：");
    for (const resource of report.knownExcludedResources) {
      const name =
        resource.purpose === "bedrock-excluded" ? "Bedrock" : "其他范围外资源";
      lines.push(`  ${name}：${textLineValue(resource.path)}`);
    }
  }
  if (report.knownOutOfScopeVisibleTexts.length > 0) {
    lines.push("已知范围外可见文本（仅登记，不纳入翻译维护）：");
    for (const visibleText of report.knownOutOfScopeVisibleTexts) {
      lines.push(
        `  ${textLineValue(visibleText.file)}:${visibleText.path.map((part) => textLineValue(String(part))).join(".")} = ${JSON.stringify(visibleText.value)}`,
      );
    }
  }
  if (report.coverage !== undefined) {
    lines.push(
      report.coverage.complete
        ? "检查覆盖完整。"
        : "检查覆盖不完整，不能据此判定完整翻译质量通过。",
    );
    if (report.coverage.disabledRuleIds.length > 0) {
      lines.push(`已禁用规则：${report.coverage.disabledRuleIds.join("、")}`);
    }
    if (report.coverage.unsupportedRuleIds.length > 0) {
      lines.push(
        `不支持或执行失败的规则：${report.coverage.unsupportedRuleIds.join("、")}`,
      );
    }
    for (const capability of report.coverage.unavailableCapabilities) {
      lines.push(`尚未覆盖：${textLineValue(capability)}`);
    }
  }
  if (report.diagnostics.length === 0) {
    lines.push("没有诊断。");
  } else {
    for (const diagnostic of report.diagnostics) {
      const location = `${textLineValue(diagnostic.location.file)}${diagnostic.location.path.length === 0 ? "" : `:${diagnostic.location.path.map((part) => textLineValue(String(part))).join(".")}`}`;
      const origins = {
        source: "原文",
        target: "译文",
        theme: "主题",
      } as const;
      const origin =
        diagnostic.origin === undefined
          ? ""
          : `（来源：${origins[diagnostic.origin]}）`;
      lines.push(
        `[${diagnostic.severity}] ${location}${origin} ${diagnostic.code}：${textLineValue(diagnostic.reason)}；期望 ${jsonLine(diagnostic.expected)}，实际 ${jsonLine(diagnostic.actual)}。（诊断 ID：${diagnostic.diagnosticId}）`,
      );
    }
  }
  return text.lines(lines as [string, ...string[]]);
}

function renderSyncPreview(preview: SyncPreviewPayload) {
  if (!preview.ready) {
    const lines = ["sync：预演已阻断"];
    const { resourceDifference, blockers } = preview;
    if (resourceDifference.undeclared.length > 0) {
      lines.push(
        `尚未登记的新资源：${resourceDifference.undeclared.join("、")}`,
      );
    }
    if (resourceDifference.missing.length > 0) {
      lines.push(
        `声明中不存在的资源：${resourceDifference.missing.join("、")}`,
      );
    }
    if (resourceDifference.duplicates.length > 0) {
      lines.push(
        `JAR 中有重复路径：${resourceDifference.duplicates.join("、")}`,
      );
    }
    for (const blocker of blockers) lines.push(blocker.reason);
    return text.lines(lines as [string, ...string[]]);
  }

  const { plan } = preview;
  const actionLabels = {
    preserve: "保留译文",
    seed: "填入英文",
    reset: "重置为英文",
    delete: "删除译文",
  } as const;
  const reasonLabels = {
    unchanged: "原文未变",
    "target-path-blocked": "目标路径被现有内容阻断",
    "missing-translation": "译文缺失",
    "new-message": "新增消息",
    "source-changed": "原文变化",
    "source-removed": "原文已删除",
    "orphaned-translation": "目标字段不再受维护",
  } as const;
  const pendingIds = new Set(plan.pendingTranslations);
  const counts = {
    preserve: plan.messages.filter((message) => message.action === "preserve")
      .length,
    reset: plan.messages.filter((message) => message.action === "reset").length,
    seed: plan.messages.filter((message) => message.action === "seed").length,
    delete: plan.messages.filter((message) => message.action === "delete")
      .length,
  };
  const lines = [
    `sync：预演就绪（来源 ${plan.sourceVersion}）`,
    `资源新增 ${plan.resourceChanges.added.length} 项；删除 ${plan.resourceChanges.removed.length} 项；内容变化 ${plan.resourceChanges.changed.length} 项；观察范围内变化 ${plan.resourceChanges.observedOnly.changed.length} 项。`,
    `消息保留 ${counts.preserve} 条；重置 ${counts.reset} 条；填入英文 ${counts.seed} 条；删除 ${counts.delete} 条；待翻译总数 ${plan.pendingTranslations.length} 条。`,
  ];
  for (const message of plan.messages) {
    const pendingLabel = pendingIds.has(message.id) ? "；待翻译" : "";
    lines.push(
      `${actionLabels[message.action]}（${reasonLabels[message.reason]}${pendingLabel}）：${message.sourceFile}:${message.path.join(".")} → ${message.targetFile}:${message.path.join(".")}`,
    );
  }
  if (plan.unmanagedTargets.length > 0) {
    lines.push(`解除维护并保留目标文件：${plan.unmanagedTargets.join("、")}`);
  }
  lines.push(`拟更新 ${plan.writes.length} 个文件；预演未写入项目。`);
  return text.lines(lines as [string, ...string[]]);
}

function renderSyncApplied(plan: SyncPlanPayload, status: ReportPayload) {
  const stateNames = {
    ready: "正常",
    issues: "发现问题",
    incomplete: "覆盖不完整",
  } as const;
  const lines = [
    `sync：已应用来源 ${plan.sourceVersion}`,
    `更新文件 ${plan.writes.length} 项；待翻译 ${status.summary.pendingTranslations} 条；已修改 ${status.summary.modifiedTranslations} 条；缺失 ${status.summary.missingTranslations} 条。`,
    `应用后状态：${stateNames[status.state]}；诊断 ${status.diagnostics.length} 条。`,
  ];
  if (status.diagnostics.length > 0) lines.push("运行 check 查看具体诊断。");
  return text.lines(lines as [string, ...string[]]);
}

const define = defineCli<CliDependencies>();

const initCommand = define.command("init")({
  kind: "command",
  parent: "lands",
  name: "init",
  description: "初始化翻译项目并建立原文基线",
  fields: {
    project: {
      kind: "valueOption",
      longOption: "--project",
      description: "消费者项目目录",
    },
    jar: {
      kind: "valueOption",
      longOption: "--jar",
      description: "指定的上游 JAR 文件",
    },
  },
  input: z.object({ project: z.string().min(1), jar: z.string().min(1) }),
  success: {
    kind: "data",
    variants: {
      report: {
        description: "初始化结果",
        schema: z.object({ report: reportSchema }),
        exitCode: 0,
        text: ({ report }) => renderReport(report),
      },
    },
  },
  failures: {
    rejected: {
      description: "初始化无法安全完成",
      schema: z.object({ message: z.string() }),
      exitCode: 1,
      text: ({ message }) => text.line(`初始化失败：${message}`),
    },
  },
  async handler({ input, outcome }) {
    try {
      const report = await initializeProject(input.project, input.jar);
      return outcome.data.report({ report: reportPayload(report) });
    } catch (error) {
      return outcome.failure.rejected({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

const syncCommand = define.command("sync")({
  kind: "command",
  parent: "lands",
  name: "sync",
  description: "预演或应用指定上游 JAR 的同步计划",
  fields: {
    project: {
      kind: "valueOption",
      longOption: "--project",
      description: "消费者项目目录",
    },
    jar: {
      kind: "valueOption",
      longOption: "--jar",
      description: "指定的上游 JAR 文件",
    },
    dryRun: {
      kind: "flag",
      longOption: "--dry-run",
      negatedLongOption: "--no-dry-run",
      description: "只生成计划，不写入项目",
    },
  },
  input: z.object({
    project: z.string().min(1),
    jar: z.string().min(1),
    dryRun: z.boolean().default(false),
  }),
  success: {
    kind: "data",
    variants: {
      plan: {
        description: "同步预演计划",
        schema: z.object({ plan: syncPlanSchema }),
        exitCode: 0,
        text: ({ plan }) =>
          renderSyncPreview({ ready: true, plan } as SyncPreviewPayload),
      },
      applied: {
        description: "同步计划已应用",
        schema: z.object({ plan: syncPlanSchema, status: reportSchema }),
        exitCode: 0,
        text: ({ plan, status }) => renderSyncApplied(plan, status),
      },
    },
  },
  failures: {
    blocked: {
      description: "同步计划被资源差异或目标结构阻断",
      schema: z.object({ preview: syncPreviewSchema }),
      exitCode: 1,
      text: ({ preview }) => renderSyncPreview(preview),
    },
    rejected: {
      description: "同步输入或写入无法安全处理",
      schema: z.object({ message: z.string() }),
      exitCode: 1,
      text: ({ message }) => text.line(`同步失败：${message}`),
    },
  },
  async handler({ input, outcome }) {
    try {
      if (!input.dryRun) {
        const result = await applySyncProject(input.project, input.jar);
        return result.applied
          ? outcome.data.applied({
              plan: syncPlanPayload(result.plan),
              status: reportPayload(result.status),
            })
          : outcome.failure.blocked({
              preview: syncPreviewPayload(result.preview),
            });
      }

      const preview = await previewSyncProject(input.project, input.jar);
      return preview.ready
        ? outcome.data.plan({ plan: syncPlanPayload(preview.plan) })
        : outcome.failure.blocked({ preview: syncPreviewPayload(preview) });
    } catch (error) {
      return outcome.failure.rejected({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

const statusCommand = define.command("status")({
  kind: "command",
  parent: "lands",
  name: "status",
  description: "查询已保存的项目状态",
  fields: {
    project: {
      kind: "valueOption",
      longOption: "--project",
      description: "消费者项目目录",
    },
  },
  input: z.object({ project: z.string().min(1) }),
  success: {
    kind: "data",
    variants: {
      report: {
        description: "项目状态报告",
        schema: z.object({ report: reportSchema }),
        exitCode: 0,
        text: ({ report }) => renderReport(report),
      },
    },
  },
  failures: {
    report: {
      description: "项目结构存在问题",
      schema: z.object({ report: reportSchema }),
      exitCode: 1,
      text: ({ report }) => renderReport(report),
    },
  },
  async handler({ input, outcome }) {
    const report = await inspectProject(input.project, "status");
    return operationExitCode(report) === 0
      ? outcome.data.report({ report: reportPayload(report) })
      : outcome.failure.report({ report: reportPayload(report) });
  },
});

const checkCommand = define.command("check")({
  kind: "command",
  parent: "lands",
  name: "check",
  description: "只读检查项目结构与规则覆盖",
  fields: {
    project: {
      kind: "valueOption",
      longOption: "--project",
      description: "消费者项目目录",
    },
  },
  input: z.object({ project: z.string().min(1) }),
  success: {
    kind: "data",
    variants: {
      report: {
        description: "项目检查报告",
        schema: z.object({ report: reportSchema }),
        exitCode: 0,
        text: ({ report }) => renderReport(report),
      },
    },
  },
  failures: {
    report: {
      description: "结构存在问题或检查覆盖不完整",
      schema: z.object({ report: reportSchema }),
      exitCode: 1,
      text: ({ report }) => renderReport(report),
    },
  },
  async handler({ input, outcome }) {
    const report = await inspectProject(input.project, "check");
    return operationExitCode(report) === 0
      ? outcome.data.report({ report: reportPayload(report) })
      : outcome.failure.report({ report: reportPayload(report) });
  },
});

const exemptCommand = define.command("exempt")({
  kind: "command",
  parent: "lands",
  name: "exempt",
  description: "为当前一条例外候选记录接受理由",
  fields: {
    project: {
      kind: "valueOption",
      longOption: "--project",
      description: "消费者项目目录",
    },
    id: {
      kind: "valueOption",
      longOption: "--id",
      description: "当前 status/check 输出中的例外候选 ID",
    },
    reason: {
      kind: "valueOption",
      longOption: "--reason",
      description: "接受此例外的理由",
    },
  },
  input: z.object({
    project: z.string().min(1),
    id: z.string().regex(/^[0-9a-f]{64}$/),
    reason: z.string().trim().min(1),
  }),
  success: {
    kind: "data",
    variants: {
      recorded: {
        description: "例外已记录",
        schema: z.object({ exception: exceptionReceiptSchema }),
        exitCode: 0,
        text: ({ exception }) =>
          text.line(`已记录例外 ${exception.id}：${exception.reason}`),
      },
    },
  },
  failures: {
    rejected: {
      description: "当前例外无法记录",
      schema: z.object({ message: z.string() }),
      exitCode: 1,
      text: ({ message }) => text.line(`记录例外失败：${message}`),
    },
  },
  async handler({ input, outcome }) {
    try {
      const exception = await recordException(
        input.project,
        input.id,
        input.reason,
      );
      return outcome.data.recorded({ exception });
    } catch (error) {
      return outcome.failure.rejected({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

const schemaCommand = define.command("schema")({
  kind: "command",
  parent: "lands",
  name: "schema",
  description: "输出 CLI 契约 Schema",
  fields: {},
  input: z.object({}),
  success: {
    kind: "data",
    variants: {
      manifest: {
        description: "命令行契约 Schema",
        schema: z.object({ manifest: z.unknown() }),
        exitCode: 0,
        text: ({ manifest }) => {
          const [first, ...rest] = JSON.stringify(manifest, null, 2).split(
            "\n",
          );
          return text.lines([first!, ...rest]);
        },
      },
    },
  },
  failures: {},
  handler({ dependencies, outcome }) {
    return outcome.data.manifest({ manifest: dependencies.manifest });
  },
});

export const cli = define({
  root: "lands",
  help: helpCapability({
    shortAlias: "-h",
    headings: {
      usage: "用法",
      commands: "命令",
      arguments: "参数",
      options: "选项",
      constraints: "约束",
      supplement: "说明",
    },
    wording: {
      commandPlaceholder: "命令",
      choices: "可选：{choices}",
      default: "默认：{value}",
      whenOnMatch: "当满足 {facts} 时，{onMatch}",
      whenOtherwise: "当满足 {facts} 时，{otherwise}",
      whenOnMatchOtherwise: "当满足 {facts} 时，{onMatch}；否则 {otherwise}",
      require: "必须提供 {fields}",
      forbid: "不能提供 {fields}",
      present: "已提供 {field}",
      equals: "{field} 的值必须是 {value}",
      forbiddenCombination: "不能同时提供 {facts}",
      countExactly: "{fields} 恰好出现 {count} 项",
      countAtLeast: "{fields} 至少出现 {min} 项",
      countAtMost: "{fields} 至多出现 {max} 项",
      countBetween: "{fields} 出现 {min} 到 {max} 项",
    },
  }),
  output: outputCapability({
    defaultFormat: "text",
    compatibilityFlags: { "--json": "structured" },
  }),
  usageFailureExitCode: 64,
  commands: {
    lands: {
      kind: "rootGroup",
      name: "lands-l10n",
      description: "维护 Lands 简体中文翻译项目",
    },
    ...initCommand,
    ...syncCommand,
    ...statusCommand,
    ...checkCommand,
    ...exemptCommand,
    ...schemaCommand,
  },
});
