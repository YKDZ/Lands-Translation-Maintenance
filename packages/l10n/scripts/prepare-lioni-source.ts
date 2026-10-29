import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { prepareLandsSource } from "#/lioni/source-input";

const scriptArguments = process.argv.slice(2);
const argumentsResult = parseArgs({
  args:
    scriptArguments[0] === "--" ? scriptArguments.slice(1) : scriptArguments,
  options: {
    config: { type: "string" },
    help: { type: "boolean", short: "h" },
    jar: { type: "string" },
  },
  strict: true,
});

if (argumentsResult.values.help) {
  process.stdout.write(
    "用法：pnpm --filter @lands-l10n/l10n source:prepare -- --jar <Lands.jar> --config <lioni.config.ts>\n",
  );
} else {
  const { config, jar } = argumentsResult.values;
  if (config === undefined || jar === undefined) {
    process.stderr.write("必须同时提供 --jar 和 --config。\n");
    process.exitCode = 2;
  } else {
    try {
      const result = await prepareLandsSource(
        resolve(jar),
        pathToFileURL(resolve(config)),
      );
      process.stdout.write(
        `已保存 Lands ${result.sourceVersion} 的离线资源（${result.jarSha256}）。\n`,
      );
    } catch (error) {
      process.stderr.write(
        `保存 Lands 离线来源失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
