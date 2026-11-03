import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { readLandsPublication } from "@lands-l10n/l10n/maintenance";
import { parseDocument } from "yaml";

import { createProject, prepareLioniProject } from "./lioni-fixtures.ts";

void test("发布资料复用来源版本和维护清单，并保留译文原始字节与目录关系", async (t) => {
  const project = await createProject(t);
  await prepareLioniProject(project);
  await rm(project.jarFile);
  const projectFile = join(project.directory, ".lioni/project.yml");
  const declaration = parseDocument(await readFile(projectFile, "utf8"));
  declaration.setIn(
    ["translationScope", "mappings", 0, "target"],
    "Locale/Nations/zh-CN.yaml",
  );
  await writeFile(projectFile, declaration.toString());
  await mkdir(join(project.directory, "Locale/Nations"), { recursive: true });
  const content = Buffer.from(
    '\uFEFF# 保留注释与换行\r\nmessages:\r\n  greeting: "你好" # 译注\r\n',
    "utf8",
  );
  await writeFile(
    join(project.directory, "Locale/Nations/zh-CN.yaml"),
    content,
  );
  await writeFile(join(project.directory, "levels.yml"), "name: 旧译文\n");

  const publication = await readLandsPublication(projectFile);

  assert.equal(publication.sourceVersion, "8.0.1");
  assert.deepEqual(publication.files, [
    {
      sourcePath: "lang/en.yml",
      targetPath: "Locale/Nations/zh-CN.yaml",
      content,
    },
  ]);
  assert.deepEqual(
    await readFile(join(project.directory, "Locale/Nations/zh-CN.yaml")),
    content,
  );
});

void test("受管译文缺失时拒绝生成不完整的发布资料", async (t) => {
  const project = await createProject(t);
  await prepareLioniProject(project);
  await rm(join(project.directory, "lang/zh.yml"));

  await assert.rejects(
    readLandsPublication(join(project.directory, ".lioni/project.yml")),
    { code: "ENOENT" },
  );
});

void test("发布读取校验离线来源摘要，不信任损坏快照中的版本信息", async (t) => {
  const project = await createProject(t);
  await prepareLioniProject(project);
  const sourceDirectory = join(project.directory, ".lioni/source");
  const pointer = JSON.parse(
    await readFile(join(sourceDirectory, "current.json"), "utf8"),
  ) as { readonly snapshotSha256: string };
  await writeFile(
    join(
      sourceDirectory,
      "snapshots",
      pointer.snapshotSha256,
      "resources/lang/en.yml",
    ),
    "messages:\n  greeting: 已损坏的原文\n",
  );

  await assert.rejects(
    readLandsPublication(join(project.directory, ".lioni/project.yml")),
    /离线来源资源摘要不匹配：lang\/en.yml/u,
  );
});

void test("发布读取拒绝非法输出路径、非译文目标及重复维护目标", async (t) => {
  const project = await createProject(t);
  await prepareLioniProject(project);
  const projectFile = join(project.directory, ".lioni/project.yml");
  const original = await readFile(projectFile, "utf8");

  for (const [target, expected] of [
    ["../outside.yml", /必须是项目内的规范相对路径/u],
    [".lioni/project.yml", /不能覆盖维护清单或工具内部状态/u],
    [".github/workflows/publish.yml", /非隐藏目录中的 YAML 文件/u],
    ["README.md", /非隐藏目录中的 YAML 文件/u],
  ] as const) {
    const declaration = parseDocument(original);
    declaration.setIn(["translationScope", "mappings", 0, "target"], target);
    await writeFile(projectFile, declaration.toString());
    await assert.rejects(readLandsPublication(projectFile), expected);
  }

  const duplicate = parseDocument(original);
  duplicate.addIn(
    ["translationScope", "mappings"],
    duplicate.getIn(["translationScope", "mappings", 0]),
  );
  await writeFile(projectFile, duplicate.toString());
  await assert.rejects(
    readLandsPublication(projectFile),
    /目标文件只能由一条映射维护/u,
  );

  const empty = parseDocument(original);
  empty.setIn(["translationScope", "mappings"], []);
  await writeFile(projectFile, empty.toString());
  await assert.rejects(readLandsPublication(projectFile), /没有可发布的文件/u);
});

void test("维护清单声明的原文必须属于当前实际来源快照", async (t) => {
  const project = await createProject(t);
  await prepareLioniProject(project);
  const projectFile = join(project.directory, ".lioni/project.yml");
  const declaration = parseDocument(await readFile(projectFile, "utf8"));
  declaration.setIn(["resources", 0, "path"], "lang/missing.yml");
  declaration.setIn(
    ["translationScope", "mappings", 0, "source"],
    "lang/missing.yml",
  );
  await writeFile(projectFile, declaration.toString());

  await assert.rejects(
    readLandsPublication(projectFile),
    /来源快照缺少受管原文：lang\/missing.yml/u,
  );
});
