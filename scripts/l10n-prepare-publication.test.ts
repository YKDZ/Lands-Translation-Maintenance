import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { prepareLandsSource } from "@lands-l10n/l10n/maintenance";

import { prepareTranslationPublication } from "./l10n-prepare-publication.ts";

async function createPublicationInputs(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "lands-publication-input-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const projectDirectory = join(directory, "translations/zhcn");
  const sourceDirectory = join(directory, "source");
  const projectFilePath = join(projectDirectory, ".lioni/project.yml");
  const readmeTemplatePath = join(directory, "README.template.md");
  const licensePath = join(directory, "LICENSE");
  const outputDirectory = join(directory, "prepared");
  await mkdir(join(projectDirectory, ".lioni"), { recursive: true });
  await mkdir(join(projectDirectory, "Locale/Nations"), { recursive: true });
  await mkdir(join(sourceDirectory, "Locale/Nations"), { recursive: true });
  await writeFile(
    projectFilePath,
    [
      "format: lands-l10n-project/v1",
      "resources:",
      "  - path: plugin.yml",
      "    purpose: metadata",
      "  - path: Locale/en-US.yml",
      "    purpose: chat-language",
      "  - path: Locale/Nations/en-US.yml",
      "    purpose: chat-language",
      "translationScope:",
      "  sourceLanguage: en-US",
      "  targetLanguage: zh-CN",
      "  mappings:",
      "    - source: Locale/en-US.yml",
      "      target: Locale/zh-CN.yml",
      "      fields:",
      "        - path: [messages]",
      "          category: chat-string",
      "    - source: Locale/Nations/en-US.yml",
      "      target: Locale/Nations/zh-CN.yml",
      "      fields:",
      "        - path: [messages]",
      "          category: chat-string",
      "",
    ].join("\n"),
  );
  const translatedFiles = new Map([
    [
      "Locale/zh-CN.yml",
      Buffer.from('\uFEFF# 保留注释\r\nmessages:\r\n  greeting: "你好"\r\n'),
    ],
    ["Locale/Nations/zh-CN.yml", Buffer.from("messages:\n  greeting: 欢迎\n")],
  ]);
  for (const [path, content] of translatedFiles) {
    await writeFile(join(projectDirectory, path), content);
  }
  await writeFile(join(projectDirectory, "levels.yml"), "name: 退出维护\n");
  await writeFile(
    join(projectDirectory, ".lioni/private.yml"),
    "note: 只用于维护\n",
  );
  await writeFile(
    join(sourceDirectory, "plugin.yml"),
    "name: Lands\nversion: 9.1.1\n",
  );
  await writeFile(
    join(sourceDirectory, "Locale/en-US.yml"),
    "messages:\n  greeting: Hello\n",
  );
  await writeFile(
    join(sourceDirectory, "Locale/Nations/en-US.yml"),
    "messages:\n  greeting: Welcome\n",
  );
  execFileSync("git", ["init", "--initial-branch=main", sourceDirectory], {
    stdio: "pipe",
  });
  execFileSync("git", ["-C", sourceDirectory, "add", "."]);
  execFileSync(
    "git",
    [
      "-C",
      sourceDirectory,
      "-c",
      "user.name=发布准备测试",
      "-c",
      "user.email=publication@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "建立测试来源",
    ],
    { stdio: "pipe" },
  );
  const jarFile = join(directory, "Lands.jar");
  execFileSync("git", [
    "-C",
    sourceDirectory,
    "archive",
    "--format=zip",
    "--output",
    jarFile,
    "HEAD",
  ]);
  await prepareLandsSource(
    jarFile,
    pathToFileURL(join(projectDirectory, ".lioni/lioni.config.ts")),
  );
  await rm(jarFile);
  await rm(sourceDirectory, { recursive: true });
  await writeFile(
    readmeTemplatePath,
    "# 使用说明\n\n当前版本：{{LANDS_VERSION}}\n\n{{TRANSLATION_FILES}}\n\n说明正文保持原样。\n",
  );
  const license = Buffer.from("许可证正文\r\n保留原始字节\r\n");
  await writeFile(licensePath, license);
  return {
    projectFilePath,
    readmeTemplatePath,
    licensePath,
    outputDirectory,
    projectDirectory,
    translatedFiles,
    license,
  };
}

void test("发布准备从正式来源生成版本与映射，并只输出同一份受管译文和许可证字节", async (context) => {
  const inputs = await createPublicationInputs(context);

  const prepared = await prepareTranslationPublication(inputs);

  assert.equal(prepared.sourceVersion, "9.1.1");
  assert.deepEqual(prepared.files, [
    "README.md",
    "LICENSE",
    "Locale/zh-CN.yml",
    "Locale/Nations/zh-CN.yml",
  ]);
  const actualPaths = await readdir(inputs.outputDirectory, {
    recursive: true,
    withFileTypes: true,
  });
  assert.equal(actualPaths.filter((entry) => entry.isFile()).length, 4);
  for (const [path, content] of inputs.translatedFiles) {
    assert.deepEqual(
      await readFile(join(inputs.outputDirectory, path)),
      content,
    );
  }
  assert.deepEqual(
    await readFile(join(inputs.outputDirectory, "LICENSE")),
    inputs.license,
  );
  assert.equal(
    await readFile(join(inputs.outputDirectory, "README.md"), "utf8"),
    [
      "# 使用说明",
      "",
      "当前版本：9.1.1",
      "",
      "| 源文件 | 翻译后 |",
      "| --- | --- |",
      "| Locale/en-US.yml | Locale/zh-CN.yml |",
      "| Locale/Nations/en-US.yml | Locale/Nations/zh-CN.yml |",
      "",
      "说明正文保持原样。",
      "",
    ].join("\n"),
  );
});

void test("模板占位缺失、重复或未处理时在写出任何内容前拒绝", async (context) => {
  const inputs = await createPublicationInputs(context);
  await mkdir(inputs.outputDirectory);
  for (const template of [
    "{{TRANSLATION_FILES}}",
    "{{LANDS_VERSION}}",
    "{{LANDS_VERSION}} {{LANDS_VERSION}} {{TRANSLATION_FILES}}",
    "{{LANDS_VERSION}} {{TRANSLATION_FILES}} {{TRANSLATION_FILES}}",
    "{{LANDS_VERSION}} {{TRANSLATION_FILES}} {{UNKNOWN}}",
  ]) {
    await writeFile(inputs.readmeTemplatePath, template);
    await assert.rejects(prepareTranslationPublication(inputs), /占位符/u);
    assert.deepEqual(await readdir(inputs.outputDirectory), []);
  }
});

void test("发布准备拒绝非空输出目录，保持使用者原有文件不变", async (context) => {
  const inputs = await createPublicationInputs(context);
  await mkdir(inputs.outputDirectory);
  const original = "messages:\n  greeting: 使用者自己的内容\n";
  await writeFile(join(inputs.outputDirectory, "existing.yml"), original);

  await assert.rejects(
    prepareTranslationPublication(inputs),
    /准备目录必须为空/u,
  );

  assert.deepEqual(await readdir(inputs.outputDirectory), ["existing.yml"]);
  assert.equal(
    await readFile(join(inputs.outputDirectory, "existing.yml"), "utf8"),
    original,
  );
});

void test("受管译文读取失败时不留下只含说明或部分译文的输出", async (context) => {
  const inputs = await createPublicationInputs(context);
  await mkdir(inputs.outputDirectory);
  await rm(join(inputs.projectDirectory, "Locale/Nations/zh-CN.yml"));

  await assert.rejects(prepareTranslationPublication(inputs), {
    code: "ENOENT",
  });

  assert.deepEqual(await readdir(inputs.outputDirectory), []);
});
