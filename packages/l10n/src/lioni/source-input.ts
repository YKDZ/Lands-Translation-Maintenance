import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { readJarResources } from "#/jar";
import type { JsonValue } from "#/json-value";
import { landsProjectPaths } from "#/lioni/project-paths";
import { sha256 } from "#/value";
import { parseYaml } from "#/yaml-data";

const sourcePointerSchema = z.object({
  format: z.literal("lands-source-pointer/v1"),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const sourceManifestSchema = z.object({
  format: z.literal("lands-source/v1"),
  sourceVersion: z.string().min(1),
  jarSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  resources: z.array(
    z.object({
      path: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
  ),
});

export type LandsSourceManifest = z.infer<typeof sourceManifestSchema>;

export interface LandsSourceSnapshot {
  readonly manifest: LandsSourceManifest;
  readonly resources: ReadonlyMap<string, Uint8Array>;
}

function safeResourcePath(path: string): boolean {
  return (
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function isRecord(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotDirectory(sourceDirectory: string, digest: string): string {
  return join(sourceDirectory, "snapshots", digest);
}

/** 保存指定 JAR 的离线资源快照，并以版本指针发布完整快照。 */
export async function prepareLandsSource(
  jarFile: string,
  entryUrl: string | URL,
): Promise<{ readonly sourceVersion: string; readonly jarSha256: string }> {
  const jarBytes = await readFile(jarFile);
  const { resources, duplicatePaths } = await readJarResources(jarBytes);
  if (duplicatePaths.length > 0) {
    throw new Error(`JAR 含有重复资源路径：${duplicatePaths.join("、")}`);
  }
  const unsafePath = resources.find(({ path }) => !safeResourcePath(path));
  if (unsafePath !== undefined) {
    throw new Error(`JAR 含有不安全的资源路径：${unsafePath.path}`);
  }

  const pluginFile = resources.find(({ path }) => path === "plugin.yml");
  if (pluginFile === undefined) {
    throw new Error("JAR 缺少 plugin.yml，无法确认 Lands 来源版本。");
  }
  const pluginYaml = parseYaml(
    new TextDecoder("utf-8", { fatal: true }).decode(pluginFile.bytes),
    "plugin.yml",
  );
  if (!pluginYaml.ok) {
    throw new Error("JAR 的 plugin.yml 无法读取。");
  }
  if (!isRecord(pluginYaml.parsed.value)) {
    throw new Error("JAR 的 plugin.yml 根节点必须是映射。");
  }
  const sourceVersion = pluginYaml.parsed.value.version;
  if (typeof sourceVersion !== "string" || sourceVersion === "") {
    throw new Error("JAR 的 plugin.yml 缺少字符串 version 字段。");
  }

  const jarSha256 = sha256(jarBytes);
  const manifest: LandsSourceManifest = {
    format: "lands-source/v1",
    sourceVersion,
    jarSha256,
    resources: resources.map(({ path, bytes }) => ({
      path,
      sha256: sha256(bytes),
    })),
  };
  const paths = landsProjectPaths(entryUrl);
  const directory = snapshotDirectory(paths.sourceDirectory, jarSha256);
  const resourcesDirectory = join(directory, "resources");

  for (const resource of resources) {
    const destination = join(resourcesDirectory, resource.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, resource.bytes);
  }

  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await mkdir(paths.sourceDirectory, { recursive: true });
  const pointerFile = join(paths.sourceDirectory, `current.${process.pid}.tmp`);
  const currentFile = join(paths.sourceDirectory, "current.json");
  try {
    await writeFile(
      pointerFile,
      `${JSON.stringify(
        { format: "lands-source-pointer/v1", snapshotSha256: jarSha256 },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await rename(pointerFile, currentFile);
  } finally {
    await rm(pointerFile, { force: true });
  }

  return { sourceVersion: manifest.sourceVersion, jarSha256 };
}

/** 无需 JAR 即可读取并校验当前来源快照。 */
export async function readLandsSourceSnapshot(
  sourceDirectory: string,
): Promise<LandsSourceSnapshot> {
  const pointerInput: unknown = JSON.parse(
    await readFile(join(sourceDirectory, "current.json"), "utf8"),
  );
  const pointer = sourcePointerSchema.parse(pointerInput);
  const directory = snapshotDirectory(sourceDirectory, pointer.snapshotSha256);
  const manifestInput: unknown = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  const manifest = sourceManifestSchema.parse(manifestInput);
  if (manifest.jarSha256 !== pointer.snapshotSha256) {
    throw new Error("来源清单与当前来源指针不一致。");
  }

  const resources = new Map<string, Uint8Array>();
  for (const resource of manifest.resources) {
    if (!safeResourcePath(resource.path)) {
      throw new Error(`来源清单含有不安全的资源路径：${resource.path}`);
    }
    if (resources.has(resource.path)) {
      throw new Error(`来源清单含有重复资源路径：${resource.path}`);
    }
    const bytes = await readFile(join(directory, "resources", resource.path));
    if (sha256(bytes) !== resource.sha256) {
      throw new Error(`离线来源资源摘要不匹配：${resource.path}`);
    }
    resources.set(resource.path, bytes);
  }

  return { manifest, resources };
}
