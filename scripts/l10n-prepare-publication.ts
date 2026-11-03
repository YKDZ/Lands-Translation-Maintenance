import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { readLandsPublication } from "@lands-l10n/l10n/maintenance";

export interface PrepareTranslationPublicationOptions {
  readonly projectFilePath: string;
  readonly readmeTemplatePath: string;
  readonly licensePath: string;
  readonly outputDirectory: string;
}

async function requireEmptyOutput(directory: string): Promise<void> {
  try {
    if ((await readdir(directory)).length > 0) {
      throw new Error(`发布准备目录必须为空，已保留原有内容：${directory}`);
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

function renderReadme(
  template: string,
  sourceVersion: string,
  files: readonly {
    readonly sourcePath: string;
    readonly targetPath: string;
  }[],
): string {
  const substitutions = [
    ["{{LANDS_VERSION}}", sourceVersion],
    [
      "{{TRANSLATION_FILES}}",
      [
        "| 源文件 | 翻译后 |",
        "| --- | --- |",
        ...files.map(
          ({ sourcePath, targetPath }) =>
            `| ${sourcePath.replaceAll("|", "\\|")} | ${targetPath.replaceAll("|", "\\|")} |`,
        ),
      ].join("\n"),
    ],
  ] as const;
  let readme = template;
  for (const [placeholder, value] of substitutions) {
    if (template.split(placeholder).length !== 2) {
      throw new Error(`README 模板必须恰好包含一个占位符 ${placeholder}。`);
    }
    readme = readme.replace(placeholder, () => value);
  }
  if (/\{\{[\s\S]*?\}\}/u.test(readme)) {
    throw new Error("README 模板包含未处理的占位符。");
  }
  return readme;
}

/**
 * 准备待验收的发布目录，预览和正式发布复用同一份内容生成逻辑。
 * 输入读取、模板检查全部成功后才开始写出；非空目标目录不会被清理或覆盖。
 * 此函数不执行 QA，调用方须对同一来源提交完成正式验收后才能发布。
 */
export async function prepareTranslationPublication(
  options: PrepareTranslationPublicationOptions,
): Promise<{
  readonly sourceVersion: string;
  readonly files: readonly string[];
}> {
  const outputDirectory = resolve(options.outputDirectory);
  await requireEmptyOutput(outputDirectory);
  const [publication, template, license] = await Promise.all([
    readLandsPublication(options.projectFilePath),
    readFile(options.readmeTemplatePath, "utf8"),
    readFile(options.licensePath),
  ]);
  const readme = renderReadme(
    template,
    publication.sourceVersion,
    publication.files,
  );
  const files = [
    { path: "README.md", content: Buffer.from(readme, "utf8") },
    { path: "LICENSE", content: license },
    ...publication.files.map(({ targetPath, content }) => ({
      path: targetPath,
      content,
    })),
  ];
  for (const { path, content } of files) {
    const destination = join(outputDirectory, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: "wx" });
  }
  return {
    sourceVersion: publication.sourceVersion,
    files: files.map(({ path }) => path),
  };
}
