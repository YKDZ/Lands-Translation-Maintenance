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
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { strToU8, zipSync } from "fflate";
import { parseDocument } from "yaml";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeCli = join(packageDirectory, "node_modules/.bin/lioni");
const sourcePreparer = join(
  packageDirectory,
  "scripts/prepare-lioni-source.ts",
);

function runLioni(args: readonly string[]): string {
  const result = spawnSync(process.execPath, [nativeCli, ...args], {
    cwd: tmpdir(),
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `${args.join(" ")} 失败：\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

async function prepareSource(
  configPath: string,
  jarPath: string,
): Promise<void> {
  const result = spawnSync(
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
  assert.equal(result.status, 0, result.stderr);
  const sourceDirectory = join(dirname(configPath), "source");
  const pointer = JSON.parse(
    await readFile(join(sourceDirectory, "current.json"), "utf8"),
  ) as { readonly snapshotSha256: string };
  const manifest = JSON.parse(
    await readFile(
      join(
        sourceDirectory,
        "snapshots",
        pointer.snapshotSha256,
        "manifest.json",
      ),
      "utf8",
    ),
  ) as { readonly sourceVersion: string };
  assert.equal(manifest.sourceVersion, "8.9.2");
}

async function createProject(directory: string): Promise<void> {
  await mkdir(join(directory, ".l10n"), { recursive: true });
  await mkdir(join(directory, ".lioni"), { recursive: true });
  await mkdir(join(directory, "Locale"), { recursive: true });
  await writeFile(
    join(directory, ".l10n/config.yml"),
    [
      "schemaVersion: 1",
      "source:",
      '  version: "8.9.2"',
      '  translationHistory: "fixture-history"',
      "resources:",
      "  - path: plugin.yml",
      "    purpose: metadata",
      "  - path: Locale/en-US.yml",
      "    purpose: chat-language",
      "translationScope:",
      '  sourceLanguage: "en-US"',
      '  targetLanguage: "zh-CN"',
      "  mappings:",
      "    - source: Locale/en-US.yml",
      "      target: Locale/zh-CN.yml",
      "      fields:",
      "        - path: [messages]",
      "          category: chat-string",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "Locale/zh-CN.yml"),
    [
      "# 保留文件注释",
      "messages:",
      "  greet: 你好 # 保留字段注释",
      "  leave: 再见",
      "custom: 保留用户字段",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(directory, ".lioni/lioni.config.ts"),
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
}

function landsJar(messages: string): Uint8Array {
  return zipSync({
    "plugin.yml": strToU8("name: Lands\nversion: 8.9.2\n"),
    "Locale/en-US.yml": strToU8(messages),
  });
}

void test("原生 update 回填变化与缺失消息并保留未变中文及 YAML 注释", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "lioni-update-"));
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const initialJar = join(project, "Lands-initial.jar");
  const changedJar = join(project, "Lands-changed.jar");
  await writeFile(
    initialJar,
    landsJar("messages:\n  greet: Hello\n  leave: Goodbye\n"),
  );
  await prepareSource(configPath, initialJar);
  await rm(initialJar);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  await writeFile(
    changedJar,
    landsJar(
      "messages:\n  greet: Hello again\n  leave: Goodbye\n  fresh: New sentence\n",
    ),
  );
  await prepareSource(configPath, changedJar);
  await rm(changedJar);

  const targetPath = join(project, "Locale/zh-CN.yml");
  const baselinePath = join(project, ".lioni/lioni.baseline.json");
  const originalTarget = await readFile(targetPath);
  const originalBaseline = await readFile(baselinePath);
  runLioni([
    "update",
    configPath,
    "--dry-run",
    "--output-format",
    "structured",
  ]);
  assert.deepEqual(await readFile(targetPath), originalTarget);
  assert.deepEqual(await readFile(baselinePath), originalBaseline);

  runLioni([
    "update",
    configPath,
    "--record-baseline",
    "--output-format",
    "structured",
  ]);

  const targetText = await readFile(targetPath, "utf8");
  const target = parseDocument(targetText).toJS() as {
    readonly messages: Record<string, unknown>;
    readonly custom: string;
  };
  assert.deepEqual(target.messages, {
    greet: "Hello again",
    leave: "再见",
    fresh: "New sentence",
  });
  assert.equal(target.custom, "保留用户字段");
  assert.match(targetText, /# 保留文件注释/u);
  assert.match(targetText, /# 保留字段注释/u);
  assert.notDeepEqual(await readFile(baselinePath), originalBaseline);
});
