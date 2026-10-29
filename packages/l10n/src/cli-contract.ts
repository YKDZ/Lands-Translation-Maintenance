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
import type { ProjectReport } from "#/model";
import {
  initializeProject,
  inspectProject,
  operationExitCode,
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

function renderReport(report: ReportPayload) {
  const stateNames = {
    ready: "正常",
    issues: "发现问题",
    incomplete: "覆盖不完整",
  } as const;
  const lines = [
    `${report.operation}：${stateNames[report.state]}`,
    `资源文件 ${report.summary.resourceFiles} 项；消息 ${report.summary.messages} 条。`,
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
    ...statusCommand,
    ...checkCommand,
    ...exemptCommand,
    ...schemaCommand,
  },
});
