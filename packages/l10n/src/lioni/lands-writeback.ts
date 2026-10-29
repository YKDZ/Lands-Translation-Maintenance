import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  TranslationUnitInput,
  TranslationWriteRequest,
  TranslationWritebackAdapter,
} from "@lioni/lioni";
import { z } from "zod";

import type { LandsProjectPaths } from "#/lioni/project-paths";
import type { JsonValue } from "#/model";
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

      for (const [file, fileRequests] of requestsByFile) {
        const targetFile = join(paths.projectDirectory, file);
        const document = await readTargetDocument(targetFile);
        for (const { path, request } of fileRequests) {
          if (request.operation === "write") {
            setDocumentPath(document, path, request.content);
          } else {
            document.deleteIn(path);
          }
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
