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
      "plugin.yml": strToU8("name: Lands\n"),
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

export async function createGuiProject(
  t: TestContext,
  options: {
    readonly name: string;
    readonly lore: readonly string[];
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
      "plugin.yml": strToU8("name: Lands\n"),
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
      '  version: "8.0.1"',
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
