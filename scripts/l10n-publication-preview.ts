import { resolve } from "node:path";

import { prepareTranslationPublication } from "./l10n-prepare-publication.ts";

try {
  const [output, ...extra] = process.argv.slice(2);
  if (output === undefined || output === "" || extra.length !== 0) {
    throw new Error("请指定一个空输出目录：pnpm l10n:preview <目录>");
  }
  const result = await prepareTranslationPublication({
    projectFilePath: resolve("translations/zhcn/.lioni/project.yml"),
    readmeTemplatePath: resolve("publication/README.template.md"),
    licensePath: resolve("LICENSE"),
    outputDirectory: resolve(output),
  });
  process.stdout.write(
    `已准备 Lands ${result.sourceVersion} 的发布预览：${resolve(output)}\n` +
      result.files.map((file) => `- ${file}`).join("\n") +
      "\n此命令仅准备文件，未执行完整验收，也未对外发布。\n",
  );
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : String(error)) + "\n",
  );
  process.exitCode = 1;
}
