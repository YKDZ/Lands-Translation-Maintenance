import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { strToU8, zipSync } from "fflate";
import { stringify } from "yaml";

const packageDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const nativeCli = join(packageDirectory, "node_modules/.bin/lioni");
const sourcePreparer = join(
  packageDirectory,
  "scripts/prepare-lioni-source.ts",
);

interface NativeDiagnostic {
  readonly checkId: string;
  readonly executionId: number;
  readonly object: {
    readonly key: string;
    readonly code?: string;
    readonly conceptId?: string;
    readonly origin?: string;
  };
  readonly location: {
    readonly range: {
      readonly file: string;
      readonly path: readonly (string | number)[];
      readonly start?: number;
      readonly end?: number;
      readonly documentIndex?: number;
      readonly textPositions?: readonly {
        readonly start: number;
        readonly end: number;
        readonly position: { readonly start: number; readonly end: number };
      }[];
    };
    readonly span?: { readonly start: number; readonly end: number };
  };
  readonly evidence: readonly {
    readonly role: string;
    readonly location: {
      readonly range?: {
        readonly textPositions?: readonly {
          readonly start: number;
          readonly end: number;
          readonly position: { readonly start: number; readonly end: number };
        }[];
      };
      readonly span?: { readonly start: number; readonly end: number };
    };
  }[];
  readonly handling: { readonly status: string };
}

interface QualityCheckResult {
  readonly checkId: string;
  readonly status: string;
  readonly diagnostics: readonly NativeDiagnostic[];
  readonly issues: readonly { readonly code: string }[];
  readonly executions: readonly {
    readonly executionId: number;
    readonly sourceKey: string;
    readonly status: string;
  }[];
}

interface QualityReport {
  readonly checks: readonly QualityCheckResult[];
  readonly diagnostics: readonly NativeDiagnostic[];
  readonly exceptionApplicability: readonly {
    readonly checkId: string;
    readonly sourceKey: string;
    readonly status: string;
  }[];
}

interface NativeEnvelope {
  readonly command: string;
  readonly data?: QualityReport;
  readonly report?: QualityReport;
}

const termFixture = [
  {
    id: "nation",
    note: "由城镇组成的实体。",
    english: ["nation", "nations"],
    chinese: ["联邦"],
  },
  {
    id: "land",
    note: "Lands 插件中的城镇领地实体。",
    english: ["land", "lands"],
    chinese: ["城镇"],
  },
  {
    id: "trust",
    note: "对应其他领地插件的 invite。",
    english: ["trust", "trusts", "trusted", "trusting"],
    chinese: ["邀请", "加入"],
  },
  {
    id: "trusted-player",
    note: "已受信任并获得成员身份的玩家。",
    english: ["trusted player", "trusted players"],
    chinese: ["成员"],
  },
  {
    id: "untrust",
    note: "对应其他领地插件的 kick。",
    english: ["untrust", "untrusted", "untrusting"],
    chinese: ["移出"],
  },
  {
    id: "claim-verb",
    note: "动词义。",
    english: ["claim", "claims", "claimed", "claiming"],
    chinese: ["占领"],
  },
  {
    id: "claim-noun",
    note: "名词义。",
    english: ["claim", "claims"],
    chinese: ["领土"],
  },
  {
    id: "unclaim",
    note: "取消占领。",
    english: ["unclaim", "unclaims", "unclaimed", "unclaiming"],
    chinese: ["取消占领"],
  },
  {
    id: "war",
    note: "战争。",
    english: ["war", "wars"],
    chinese: ["战争"],
  },
  {
    id: "declare-noun",
    note: "名词义。",
    english: [
      "declaration",
      "declarations",
      "war declaration",
      "war declarations",
    ],
    chinese: ["宣战书"],
  },
  {
    id: "declare-verb",
    note: "动词义。",
    english: [
      "declare",
      "declares",
      "declared",
      "declaring",
      "declare war",
      "declares war",
      "declared war",
      "declaring war",
    ],
    chinese: ["宣战"],
  },
  {
    id: "capture-block-or-flag",
    note: "战争中占领领土的信标道具。",
    english: [
      "capture block",
      "capture blocks",
      "capture flag",
      "capture flags",
    ],
    chinese: ["战旗"],
  },
] as const;

function termbaseDocuments() {
  const sourceReference = {
    path: "README.md",
    commit: "b8f6985a4ad2af1b76b05f0f79b718a2234623ad",
    section: "术语表",
  };
  const concepts = Object.fromEntries(
    termFixture.map((term) => [
      term.id,
      { note: term.note, sourceRefs: [sourceReference] },
    ]),
  );
  const language = (key: "english" | "chinese", prefix: string) =>
    Object.fromEntries(
      termFixture.map((term) => [
        term.id,
        {
          expressions: term[key].map((text) => ({
            id:
              prefix +
              (prefix === "en-US-"
                ? text.toLowerCase().replace(/[^a-z0-9]+/g, "-")
                : text),
            text,
            usage: "allowed",
          })),
        },
      ]),
    );
  return {
    concepts: stringify({ concepts }),
    english: stringify({ concepts: language("english", "en-US-") }),
    chinese: stringify({ concepts: language("chinese", "zh-CN-") }),
  };
}

function landsJar(
  sourceName: string,
  sourceLore: readonly string[],
  cancelName: string,
  mapDescription?: string,
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "plugin.yml": strToU8("name: Lands\nversion: 8.9.2\n"),
    "Locale/en-US_gui.yml": strToU8(
      [
        "gui:",
        "  main:",
        "    items:",
        "      confirm:",
        "        name: " + JSON.stringify(sourceName),
        "        lore: " + JSON.stringify(sourceLore),
        "      cancel:",
        "        name: " + JSON.stringify(cancelName),
        "",
      ].join("\n"),
    ),
    "Locale/definitions_gui.yml": strToU8(
      [
        "gui:",
        "  main:",
        "    items:",
        "      confirm:",
        "        material: EMERALD",
        "        slot: 1",
        '        name: "<red>Confirm</red>"',
        '        lore: ["First line", "Second line"]',
        "        action: confirm",
        "      cancel:",
        "        material: BARRIER",
        "        slot: 2",
        '        name: "Cancel"',
        "        action: cancel",
        "",
      ].join("\n"),
    ),
    "Locale/theme.yml": strToU8('theme:\n  tokens:\n    known: "<red>"\n'),
  };
  if (mapDescription !== undefined) {
    files["Locale/en-US.yml"] = strToU8(
      [
        "general:",
        "  integration:",
        "    dynmap:",
        "      land:",
        "        description: " + JSON.stringify(mapDescription),
        "",
      ].join("\n"),
    );
  }
  return zipSync(files);
}

function mapTargetYaml(description: string): string {
  return [
    "general:",
    "  integration:",
    "    dynmap:",
    "      land:",
    "        description: " + JSON.stringify(description),
    "",
  ].join("\n");
}

function targetYaml(
  confirmName: string,
  confirmLore: readonly string[],
  cancelName: string,
): string {
  return [
    "gui:",
    "  main:",
    "    items:",
    "      confirm:",
    "        name: " + JSON.stringify(confirmName),
    "        lore: " + JSON.stringify(confirmLore),
    "      cancel:",
    "        name: " + JSON.stringify(cancelName),
    "",
  ].join("\n");
}

async function createProject(
  t: TestContext,
  input: {
    readonly sourceName: string;
    readonly targetName: string;
    readonly sourceLore?: readonly string[];
    readonly targetLore?: readonly string[];
    readonly sourceCancelName?: string;
    readonly targetCancelName?: string;
    readonly mapSource?: string;
    readonly mapTarget?: string;
  },
): Promise<{
  readonly directory: string;
  readonly configPath: string;
  readonly targetPath: string;
  readonly mapTargetPath: string;
  readonly termDirectory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "lioni-terminology-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const sourceLore = input.sourceLore ?? ["How are you?"];
  const targetLore = input.targetLore ?? ["你好。"];
  assert.equal(input.mapSource === undefined, input.mapTarget === undefined);
  const sourceCancelName = input.sourceCancelName ?? "Cancel";
  const targetCancelName = input.targetCancelName ?? "取消";
  await Promise.all([
    mkdir(join(directory, ".l10n"), { recursive: true }),
    mkdir(join(directory, ".lioni/terms"), { recursive: true }),
    mkdir(join(directory, "Locale"), { recursive: true }),
  ]);
  await writeFile(
    join(directory, ".l10n/config.yml"),
    [
      "schemaVersion: 1",
      "source:",
      '  version: "8.9.2"',
      '  translationHistory: "terminology-fixture"',
      "resources:",
      "  - path: plugin.yml",
      "    purpose: metadata",
      "  - path: Locale/en-US_gui.yml",
      "    purpose: gui-language",
      ...(input.mapSource === undefined
        ? []
        : ["  - path: Locale/en-US.yml", "    purpose: chat-language"]),
      "  - path: Locale/definitions_gui.yml",
      "    purpose: configuration",
      "  - path: Locale/theme.yml",
      "    purpose: configuration",
      "translationScope:",
      '  sourceLanguage: "en-US"',
      '  targetLanguage: "zh-CN"',
      "  mappings:",
      "    - source: Locale/en-US_gui.yml",
      "      target: Locale/zh-CN_gui.yml",
      "      definitionsSource: Locale/definitions_gui.yml",
      "      fields:",
      "        - path: [gui, main, items, confirm, name]",
      "          category: gui-string",
      "          scene: gui-general",
      "        - path: [gui, main, items, confirm, lore]",
      "          category: gui-lore",
      "          scene: gui-item-lore",
      "        - path: [gui, main, items, cancel, name]",
      "          category: gui-string",
      "          scene: gui-general",
      ...(input.mapSource === undefined
        ? []
        : [
            "    - source: Locale/en-US.yml",
            "      target: Locale/zh-CN.yml",
            "      fields:",
            "        - path: [general, integration, dynmap, land, description]",
            "          category: chat-string",
          ]),
      "",
    ].join("\n"),
  );
  const termbase = termbaseDocuments();
  const termDirectory = join(directory, ".lioni/terms");
  await Promise.all([
    writeFile(join(termDirectory, "concepts.yaml"), termbase.concepts),
    writeFile(join(termDirectory, "en-US.yaml"), termbase.english),
    writeFile(join(termDirectory, "zh-CN.yaml"), termbase.chinese),
    writeFile(
      join(directory, "Locale/zh-CN_gui.yml"),
      targetYaml(input.targetName, targetLore, targetCancelName),
    ),
    ...(input.mapTarget === undefined
      ? []
      : [
          writeFile(
            join(directory, "Locale/zh-CN.yml"),
            mapTargetYaml(input.mapTarget),
          ),
        ]),
  ]);
  const configPath = join(directory, ".lioni/lioni.config.ts");
  await writeFile(
    configPath,
    [
      'import { createLandsConfig } from "@lands-l10n/l10n/lioni.config";',
      "",
      "export default createLandsConfig(import.meta.url);",
      "",
    ].join("\n"),
  );
  const scopedPackageDirectory = join(directory, "node_modules/@lands-l10n");
  await mkdir(scopedPackageDirectory, { recursive: true });
  await symlink(packageDirectory, join(scopedPackageDirectory, "l10n"), "dir");

  const jarPath = join(directory, "Lands.jar");
  await writeFile(
    jarPath,
    landsJar(input.sourceName, sourceLore, sourceCancelName, input.mapSource),
  );
  const prepared = spawnSync(
    process.execPath,
    [
      "--conditions=source",
      sourcePreparer,
      "--jar",
      jarPath,
      "--config",
      configPath,
    ],
    { cwd: tmpdir(), encoding: "utf8" },
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  await rm(jarPath);
  return {
    directory,
    configPath,
    targetPath: join(directory, "Locale/zh-CN_gui.yml"),
    mapTargetPath: join(directory, "Locale/zh-CN.yml"),
    termDirectory,
  };
}

function runLioni(args: readonly string[]): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [nativeCli, ...args, "--output-format", "structured"],
    { cwd: tmpdir(), encoding: "utf8" },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function qualityReport(result: ReturnType<typeof runLioni>): {
  readonly envelope: NativeEnvelope;
  readonly report: QualityReport;
} {
  const output = result.stdout.trim() || result.stderr.trim();
  const envelope = JSON.parse(output) as NativeEnvelope;
  assert.equal(envelope.command, "qa", output);
  const report = envelope.data ?? envelope.report;
  assert.ok(report, output);
  return { envelope, report };
}

function checkResult(
  report: QualityReport,
  checkId: string,
): QualityCheckResult {
  assert.ok(Array.isArray(report.checks), JSON.stringify(report, null, 2));
  const result = report.checks.find((check) => check.checkId === checkId);
  assert.ok(result, "QA 缺少 " + checkId + " 检查项");
  return result;
}

void test("正式 QA 接入原生术语库并保留同等允许译法", async (t) => {
  const project = await createProject(t, {
    sourceName: "trust",
    targetName: "邀请",
  });
  const first = qualityReport(runLioni(["qa", project.configPath]));
  assert.deepEqual(checkResult(first.report, "terminology").diagnostics, []);

  await writeFile(project.targetPath, targetYaml("加入", ["你好。"], "取消"));
  const second = qualityReport(runLioni(["qa", project.configPath]));
  assert.deepEqual(checkResult(second.report, "terminology").diagnostics, []);
});

void test("正式 QA 报告术语缺失并按原生位置和消息作用域处理", async (t) => {
  const project = await createProject(t, {
    sourceName: "Nation",
    targetName: "国家",
    sourceLore: ["trust", "trust"],
    targetLore: ["邀请", "错误译法"],
  });
  const report = qualityReport(runLioni(["qa", project.configPath]));
  const terminology = checkResult(report.report, "terminology");
  const findings = terminology.diagnostics.filter(
    ({ object }) =>
      object.conceptId === "nation" || object.conceptId === "trust",
  );
  assert.equal(findings.length, 2, JSON.stringify(terminology, null, 2));
  const nation = findings.find(({ object }) => object.conceptId === "nation");
  const trust = findings.find(({ object }) => object.conceptId === "trust");
  assert.ok(nation);
  assert.ok(trust);
  assert.deepEqual(nation.location.range.path, [
    "gui",
    "main",
    "items",
    "confirm",
    "name",
  ]);
  assert.deepEqual(trust.location.range.path, [
    "gui",
    "main",
    "items",
    "confirm",
    "lore",
    1,
  ]);
});

void test("原生匹配保留大小写、空白、词义、专名和技术标识语义", async (t) => {
  const project = await createProject(t, {
    sourceName:
      "<red>NATION</red> | Capture   Block | the claim of land | declare war | Lands plugin | claim-worlds-list | unclaimed location",
    targetName:
      "国家 | 错误旗帜 | 占领 城镇 | 宣战书 | Lands 插件 | claim-worlds-list | 未认领地点",
  });
  const report = qualityReport(runLioni(["qa", project.configPath]));
  const terminology = checkResult(report.report, "terminology");
  assert.deepEqual(
    terminology.diagnostics
      .map(({ object }) => object.conceptId)
      .sort((left, right) => (left ?? "").localeCompare(right ?? "")),
    ["capture-block-or-flag", "claim-noun", "declare-verb", "nation"],
  );
  const sourceEvidence = terminology.diagnostics
    .flatMap(({ evidence }) => evidence)
    .find(({ role }) => role === "source-term");
  assert.ok(sourceEvidence?.location.span);
  assert.ok(
    sourceEvidence.location.range?.textPositions?.some(
      ({ position }) => position.end > position.start,
    ),
  );
});

void test("原生分组隔离按钮、列表、hover 和 HTML 属性正文", async (t) => {
  const buttons = await createProject(t, {
    sourceName: "Trust",
    targetName: "邀请",
    sourceCancelName: "Trust",
    targetCancelName: "错误译法",
  });
  const buttonReport = qualityReport(runLioni(["qa", buttons.configPath]));
  const buttonFindings = checkResult(
    buttonReport.report,
    "terminology",
  ).diagnostics;
  assert.equal(buttonFindings.length, 1);
  assert.deepEqual(buttonFindings[0]?.location.range.path, [
    "gui",
    "main",
    "items",
    "cancel",
    "name",
  ]);

  const hover = await createProject(t, {
    sourceName: "<hover:show_text:'Nation'>Owner</hover>",
    targetName: "<hover:show_text:'国家'>所有者</hover>",
  });
  const hoverReport = qualityReport(runLioni(["qa", hover.configPath]));
  const hoverFindings = checkResult(
    hoverReport.report,
    "terminology",
  ).diagnostics;
  assert.deepEqual(
    hoverFindings.map(({ object }) => object.conceptId),
    ["nation"],
  );
  assert.notEqual(hoverFindings[0]?.location.range.documentIndex, 0);

  const html = await createProject(t, {
    sourceName: "Confirm",
    targetName: "确认",
    mapSource: "<div title=Nation>Owner</div>",
    mapTarget: "<div title=联邦>所有者</div>",
  });
  assert.deepEqual(
    checkResult(
      qualityReport(runLioni(["qa", html.configPath])).report,
      "terminology",
    ).diagnostics,
    [],
  );
  await writeFile(
    html.mapTargetPath,
    mapTargetYaml("<div title=国家>所有者</div>"),
  );
  const htmlReport = qualityReport(runLioni(["qa", html.configPath]));
  const htmlFindings = checkResult(
    htmlReport.report,
    "terminology",
  ).diagnostics;
  assert.deepEqual(
    htmlFindings.map(({ object }) => object.conceptId),
    ["nation"],
  );
  assert.equal(htmlFindings[0]?.location.range.file, "Locale/zh-CN.yml");
  assert.deepEqual(htmlFindings[0]?.location.range.path, [
    "general",
    "integration",
    "dynmap",
    "land",
    "description",
  ]);
});

void test("原生政策区分信任状态与动作、claim 词义及战争外交", async (t) => {
  const trust = await createProject(t, {
    sourceName: "Cancel",
    targetName: "取消",
    sourceLore: [
      "Temporary trust",
      "You are not trusted in this area",
      "Trusted player",
      "Trust this player",
      "You were untrusted because temporary trust expired",
      "You untrusted the player",
    ],
    targetLore: [
      "临时信任",
      "此子区域中你不可信",
      "成员",
      "邀请此玩家",
      "你已移出，因为临时邀请过期",
      "你已移出该玩家",
    ],
  });
  assert.deepEqual(
    checkResult(
      qualityReport(runLioni(["qa", trust.configPath])).report,
      "terminology",
    ).diagnostics,
    [],
  );
  await writeFile(
    trust.targetPath,
    targetYaml(
      "取消",
      [
        "临时信任",
        "此子区域中你不可信",
        "成员",
        "信任此玩家",
        "你已移出，因为临时邀请过期",
        "你已移出该玩家",
      ],
      "取消",
    ),
  );
  const wrongTrust = checkResult(
    qualityReport(runLioni(["qa", trust.configPath])).report,
    "terminology",
  ).diagnostics;
  assert.deepEqual(
    wrongTrust.map(({ object }) => object.conceptId),
    ["trust"],
  );
  assert.deepEqual(wrongTrust[0]?.location.range.path, [
    "gui",
    "main",
    "items",
    "confirm",
    "lore",
    3,
  ]);

  const claim = await createProject(t, {
    sourceName: "Claim this chunk",
    targetName: "领土此区块",
  });
  assert.deepEqual(
    checkResult(
      qualityReport(runLioni(["qa", claim.configPath])).report,
      "terminology",
    ).diagnostics.map(({ object }) => object.conceptId),
    ["claim-verb"],
  );

  const diplomacy = await createProject(t, {
    sourceName:
      "Declare war. War declaration. You may declare land as an enemy.",
    targetName: "宣战。宣战书。你可以与城镇结为政敌。",
  });
  assert.deepEqual(
    checkResult(
      qualityReport(runLioni(["qa", diplomacy.configPath])).report,
      "terminology",
    ).diagnostics,
    [],
  );
  await writeFile(
    diplomacy.targetPath,
    targetYaml("宣战书。宣战书。你可以与城镇结为政敌。", ["你好。"], "取消"),
  );
  assert.deepEqual(
    checkResult(
      qualityReport(runLioni(["qa", diplomacy.configPath])).report,
      "terminology",
    ).diagnostics.map(({ object }) => object.conceptId),
    ["declare-verb"],
  );
});

void test("中文标点继承按正文上下文计数，且同文跳过中文检查", async (t) => {
  const project = await createProject(t, {
    sourceName: "<red>Welcome </red>•‹›«»·",
    targetName: "<blue>欢迎</blue> •‹›«»··",
    sourceLore: ["How are you?"],
    targetLore: ["您好吗,"],
  });
  const report = qualityReport(runLioni(["qa", project.configPath]));
  const punctuation = checkResult(report.report, "translation-punctuation");
  assert.deepEqual(
    punctuation.diagnostics.map(({ object }) => object.code),
    ["translation-style.punctuation"],
  );
  const honorific = checkResult(report.report, "translation-honorific");
  assert.deepEqual(
    honorific.diagnostics.map(({ object }) => object.code),
    ["translation-style.honorific"],
  );

  const identical = await createProject(t, {
    sourceName: "您，",
    targetName: "您，",
    sourceLore: ["Nation"],
    targetLore: ["Nation"],
  });
  const same = qualityReport(runLioni(["qa", identical.configPath]));
  assert.deepEqual(
    checkResult(same.report, "translation-punctuation").diagnostics,
    [],
  );
  assert.deepEqual(
    checkResult(same.report, "translation-honorific").diagnostics,
    [],
  );
  assert.deepEqual(checkResult(same.report, "terminology").diagnostics, []);
});

void test("原生例外随当前译文和术语资料变化失效并可恢复", async (t) => {
  const project = await createProject(t, {
    sourceName: "Nation",
    targetName: "国家",
    sourceCancelName: "Nation",
    targetCancelName: "联邦",
  });
  const initial = qualityReport(runLioni(["qa", project.configPath]));
  const terminology = checkResult(initial.report, "terminology");
  const nation = terminology.diagnostics.find(
    ({ object, location }) =>
      object.conceptId === "nation" &&
      JSON.stringify(location.range.path) ===
        JSON.stringify(["gui", "main", "items", "confirm", "name"]),
  );
  assert.ok(nation, JSON.stringify(terminology, null, 2));
  const execution = terminology.executions.find(
    ({ executionId }) => executionId === nation.executionId,
  );
  assert.ok(execution);

  const reportPath = join(project.directory, "qa-report.json");
  await writeFile(reportPath, JSON.stringify(initial.envelope));
  const accepted = runLioni([
    "exceptions",
    "upsert",
    project.configPath,
    reportPath,
    "--check-id",
    "terminology",
    "--execution-id",
    String(execution.executionId),
    "--id",
    "nation-exception",
    "--reason",
    "当前术语诊断需要维护者复核",
  ]);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);

  const excepted = qualityReport(runLioni(["qa", project.configPath]));
  assert.equal(
    checkResult(excepted.report, "terminology").diagnostics.find(
      ({ object }) => object.conceptId === "nation",
    )?.handling.status,
    "excepted",
  );

  await writeFile(project.targetPath, targetYaml("国家", ["你好。"], "国家"));
  const unrelatedChange = qualityReport(runLioni(["qa", project.configPath]));
  assert.equal(
    unrelatedChange.report.exceptionApplicability.find(
      ({ checkId, sourceKey }) =>
        checkId === "terminology" && sourceKey === nation.object.key,
    )?.status,
    "applicable",
  );

  await writeFile(project.targetPath, targetYaml("王国", ["你好。"], "联邦"));
  const changedTranslation = qualityReport(
    runLioni(["qa", project.configPath]),
  );
  assert.equal(
    changedTranslation.report.exceptionApplicability.find(
      ({ checkId, sourceKey }) =>
        checkId === "terminology" && sourceKey === nation.object.key,
    )?.status,
    "basis-changed",
  );

  const termPath = join(project.termDirectory, "zh-CN.yaml");
  const originalTerms = await readFile(termPath, "utf8");
  await writeFile(termPath, originalTerms.replace("text: 联邦", "text: 国家"));
  await writeFile(project.targetPath, targetYaml("国家", ["你好。"], "联邦"));
  const changedTermbase = qualityReport(runLioni(["qa", project.configPath]));
  assert.equal(
    changedTermbase.report.exceptionApplicability.find(
      ({ checkId, sourceKey }) =>
        checkId === "terminology" && sourceKey === nation.object.key,
    )?.status,
    "basis-changed",
  );

  await writeFile(termPath, originalTerms);
  const restored = qualityReport(runLioni(["qa", project.configPath]));
  assert.equal(
    restored.report.exceptionApplicability.find(
      ({ checkId, sourceKey }) =>
        checkId === "terminology" && sourceKey === nation.object.key,
    )?.status,
    "applicable",
  );
});
