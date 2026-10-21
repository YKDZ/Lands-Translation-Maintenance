import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

interface DependencyLock {
  readonly schemaVersion: 1;
  readonly javaRelease: number;
  readonly artifacts: readonly {
    readonly group: string;
    readonly artifact: string;
    readonly version: string;
    readonly sha256: string;
  }[];
}

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const dependencyLockPath = join(
  packageDirectory,
  "minimessage-dependencies.json",
);
const javaSourcePath = join(
  packageDirectory,
  "java/minimessage/MiniMessageBridge.java",
);
const outputDirectory = join(packageDirectory, "target/minimessage");
const helperJarName = "lands-l10n-minimessage.jar";

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new Error(`无法运行 ${command}：${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout).trim();
    throw new Error(
      `${command} 失败（退出码 ${String(result.status)}）${details === "" ? "" : `：\n${details}`}`,
    );
  }
}

async function downloadDependency(
  dependency: DependencyLock["artifacts"][number],
  destination: string,
): Promise<void> {
  const groupPath = dependency.group.replaceAll(".", "/");
  const fileName = `${dependency.artifact}-${dependency.version}.jar`;
  const url = `https://repo.maven.apache.org/maven2/${groupPath}/${dependency.artifact}/${dependency.version}/${fileName}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`获取固定依赖失败：${url}（HTTP ${response.status}）`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== dependency.sha256) {
    throw new Error(
      `固定依赖摘要不匹配：${fileName} 预期 ${dependency.sha256}，实际 ${sha256}`,
    );
  }
  await writeFile(destination, bytes);
}

async function build(): Promise<void> {
  const lock = JSON.parse(
    await readFile(dependencyLockPath, "utf8"),
  ) as DependencyLock;
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "lands-l10n-minimessage-"),
  );
  const temporaryDependencies = join(temporaryDirectory, "deps");
  const classesDirectory = join(temporaryDirectory, "classes");
  const outputDependencies = join(outputDirectory, "deps");
  try {
    await rm(outputDirectory, { force: true, recursive: true });
    await mkdir(temporaryDependencies, { recursive: true });
    await mkdir(classesDirectory, { recursive: true });
    await mkdir(outputDependencies, { recursive: true });

    const jarNames: string[] = [];
    for (const dependency of lock.artifacts) {
      const fileName = `${dependency.artifact}-${dependency.version}.jar`;
      const temporaryJar = join(temporaryDependencies, fileName);
      await downloadDependency(dependency, temporaryJar);
      await copyFile(temporaryJar, join(outputDependencies, fileName));
      jarNames.push(temporaryJar);
    }

    const classpath = jarNames.join(delimiter);
    run(
      "javac",
      [
        "--release",
        String(lock.javaRelease),
        "-encoding",
        "UTF-8",
        "-cp",
        classpath,
        "-d",
        classesDirectory,
        javaSourcePath,
      ],
      temporaryDirectory,
    );
    run(
      "jar",
      [
        "--create",
        "--file",
        join(outputDirectory, helperJarName),
        "-C",
        classesDirectory,
        ".",
      ],
      temporaryDirectory,
    );
    await copyFile(
      dependencyLockPath,
      join(outputDirectory, "DEPENDENCIES.json"),
    );
    process.stdout.write(
      `已构建官方 MiniMessage ${lock.artifacts.find((artifact) => artifact.artifact === "adventure-text-minimessage")?.version ?? "未知版本"} 辅助程序。\n`,
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

await build();
