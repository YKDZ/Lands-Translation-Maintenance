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
