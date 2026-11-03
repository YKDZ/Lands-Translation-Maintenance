import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { prepareTranslationPublication } from "./l10n-prepare-publication.ts";
import { publishTranslation } from "./l10n-publication.ts";

// 正式门槛由唯一发布工作流先执行；只有通过后，后续步骤才能取得 App 凭据。
// 此脚本是工作流内部步骤，不提供可绕过工作流验收的本地发布入口。
async function publish(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new Error("发布内部步骤不接受参数，请从维护仓库的发布工作流运行。");
  }
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_WORKFLOW_REF !==
      "YKDZ/Lands-Translation-Maintenance/.github/workflows/publish.yml@refs/heads/main"
  ) {
    throw new Error("正式发布只接受维护仓库 main 上的手动发布工作流。");
  }
  const git = (...args: string[]): string =>
    execFileSync("git", args, { encoding: "utf8" }).trim();
  const sourceCommit = git("rev-parse", "HEAD");
  if (sourceCommit !== process.env.GITHUB_SHA) {
    throw new Error("检出的维护提交与本次工作流提交不同，已停止发布。");
  }
  if (git("status", "--porcelain") !== "") {
    throw new Error("验收后的维护工作区存在改动，已停止发布。");
  }
  const token = process.env.GH_TOKEN;
  if (token === undefined || token === "") {
    throw new Error("发布工作流尚未配置 GitHub App 凭据。");
  }
  const directory = await mkdtemp(join(tmpdir(), "lands-publication-stage-"));
  try {
    const publicationDirectory = join(directory, "files");
    const { sourceVersion } = await prepareTranslationPublication({
      projectFilePath: resolve("translations/zhcn/.lioni/project.yml"),
      readmeTemplatePath: resolve("publication/README.template.md"),
      licensePath: resolve("LICENSE"),
      outputDirectory: publicationDirectory,
    });
    const result = await publishTranslation({
      publicationDirectory,
      maintenanceDirectory: process.cwd(),
      sourceCommit,
      sourceVersion,
      token,
    }).catch((error: unknown) => {
      throw new Error(
        "翻译发布未完成；已推送的提交、标签或草稿会保留，修复后可重试补齐。\n" +
          (error instanceof Error ? error.message : String(error)),
      );
    });
    process.stdout.write(
      `翻译发布已完成：${result.tag}\n${result.releaseUrl}\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  await publish();
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : String(error)) + "\n",
  );
  process.exitCode = 1;
}
