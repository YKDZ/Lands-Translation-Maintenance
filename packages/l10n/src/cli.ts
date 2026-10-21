#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { executeCli, parseCliInvocation } from "@ykdz/cli-contract";
import { nodeCliOutput } from "@ykdz/cli-contract/node";

import { cli } from "#/cli-contract";

export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    const invocation = parseCliInvocation(cli, argv);
    const termination = await executeCli(cli, {
      invocation,
      dependencies: { manifest: cli.manifest },
      write: nodeCliOutput({ stdout: process.stdout, stderr: process.stderr }),
    });
    return termination.exitCode;
  } catch (error) {
    process.stderr.write(
      `命令执行失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

const mainFile = process.argv[1];
if (
  mainFile !== undefined &&
  existsSync(mainFile) &&
  pathToFileURL(realpathSync(mainFile)).href === import.meta.url
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
