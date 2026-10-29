import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { strToU8, zipSync } from "fflate";
import { stringify } from "yaml";

import { parseConfiguration } from "../src/configuration.ts";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliFile = resolve(packageDirectory, "dist/cli.js");

export function runCli(...args: string[]) {
  return spawnSync(process.execPath, [cliFile, ...args], {
    encoding: "utf8",
  });
}

export function runCliWithoutJava(...args: string[]) {
  return spawnSync(process.execPath, [cliFile, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/lands-l10n-missing-java" },
  });
}

export async function writeLioniProjectDeclaration(
  projectDirectory: string,
): Promise<void> {
  const legacyConfiguration = parseConfiguration(
    await readFile(join(projectDirectory, ".l10n/config.yml"), "utf8"),
  );
  if (!legacyConfiguration.ok) {
    throw new Error("测试夹具的旧维护配置无效。");
  }
  const { resources, translationScope } = legacyConfiguration.value;
  await mkdir(join(projectDirectory, ".lioni"), { recursive: true });
  await writeFile(
    join(projectDirectory, ".lioni/project.yml"),
    stringify({
      format: "lands-l10n-project/v1",
      resources,
      translationScope,
    }),
    "utf8",
  );
}

export async function snapshotProjectFiles(projectDirectory: string) {
  const paths: string[] = [];
  async function collect(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) await collect(absolutePath, relativePath);
      else if (entry.isFile()) paths.push(relativePath);
    }
  }
  await collect(projectDirectory, "");
  return Promise.all(
    paths
      .sort()
      .map(
        async (path) =>
          [path, await readFile(join(projectDirectory, path))] as const,
      ),
  );
}

export async function createProject(
  t: TestContext,
  options: {
    readonly sourceGreeting?: string;
    readonly sourceEntries?: readonly string[];
    readonly theme?: string;
    readonly bedrockTheme?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "lands-l10n-cli-"));
  t.after(async () => rm(directory, { force: true, recursive: true }));

  const jarFile = join(directory, "Lands.jar");
  await mkdir(join(directory, "lang"), { recursive: true });
  await mkdir(join(directory, ".l10n"), { recursive: true });
  await writeFile(
    jarFile,
    zipSync({
      "lang/en.yml": strToU8(
        [
          "messages:",
          `  greeting: ${JSON.stringify(options.sourceGreeting ?? "Hello")}`,
          "  welcome: Welcome",
          "  commands:",
          "    registered: Run",
          "list:",
          `  entries: [${(options.sourceEntries ?? ["first", "second"])
            .map((entry) => JSON.stringify(entry))
            .join(", ")}]`,
          "",
        ].join("\n"),
      ),
      "plugin.yml": strToU8("name: Lands\nversion: 8.0.1\n"),
      "settings.yml": strToU8("enabled: true\n"),
      "bedrock/lang/en_us.json": strToU8("not parsed by the first scope\n"),
      ...(options.theme === undefined
        ? {}
        : { "Locale/theme.yml": strToU8(options.theme) }),
      ...(options.bedrockTheme === undefined
        ? {}
        : { "bedrock/theme.yml": strToU8(options.bedrockTheme) }),
      "me/lands/Plugin.class": strToU8("class bytes"),
    }),
  );
  await writeFile(
    join(directory, ".l10n/config.yml"),
    [
      "schemaVersion: 1",
      "source:",
      '  version: "8.0.1"',
      '  translationHistory: "b8f6985a4ad2af1b76b05f0f79b718a2234623ad"',
      "resources:",
      "  - path: lang/en.yml",
      "    purpose: chat-language",
      "  - path: plugin.yml",
      "    purpose: metadata",
      "  - path: settings.yml",
      "    purpose: configuration",
      ...(options.theme === undefined
        ? []
        : ["  - path: Locale/theme.yml", "    purpose: configuration"]),
      "  - path: bedrock/lang/en_us.json",
      "    purpose: bedrock-excluded",
      ...(options.bedrockTheme === undefined
        ? []
        : ["  - path: bedrock/theme.yml", "    purpose: bedrock-excluded"]),
      "translationScope:",
      '  sourceLanguage: "en-US"',
      '  targetLanguage: "zh-CN"',
      "  mappings:",
      "    - source: lang/en.yml",
      "      target: lang/zh.yml",
      "      fields:",
      "        - path: [messages]",
      "          category: chat-string",
      "        - path: [list, entries]",
      "          category: chat-string-list",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "lang/zh.yml"),
    [
      "messages:",
      "  greeting: 你好",
      "  commands:",
      "    registered: 已注册",
      "list:",
      "  entries:",
      "    - 第一项",
      "    - 第二项",
      "",
    ].join("\n"),
  );

  return { directory, jarFile };
}

export async function createFormatProject(
  t: TestContext,
  options: {
    readonly sourceVersion?: string;
    readonly mapDescription?: string;
    readonly mapSpawn?: string;
    readonly targetMapDescription?: string;
    readonly targetMapSpawn?: string;
    readonly nationsMapDescription?: string;
    readonly targetNationsMapDescription?: string;
    readonly nationsCapitalSpawn?: string;
    readonly targetNationsCapitalSpawn?: string;
    readonly rootNationsMapDescription?: string;
    readonly targetRootNationsMapDescription?: string;
    readonly rootNationsCapitalSpawn?: string;
    readonly targetRootNationsCapitalSpawn?: string;
    readonly legacyTitle?: string;
    readonly targetLegacyTitle?: string;
    readonly unrelatedText?: string;
    readonly targetUnrelatedText?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "lands-l10n-formats-"));
  t.after(async () => rm(directory, { force: true, recursive: true }));

  const sourceLocale = [
    "general:",
    "  integration:",
    "    dynmap:",
    "      land:",
    `        description: ${JSON.stringify(options.mapDescription ?? '<div class="land" title="Land &amp; stone">Land: <v:land></div>')}`,
    `        spawn: ${JSON.stringify(options.mapSpawn ?? "Spawn at <v:land>")}`,
    "  land:",
    "    title:",
    "      land:",
    `        normal: ${JSON.stringify(options.legacyTitle ?? "Owned by %owner%")}`,
    "  unrelated:",
    `    text: ${JSON.stringify(options.unrelatedText ?? "A plain %owner% label")}`,
    "",
  ].join("\n");
  const targetLocale = [
    "general:",
    "  integration:",
    "    dynmap:",
    "      land:",
    `        description: ${JSON.stringify(options.targetMapDescription ?? '<div class="land" title="领地与石头">土地：<v:land></div>')}`,
    `        spawn: ${JSON.stringify(options.targetMapSpawn ?? "在<v:land>生成")}`,
    "  land:",
    "    title:",
    "      land:",
    `        normal: ${JSON.stringify(options.targetLegacyTitle ?? "属于%owner%")}`,
    "  unrelated:",
    `    text: ${JSON.stringify(options.targetUnrelatedText ?? "普通 %owner% 文本")}`,
    "",
  ].join("\n");
  const hasNationsMap = [
    options.nationsMapDescription,
    options.targetNationsMapDescription,
    options.nationsCapitalSpawn,
    options.targetNationsCapitalSpawn,
    options.rootNationsMapDescription,
    options.targetRootNationsMapDescription,
    options.rootNationsCapitalSpawn,
    options.targetRootNationsCapitalSpawn,
  ].some((value) => value !== undefined);
  const hasRootNationsIntegration = [
    options.rootNationsMapDescription,
    options.targetRootNationsMapDescription,
    options.rootNationsCapitalSpawn,
    options.targetRootNationsCapitalSpawn,
  ].some((value) => value !== undefined);
  const nationsSourceLocale = hasNationsMap
    ? [
        "general:",
        "  integration:",
        "    dynmap:",
        "      capital:",
        `        spawn: ${JSON.stringify(options.nationsCapitalSpawn ?? '<div class="capital">Spawn <v:public> /<v:cmd></div>')}`,
        "      nation:",
        `        description: ${JSON.stringify(options.nationsMapDescription ?? '<div class="nation">Land <v:land> · level <v:level></div>')}`,
        ...(hasRootNationsIntegration
          ? [
              "integration:",
              "  dynmap:",
              "    capital:",
              `      spawn: ${JSON.stringify(options.rootNationsCapitalSpawn ?? '<div class="root-capital">Capital</div>')}`,
              "    nation:",
              `      description: ${JSON.stringify(options.rootNationsMapDescription ?? '<div class="root-nation">Nation</div>')}`,
            ]
          : []),
        "",
      ].join("\n")
    : undefined;
  const nationsTargetLocale = hasNationsMap
    ? [
        "general:",
        "  integration:",
        "    dynmap:",
        "      capital:",
        `        spawn: ${JSON.stringify(options.targetNationsCapitalSpawn ?? '<div class="capital">在<v:public> /<v:cmd>生成</div>')}`,
        "      nation:",
        `        description: ${JSON.stringify(options.targetNationsMapDescription ?? '<div class="nation">城镇 <v:land> · 等级 <v:level></div>')}`,
        ...(hasRootNationsIntegration
          ? [
              "integration:",
              "  dynmap:",
              "    capital:",
              `      spawn: ${JSON.stringify(options.targetRootNationsCapitalSpawn ?? '<div class="root-capital">首都</div>')}`,
              "    nation:",
              `      description: ${JSON.stringify(options.targetRootNationsMapDescription ?? '<div class="root-nation">联邦</div>')}`,
            ]
          : []),
        "",
      ].join("\n")
    : undefined;
  const jarFile = join(directory, "Lands.jar");
  await writeFile(
    jarFile,
    zipSync({
      "plugin.yml": strToU8(
        `name: Lands\nversion: ${options.sourceVersion ?? "8.0.1"}\n`,
      ),
      "Locale/en-US.yml": strToU8(sourceLocale),
      ...(nationsSourceLocale === undefined
        ? {}
        : { "Locale/Nations/en-US.yml": strToU8(nationsSourceLocale) }),
    }),
  );
  await mkdir(join(directory, ".l10n"), { recursive: true });
  await mkdir(join(directory, "Locale"), { recursive: true });
  await writeFile(
    join(directory, ".l10n/config.yml"),
    [
      "schemaVersion: 1",
      "source:",
      `  version: ${JSON.stringify(options.sourceVersion ?? "8.9.2")}`,
      '  translationHistory: "b8f6985a4ad2af1b76b05f0f79b718a2234623ad"',
      "resources:",
      "  - path: plugin.yml",
      "    purpose: metadata",
      "  - path: Locale/en-US.yml",
      "    purpose: chat-language",
      ...(nationsSourceLocale === undefined
        ? []
        : ["  - path: Locale/Nations/en-US.yml", "    purpose: chat-language"]),
      "translationScope:",
      '  sourceLanguage: "en-US"',
      '  targetLanguage: "zh-CN"',
      "  mappings:",
      "    - source: Locale/en-US.yml",
      "      target: Locale/zh-CN.yml",
      "      fields:",
      "        - path: [general]",
      "          category: chat-string",
      ...(nationsSourceLocale === undefined
        ? []
        : [
            "    - source: Locale/Nations/en-US.yml",
            "      target: Locale/Nations/zh-CN.yml",
            "      fields:",
            "        - path: [general]",
            "          category: chat-string",
            ...(hasRootNationsIntegration
              ? [
                  "        - path: [integration]",
                  "          category: chat-string",
                ]
              : []),
          ]),
      "",
    ].join("\n"),
  );
  await writeFile(join(directory, "Locale/zh-CN.yml"), targetLocale);
  if (nationsTargetLocale !== undefined) {
    await mkdir(join(directory, "Locale/Nations"), { recursive: true });
    await writeFile(
      join(directory, "Locale/Nations/zh-CN.yml"),
      nationsTargetLocale,
    );
  }

  return { directory, jarFile };
}

export async function createGuiProject(
  t: TestContext,
  options: {
    readonly name: string;
    readonly lore: readonly string[];
    readonly sourceVersion?: string;
    readonly dialogItemName?: string;
    readonly categoryName?: string;
  },
) {
  const directory = await mkdtemp(join(tmpdir(), "lands-l10n-gui-cli-"));
  t.after(async () => rm(directory, { force: true, recursive: true }));
  await mkdir(join(directory, ".l10n"), { recursive: true });

  const source = [
    "physical:",
    "  selection:",
    `    name: ${JSON.stringify(options.name)}`,
    "    lore:",
    ...options.lore.map((line) => `      - ${JSON.stringify(line)}`),
    "",
  ].join("\n");
  const definitions = "physical:\n  selection:\n    material: GOLDEN_HOE\n";
  const theme = [
    "theme:",
    "  tokens:",
    '    common: "<gray>"',
    "  gui:",
    '    gui_only: "<green>"',
    "",
  ].join("\n");
  const dialogSource =
    options.dialogItemName === undefined
      ? undefined
      : [
          "dialogs:",
          "  confirmation:",
          "    bodies:",
          "      icon:",
          "        item:",
          `          name: ${JSON.stringify(options.dialogItemName)}`,
          "",
        ].join("\n");
  const categorySource =
    options.categoryName === undefined
      ? undefined
      : [
          "land:",
          "  categories:",
          "    peaceful:",
          `      name: ${JSON.stringify(options.categoryName)}`,
          "      enabled: true",
          "",
        ].join("\n");
  const additionalResources = [
    ...(dialogSource === undefined
      ? []
      : ["  - path: Locale/en-US_dialogs.yml", "    purpose: dialog-language"]),
    ...(categorySource === undefined
      ? []
      : ["  - path: categories.yml", "    purpose: configuration"]),
  ];
  const additionalMappings = [
    ...(dialogSource === undefined
      ? []
      : [
          "    - source: Locale/en-US_dialogs.yml",
          "      target: Locale/zh-CN_dialogs.yml",
          "      definitionsSource: Locale/en-US_dialogs.yml",
          "      fields:",
          "        - path: [dialogs, confirmation, bodies, icon, item, name]",
          "          category: gui-string",
          "          scene: gui-item-name",
        ]),
    ...(categorySource === undefined
      ? []
      : [
          "    - source: categories.yml",
          "      target: Locale/zh-CN_categories.yml",
          "      definitionsSource: categories.yml",
          "      fields:",
          '        - path: [land, categories, "*", name]',
          "          category: configuration-string",
          "          scene: category-name",
        ]),
  ];
  const jarFile = join(directory, "Lands.jar");
  await writeFile(
    jarFile,
    zipSync({
      "plugin.yml": strToU8(
        `name: Lands\nversion: ${options.sourceVersion ?? "8.0.1"}\n`,
      ),
      "Locale/en-US_gui.yml": strToU8(source),
      "Locale/definitions_gui.yml": strToU8(definitions),
      "Locale/theme.yml": strToU8(theme),
      ...(dialogSource === undefined
        ? {}
        : { "Locale/en-US_dialogs.yml": strToU8(dialogSource) }),
      ...(categorySource === undefined
        ? {}
        : { "categories.yml": strToU8(categorySource) }),
    }),
  );
  await writeFile(
    join(directory, ".l10n/config.yml"),
    [
      "schemaVersion: 1",
      "source:",
      `  version: ${JSON.stringify(options.sourceVersion ?? "8.0.1")}`,
      '  translationHistory: "b8f6985a4ad2af1b76b05f0f79b718a2234623ad"',
      "resources:",
      "  - path: plugin.yml",
      "    purpose: metadata",
      "  - path: Locale/en-US_gui.yml",
      "    purpose: gui-language",
      "  - path: Locale/definitions_gui.yml",
      "    purpose: configuration",
      "  - path: Locale/theme.yml",
      "    purpose: configuration",
      ...additionalResources,
      "translationScope:",
      '  sourceLanguage: "en-US"',
      '  targetLanguage: "zh-CN"',
      "  mappings:",
      "    - source: Locale/en-US_gui.yml",
      "      target: Locale/zh-CN_gui.yml",
      "      definitionsSource: Locale/definitions_gui.yml",
      "      fields:",
      "        - path: [physical, selection, name]",
      "          category: gui-string",
      "          scene: gui-item-name",
      "        - path: [physical, selection, lore]",
      "          category: gui-lore",
      "          scene: gui-item-lore",
      ...additionalMappings,
      "",
    ].join("\n"),
  );
  return { directory, jarFile };
}

export function readEnvelope(stdout: string) {
  return JSON.parse(stdout) as {
    readonly kind?: unknown;
    readonly variant?: unknown;
    readonly data?: Record<string, unknown>;
  };
}

export function readReport(output: string) {
  return readEnvelope(output).data?.report as Record<string, unknown>;
}
