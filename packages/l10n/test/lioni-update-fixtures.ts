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
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { strToU8, zipSync } from "fflate";

export const packageDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const nativeCli = join(packageDirectory, "node_modules/.bin/lioni");
const sourcePreparer = join(
  packageDirectory,
  "scripts/prepare-lioni-source.ts",
);

export function runLioni(args: readonly string[]): string {
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

export async function prepareSource(
  configPath: string,
  jarPath: string,
  expectedVersion = "8.9.2",
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
  assert.equal(manifest.sourceVersion, expectedVersion);
}

export async function createProject(directory: string): Promise<void> {
  await mkdir(join(directory, ".lioni"), { recursive: true });
  await mkdir(join(directory, "Locale"), { recursive: true });
  await writeFile(
    join(directory, ".lioni/project.yml"),
    [
      "format: lands-l10n-project/v1",
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
      "  legacy: 旧译文",
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

export function landsJar(messages: string, version = "8.9.2"): Uint8Array {
  return zipSync({
    "plugin.yml": strToU8(`name: Lands\nversion: ${version}\n`),
    "Locale/en-US.yml": strToU8(messages),
  });
}

export async function prepareBaselineUpdate(t: TestContext): Promise<{
  readonly configPath: string;
  readonly baselinePath: string;
  readonly projectDirectory: string;
  readonly targetPath: string;
}> {
  const project = await mkdtemp(join(tmpdir(), "lioni-update-failure-"));
  t.after(async () => rm(project, { force: true, recursive: true }));
  await createProject(project);

  const configPath = join(project, ".lioni/lioni.config.ts");
  const initialJar = join(project, "Lands-initial.jar");
  await writeFile(
    initialJar,
    landsJar(
      "messages:\n  greet: Hello\n  leave: Goodbye\n  legacy: Parting\n",
    ),
  );
  await prepareSource(configPath, initialJar);
  await rm(initialJar);
  runLioni(["baseline", configPath, "--output-format", "structured"]);

  const changedJar = join(project, "Lands-changed.jar");
  await writeFile(
    changedJar,
    landsJar(
      "messages:\n  greet: Hello again\n  leave: Goodbye again\n  legacy: Parting\n",
      "8.9.3",
    ),
  );
  await prepareSource(configPath, changedJar, "8.9.3");
  await rm(changedJar);
  return {
    configPath,
    baselinePath: join(project, ".lioni/lioni.baseline.json"),
    projectDirectory: project,
    targetPath: join(project, "Locale/zh-CN.yml"),
  };
}
