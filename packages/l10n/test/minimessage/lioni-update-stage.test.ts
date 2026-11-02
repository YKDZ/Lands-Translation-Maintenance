import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { runLandsUpdateStage } from "../../src/lioni/update-stage.ts";
import {
  landsJar,
  prepareBaselineUpdate,
  prepareSource,
} from "../lioni-update-fixtures.ts";

void test("同步阶段用完整 QA 接受数据报告并保留重复同步与人工编辑", async (t) => {
  const project = await prepareBaselineUpdate(t);
  await mkdir(join(project.projectDirectory, ".lioni/terms"), {
    recursive: true,
  });
  await Promise.all(
    ["concepts", "en-US", "zh-CN"].map((name) =>
      writeFile(
        join(project.projectDirectory, `.lioni/terms/${name}.yaml`),
        "concepts: {}\n",
      ),
    ),
  );
  const initialJar = join(project.projectDirectory, "Lands-initial.jar");
  await writeFile(
    initialJar,
    landsJar(
      "messages:\n  greet: Hello\n  leave: Goodbye\n  legacy: Parting\n",
    ),
  );
  await prepareSource(project.configPath, initialJar, "8.9.2");
  await rm(initialJar);
  await writeFile(
    project.targetPath,
    (await readFile(project.targetPath, "utf8")).replace(
      "greet: 你好 # 保留字段注释",
      'greet: "<red>人工翻译</red>" # 保留字段注释',
    ),
  );

  const first = await runLandsUpdateStage(project.configPath);
  assert.equal(first.status, "completed");
  assert.equal(first.qualityDecision.executionStatus, "complete");
  assert.equal(first.qualityDecision.passed, false);
  assert.ok(first.qualityDecision.activeErrorCount > 0);
  assert.match(first.qualityReport, /质量结论/u);

  const translatedTarget = await readFile(project.targetPath, "utf8");
  const recordedBaseline = await readFile(project.baselinePath);
  const repeated = await runLandsUpdateStage(project.configPath);
  assert.equal(repeated.status, "completed");
  assert.equal(await readFile(project.targetPath, "utf8"), translatedTarget);
  assert.deepEqual(await readFile(project.baselinePath), recordedBaseline);

  await writeFile(
    project.targetPath,
    translatedTarget.replace(
      'greet: "<red>人工翻译</red>"',
      "greet: 人工二次校订",
    ),
  );
  const editedTarget = await readFile(project.targetPath, "utf8");
  const edited = await runLandsUpdateStage(project.configPath);
  assert.equal(edited.status, "completed");
  assert.equal(await readFile(project.targetPath, "utf8"), editedTarget);
});
