import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  TranslationUnitInput,
  TranslationWriteRequest,
  TranslationWritebackAdapter,
} from "@lioni/lioni";
import { isMap, type Document } from "yaml";
import { z } from "zod";

import type { JsonValue } from "#/json-value";
import { parseLandsProjectConfiguration } from "#/lioni/project-configuration";
import type { LandsProjectPaths } from "#/lioni/project-paths";
import { readLandsSourceSnapshot } from "#/lioni/source-input";
import { isYamlDocumentRootMap, parseYaml, setDocumentPath } from "#/yaml-data";

interface LandsTarget {
  readonly targetFile: string;
  readonly path: readonly string[];
}

interface LandsUnitContext {
  readonly targetFile: string;
  readonly path: readonly string[];
}

interface LandsWritebackUnit extends TranslationUnitInput {
  readonly context: LandsUnitContext;
}

const targetLocatorSchema = z
  .object({
    file: z.string().min(1),
    path: z.array(z.string().min(1)).min(1),
  })
  .strict();

function isSafeProjectFile(file: string): boolean {
  return (
    !file.startsWith("/") &&
    !file.includes("\\") &&
    file
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function locate(target: LandsTarget) {
  if (!isSafeProjectFile(target.targetFile)) {
    return {
      status: "notWritable" as const,
      reason: `目标路径不是项目内的规范相对路径：${target.targetFile}`,
    };
  }
  return {
    status: "located" as const,
    locator: { file: target.targetFile, path: target.path },
  };
}

function missingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function readTargetDocument(file: string) {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (missingFile(error)) source = "{}\n";
    else throw error;
  }

  const parsed = parseYaml(source, file);
  if (!parsed.ok) {
    throw new Error(
      `${file} 不是可写 YAML：${parsed.issues.map(({ reason }) => reason).join("；")}`,
    );
  }
  if (!isYamlDocumentRootMap(parsed.parsed.document)) {
    throw new Error(`${file} 的 YAML 根节点必须是映射。`);
  }
  return parsed.parsed.document;
}

async function currentSourceDocuments(
  paths: LandsProjectPaths,
  targetFiles: readonly string[],
): Promise<ReadonlyMap<string, Document>> {
  const documents = new Map<string, Document>();
  if (targetFiles.length === 0) return documents;

  try {
    const [configurationText, snapshot] = await Promise.all([
      readFile(paths.projectConfigurationFile, "utf8"),
      readLandsSourceSnapshot(paths.sourceDirectory),
    ]);
    const configuration = parseLandsProjectConfiguration(
      configurationText,
      paths.projectConfigurationFile,
    );
    for (const targetFile of targetFiles) {
      const mappings = configuration.translationScope.mappings.filter(
        (mapping) => mapping.target === targetFile,
      );
      if (mappings.length !== 1) continue;
      const sourceFile = mappings[0]!.source;
      const sourceBytes = snapshot.resources.get(sourceFile);
      if (sourceBytes === undefined) continue;
      const source = new TextDecoder("utf-8", { fatal: true }).decode(
        sourceBytes,
      );
      const parsed = parseYaml(source, sourceFile);
      if (parsed.ok && isYamlDocumentRootMap(parsed.parsed.document)) {
        documents.set(targetFile, parsed.parsed.document);
      }
    }
  } catch {
    // 来源事实不可用时保留原写回语义；不凭猜测删除空映射。
  }
  return documents;
}

function pruneDeletedEmptyMapAncestors(
  document: Document,
  sourceDocument: Document,
  deletedPaths: readonly (readonly string[])[],
): void {
  const ancestors = new Map<string, readonly string[]>();
  for (const path of deletedPaths) {
    for (let depth = path.length - 1; depth > 0; depth -= 1) {
      const ancestor = path.slice(0, depth);
      ancestors.set(JSON.stringify(ancestor), ancestor);
    }
  }

  const paths = [...ancestors.values()].sort(
    (left, right) => right.length - left.length,
  );
  for (const path of paths) {
    const targetNode = document.getIn(path);
    if (!isMap(targetNode) || targetNode.items.length > 0) continue;
    if (isMap(sourceDocument.getIn(path))) continue;
    document.deleteIn(path);
  }
}

/** 同一批请求按目标文件合并 YAML Document，再交由框架逐字段真实回读。 */
export function createLandsWritebackAdapter<
  TUnit extends LandsWritebackUnit,
  TTranslation extends LandsTarget,
  TBody extends JsonValue,
  TUnavailable extends LandsTarget,
>(
  paths: LandsProjectPaths,
): TranslationWritebackAdapter<TUnit, TTranslation, TBody, TUnavailable> {
  const adapter: TranslationWritebackAdapter<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  > = {
    locateExistingTarget: ({ identity, translation }) => {
      if (
        identity.namespace !== translation.translation.targetFile ||
        identity.key !== JSON.stringify(translation.translation.path)
      ) {
        return {
          status: "notWritable",
          reason: "当前译文身份与 Lands 字段路径不一致。",
        };
      }
      return locate(translation.translation);
    },
    locateNewTarget: ({ sourceUnit }) => locate(sourceUnit.unit.context),
    writeBatch: async ({ requests }) => {
      const requestsByFile = new Map<
        string,
        {
          readonly path: readonly string[];
          readonly request: TranslationWriteRequest<TBody, TUnit>;
        }[]
      >();
      for (const request of requests) {
        const locator = targetLocatorSchema.parse(request.target.locator);
        if (!isSafeProjectFile(locator.file)) {
          throw new Error(`目标路径不是项目内的规范相对路径：${locator.file}`);
        }
        const targets = requestsByFile.get(locator.file) ?? [];
        targets.push({ path: locator.path, request: request.request });
        requestsByFile.set(locator.file, targets);
      }

      const filesWithDeletions = [...requestsByFile.entries()]
        .filter(([, fileRequests]) =>
          fileRequests.some(({ request }) => request.operation === "delete"),
        )
        .map(([file]) => file);
      const sourceDocuments = await currentSourceDocuments(
        paths,
        filesWithDeletions,
      );

      for (const [file, fileRequests] of requestsByFile) {
        const targetFile = join(paths.projectDirectory, file);
        const document = await readTargetDocument(targetFile);
        const deletedPaths: (readonly string[])[] = [];
        for (const { path, request } of fileRequests) {
          if (request.operation === "write") {
            setDocumentPath(document, path, request.content);
          } else {
            document.deleteIn(path);
            deletedPaths.push(path);
          }
        }
        const sourceDocument = sourceDocuments.get(file);
        if (sourceDocument !== undefined) {
          pruneDeletedEmptyMapAncestors(document, sourceDocument, deletedPaths);
        }
        await mkdir(dirname(targetFile), { recursive: true });
        await writeFile(
          targetFile,
          document.toString({ lineWidth: 0 }),
          "utf8",
        );
      }
    },
  };
  return adapter;
}
