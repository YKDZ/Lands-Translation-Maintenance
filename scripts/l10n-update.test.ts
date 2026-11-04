import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { prepareLandsSource } from "@lands-l10n/l10n/maintenance";

import { updateTranslationProject } from "./l10n-update.ts";

const repository = resolve(import.meta.dirname, "..");

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "lands-update-transaction-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  const source = join(directory, "jar");
  await mkdir(join(project, ".lioni"), { recursive: true });
  await mkdir(join(project, "Locale"));
  await mkdir(join(source, "Locale"), { recursive: true });
  await symlink(
    join(repository, "node_modules"),
    join(project, "node_modules"),
    "dir",
  );
  const config = join(project, ".lioni/lioni.config.ts");
  const target = join(project, "Locale/zh-CN.yml");
  const baseline = join(project, ".lioni/lioni.baseline.json");
  const pointer = join(project, ".lioni/source/current.json");
  await writeFile(
    config,
    'import { createLandsConfig } from "@lands-l10n/l10n/lioni.config";\nexport default createLandsConfig(import.meta.url);\n',
  );
  await writeFile(
    join(project, ".lioni/project.yml"),
    `format: lands-l10n-project/v1
resources:
  - path: plugin.yml
    purpose: metadata
  - path: Locale/en-US.yml
    purpose: chat-language
translationScope:
  sourceLanguage: en-US
  targetLanguage: zh-CN
  mappings:
    - source: Locale/en-US.yml
      target: Locale/zh-CN.yml
      fields:
        - path: [messages]
          category: chat-string
`,
  );
  await writeFile(
    target,
    "# 人工注释\nmessages:\n  greet: 你好\ncustom: 保留人工字段\n",
  );
  execFileSync("git", ["init", "--quiet", source]);
  async function jar(version: string, messages: string) {
    await writeFile(
      join(source, "plugin.yml"),
      `name: Lands\nversion: ${version}\n`,
    );
    await writeFile(join(source, "Locale/en-US.yml"), messages);
    execFileSync("git", ["-C", source, "add", "."]);
    const tree = execFileSync("git", ["-C", source, "write-tree"], {
      encoding: "utf8",
    }).trim();
    const file = join(directory, `Lands-${version}.jar`);
    await writeFile(
      file,
      execFileSync("git", ["-C", source, "archive", "--format=zip", tree]),
    );
    return file;
  }
  await prepareLandsSource(
    await jar("9.1.1", "messages:\n  greet: Hello\n"),
    pathToFileURL(config),
  );
  execFileSync("pnpm", ["exec", "lioni", "baseline", config], {
    cwd: repository,
    stdio: "pipe",
  });
  return { directory, project, config, target, baseline, pointer, jar };
}

void test("更新作为一次操作推进来源、译文和基线，保留人工编辑且可重复执行", async (t) => {
  const p = await fixture(t);
  const jar = await p.jar(
    "9.1.2",
    "messages:\n  greet: Hello\n  added: New message\n",
  );
  const result = await updateTranslationProject(jar, p.config);
  assert.equal(result.sourceVersion, "9.1.2");
  const target = await readFile(p.target, "utf8");
  assert.match(target, /greet: 你好/u);
  assert.match(target, /added: New message/u);
  assert.match(target, /custom: 保留人工字段/u);
  assert.match(target, /# 人工注释/u);
  const baseline = await readFile(p.baseline);
  const pointer = await readFile(p.pointer);
  await updateTranslationProject(jar, p.config);
  assert.equal(await readFile(p.target, "utf8"), target);
  assert.deepEqual(await readFile(p.baseline), baseline);
  assert.deepEqual(await readFile(p.pointer), pointer);
  assert.deepEqual(
    (await readdir(p.directory)).filter((name) =>
      name.startsWith(".lioni-update-"),
    ),
    [],
  );
});

void test("来源无效或写回中途失败时，原快照指针、译文和基线全部保留", async (t) => {
  const p = await fixture(t);
  const target = await readFile(p.target);
  const baseline = await readFile(p.baseline);
  const pointer = await readFile(p.pointer);
  const invalid = join(p.directory, "invalid.jar");
  await writeFile(invalid, "无效来源");
  await assert.rejects(updateTranslationProject(invalid, p.config));
  await writeFile(
    p.config,
    `import { createLandsConfig } from "@lands-l10n/l10n/lioni.config";
const config = createLandsConfig(import.meta.url);
const adapter = config.translationWriteback;
const writeBatch = adapter.writeBatch;
export default { ...config, translationWriteback: { ...adapter,
  writeBatch: async (input: Parameters<typeof writeBatch>[0]) => {
    await writeBatch(input);
    throw new Error("模拟写回中断");
  }
}};
`,
  );
  const jar = await p.jar(
    "9.1.2",
    "messages:\n  greet: Hello\n  added: New message\n",
  );
  await assert.rejects(updateTranslationProject(jar, p.config), /同步未完整/u);
  assert.deepEqual(await readFile(p.target), target);
  assert.deepEqual(await readFile(p.baseline), baseline);
  assert.deepEqual(await readFile(p.pointer), pointer);
  assert.deepEqual(
    (await readdir(p.directory)).filter((name) =>
      name.startsWith(".lioni-update-"),
    ),
    [],
  );
});
