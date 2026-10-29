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
import { parse, stringify } from "yaml";

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
  readonly issues: readonly {
    readonly code: string;
    readonly evidence?: readonly {
      readonly role: string;
      readonly value: unknown;
    }[];
  }[];
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
    id: "shield",
    note: "保护城镇或联邦免于战争的一段时间。",
    english: ["shield", "shields"],
    chinese: ["战争护盾"],
  },
  {
    id: "upkeep",
    note: "维护费用。",
    english: ["upkeep"],
    chinese: ["维护费"],
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
    mkdir(join(directory, ".lioni"), { recursive: true }),
    mkdir(join(directory, ".lioni/terms"), { recursive: true }),
    mkdir(join(directory, "Locale"), { recursive: true }),
  ]);
  await writeFile(
    join(directory, ".lioni/project.yml"),
    [
      "format: lands-l10n-project/v1",
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

void test("同一正文上下文内的变量换序仍满足维护费译法", async (t) => {
  const project = await createProject(t, {
    sourceName:
      "You need to pay <v:0> in upkeep in <v:1>, but <v:2> has insufficient funds. This will lead to the nation being deleted.",
    targetName:
      "你需要在 <v:1> 内支付 <v:0> 维护费, 但 <v:2> 资金不足. 这会导致联邦被删除.",
  });
  const terminology = checkResult(
    qualityReport(runLioni(["qa", project.configPath])).report,
    "terminology",
  );

  assert.equal(terminology.status, "complete");
  assert.deepEqual(
    terminology.diagnostics.filter(
      ({ object }) => object.conceptId === "upkeep",
    ),
    [],
  );
});

void test("一个正文上下文内的重叠术语分别检查且不比较出现次数", async (t) => {
  const repeated = await createProject(t, {
    sourceName: "War and war",
    targetName: "战争",
  });
  assert.deepEqual(
    checkResult(
      qualityReport(runLioni(["qa", repeated.configPath])).report,
      "terminology",
    ).diagnostics,
    [],
  );

  const shield = await createProject(t, {
    sourceName: "war shield",
    targetName: "战争护盾",
  });
  assert.deepEqual(
    checkResult(
      qualityReport(runLioni(["qa", shield.configPath])).report,
      "terminology",
    ).diagnostics,
    [],
  );

  await writeFile(shield.targetPath, targetYaml("战争", ["你好。"], "取消"));
  const missingShield = checkResult(
    qualityReport(runLioni(["qa", shield.configPath])).report,
    "terminology",
  ).diagnostics;
  assert.deepEqual(
    missingShield.map(({ object }) => object.conceptId),
    ["shield"],
  );
  assert.deepEqual(missingShield[0]?.location.range.textPositions, [
    { start: 0, end: 2, position: { start: 0, end: 2 } },
  ]);

  await writeFile(shield.targetPath, targetYaml("护盾", ["你好。"], "取消"));
  const missingBoth = checkResult(
    qualityReport(runLioni(["qa", shield.configPath])).report,
    "terminology",
  ).diagnostics;
  assert.deepEqual(
    missingBoth
      .map(({ object }) => object.conceptId)
      .sort((left, right) => (left ?? "").localeCompare(right ?? "")),
    ["shield", "war"],
  );
});

void test("变量切断英文术语，且产品名 Lands data 不放宽实体 lands", async (t) => {
  const split = await createProject(t, {
    sourceName: "Na<v:player>tion",
    targetName: "任<v:player>何",
  });
  const splitTerminology = checkResult(
    qualityReport(runLioni(["qa", split.configPath])).report,
    "terminology",
  );
  assert.deepEqual(
    splitTerminology.diagnostics.filter(
      ({ object }) => object.conceptId === "nation",
    ),
    [],
  );

  const product = await createProject(t, {
    sourceName: "Your Lands data couldn't be loaded.",
    targetName: "你的 Lands 数据无法被加载.",
  });
  const productTerminology = checkResult(
    qualityReport(runLioni(["qa", product.configPath])).report,
    "terminology",
  );
  assert.deepEqual(
    productTerminology.diagnostics.filter(
      ({ object }) => object.conceptId === "land",
    ),
    [],
  );

  const entity = await createProject(t, {
    sourceName: "Your lands",
    targetName: "你的土地",
  });
  assert.deepEqual(
    checkResult(
      qualityReport(runLioni(["qa", entity.configPath])).report,
      "terminology",
    ).diagnostics.map(({ object }) => object.conceptId),
    ["land"],
  );
});

void test("变量后的外交语境在正文、按钮和悬浮说明中保持完整", async (t) => {
  const scopes = [
    {
      source: "You can't declare land <v:land> as an enemy.",
      target: "无法将城镇 <v:land> 设为政敌.",
    },
    {
      source:
        "<click:run_command:'/lands relation enemies add'>✖ Declare nation <v:nation> as an enemy instead: /<v:cmd></click>",
      target:
        "<click:run_command:'/lands relation enemies add'>✖ 改为将联邦 <v:nation> 设为政敌: /<v:cmd></click>",
    },
    {
      source:
        "<hover:show_text:'Click here to declare nation <v:nation> as an enemy.'>Hover</hover>",
      target:
        "<hover:show_text:'点击此处将联邦 <v:nation> 设为政敌.'>悬浮</hover>",
    },
  ];

  for (const { source, target } of scopes) {
    const project = await createProject(t, {
      sourceName: source,
      targetName: target,
    });
    const terminology = checkResult(
      qualityReport(runLioni(["qa", project.configPath])).report,
      "terminology",
    );
    assert.equal(terminology.status, "complete");
    assert.deepEqual(
      terminology.diagnostics.filter(
        ({ object }) => object.conceptId === "declare-verb",
      ),
      [],
      source,
    );
  }
});

void test("离开 HTML 所属语境后再返回时保留独立正文片段", async (t) => {
  const project = await createProject(t, {
    sourceName: "Confirm",
    targetName: "确认",
    mapSource: "<div>Declare<span>Nation</span> as an enemy</div>",
    mapTarget: "<div>宣布<span>联邦</span>设为政敌</div>",
  });
  const terminology = checkResult(
    qualityReport(runLioni(["qa", project.configPath])).report,
    "terminology",
  );

  assert.deepEqual(
    terminology.diagnostics.map(({ object }) => object.conceptId),
    ["declare-verb"],
  );
});

void test("源术语扫描有歧义时保留原生证据并将检查标为不完整", async (t) => {
  const project = await createProject(t, {
    sourceName: "war",
    targetName: "战争",
  });
  const sourceTermsPath = join(project.termDirectory, "en-US.yaml");
  const sourceTerms = parse(await readFile(sourceTermsPath, "utf8")) as {
    concepts: Record<
      string,
      { expressions: { id: string; text: string; usage: "allowed" }[] }
    >;
  };
  const shield = sourceTerms.concepts.shield;
  assert.ok(shield);
  shield.expressions.push({
    id: "en-US-shield-alias",
    text: "war",
    usage: "allowed",
  });
  await writeFile(sourceTermsPath, stringify(sourceTerms));

  const terminology = checkResult(
    qualityReport(runLioni(["qa", project.configPath])).report,
    "terminology",
  );
  assert.equal(terminology.status, "incomplete");
  assert.deepEqual(terminology.diagnostics, []);
  const issue = terminology.issues.find(
    ({ code }) => code === "terminology.source-analysis-incomplete",
  );
  assert.ok(issue);
  const evidence = issue.evidence?.find(
    ({ role }) => role === "native-source-term-analysis",
  );
  assert.ok(evidence);
  const serializedEvidence = JSON.stringify(evidence.value);
  assert.match(serializedEvidence, /same-span-concepts/u);
  assert.match(serializedEvidence, /Locale\/en-US_gui\.yml/u);
  assert.match(serializedEvidence, /contextKey/u);
  assert.match(serializedEvidence, /positions/u);
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
    sourceLore: ["Trust", "Trust"],
    targetLore: ["邀请", "错误译法"],
    sourceCancelName: "Trust",
    targetCancelName: "错误译法",
  });
  const buttonReport = qualityReport(runLioni(["qa", buttons.configPath]));
  const buttonFindings = checkResult(
    buttonReport.report,
    "terminology",
  ).diagnostics;
  assert.equal(buttonFindings.length, 2);
  assert.deepEqual(
    buttonFindings.map(({ location }) => location.range.path),
    [
      ["gui", "main", "items", "cancel", "name"],
      ["gui", "main", "items", "confirm", "lore", 1],
    ],
  );

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
