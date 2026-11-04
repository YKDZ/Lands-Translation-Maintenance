import { resolve } from "node:path";

import { prepareTranslationPublication } from "./l10n-prepare-publication.ts";

try {
  const [output, ...extra] = process.argv.slice(2);
  if (output === undefined || output === "" || extra.length !== 0) {
    throw new Error("请指定一个空输出目录：pnpm l10n:export <目录>");
  }
  const result = await prepareTranslationPublication({
    projectFilePath: resolve("translations/zhcn/.lioni/project.yml"),
    readmeTemplatePath: resolve("publication/README.template.md"),
    licensePath: resolve("LICENSE"),
    outputDirectory: resolve(output),
  });
  // 目录只含发布文件；版本和文件清单通过标准输出交给调用方组合。
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : String(error)) + "\n",
  );
  process.exitCode = 1;
}
