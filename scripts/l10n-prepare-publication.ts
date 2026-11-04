import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  readLandsPublication,
  readLandsPublicationTerms,
} from "@lands-l10n/l10n/maintenance";

export interface PrepareTranslationPublicationOptions {
  readonly projectFilePath: string;
  readonly readmeTemplatePath: string;
  readonly licensePath: string;
  readonly outputDirectory: string;
}

async function requireEmptyOutput(directory: string): Promise<void> {
  try {
    if ((await readdir(directory)).length > 0) {
      throw new Error(`导出目录必须为空，已保留原有内容：${directory}`);
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
  termTable?: string,
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
    ...(termTable === undefined
      ? []
      : [["{{TERMINOLOGY}}", termTable] as const]),
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
 * 导出待验收的发布目录，本地与正式发布复用同一份内容生成逻辑。
 * 先在同级临时目录完整写出，再原子替换空输出目录；失败时保留原目录。
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
    template.includes("{{TERMINOLOGY}}")
      ? [
          "| 术语 | 翻译 | 备注 |",
          "| --- | --- | --- |",
          ...(await readLandsPublicationTerms(options.projectFilePath)).map(
            (entry) => {
              const cell = (text: string) =>
                text
                  .replaceAll("&", "&amp;")
                  .replaceAll("<", "&lt;")
                  .replaceAll(">", "&gt;")
                  .replaceAll("|", "&#124;")
                  .replace(/\r?\n/gu, "<br>");
              return `| ${cell(entry.source.join(", "))} | ${cell(entry.target.join(", "))} | ${cell(entry.note)} |`;
            },
          ),
        ].join("\n")
      : undefined,
  );
  const files = [
    { path: "README.md", content: Buffer.from(readme, "utf8") },
    { path: "LICENSE", content: license },
    ...publication.files.map(({ targetPath, content }) => ({
      path: targetPath,
      content,
    })),
  ];
  await mkdir(dirname(outputDirectory), { recursive: true });
  const temporaryDirectory = await mkdtemp(
    join(dirname(outputDirectory), ".lioni-export-"),
  );
  try {
    for (const { path, content } of files) {
      const destination = join(temporaryDirectory, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, { flag: "wx" });
    }
    await rename(temporaryDirectory, outputDirectory);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return {
    sourceVersion: publication.sourceVersion,
    files: files.map(({ path }) => path),
  };
}
