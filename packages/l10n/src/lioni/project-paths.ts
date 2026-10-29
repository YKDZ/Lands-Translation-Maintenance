import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface LandsProjectPaths {
  readonly entryFile: string;
  readonly projectDirectory: string;
  readonly maintenanceDirectory: string;
  readonly sourceDirectory: string;
  readonly projectConfigurationFile: string;
  readonly exceptionFile: string;
  readonly termbaseDirectory: string;
}

/** 以宿主传入的 Lioni 薄入口为基准解析项目输入。 */
export function landsProjectPaths(entryUrl: string | URL): LandsProjectPaths {
  const url = entryUrl instanceof URL ? entryUrl : new URL(entryUrl);
  if (url.protocol !== "file:") {
    throw new TypeError("Lioni 项目入口必须是本地文件 URL。");
  }

  const entryFile = fileURLToPath(url);
  const maintenanceDirectory = dirname(entryFile);
  const projectDirectory = dirname(maintenanceDirectory);

  return {
    entryFile,
    projectDirectory,
    maintenanceDirectory,
    sourceDirectory: join(maintenanceDirectory, "source"),
    projectConfigurationFile: join(maintenanceDirectory, "project.yml"),
    exceptionFile: join(maintenanceDirectory, "lioni.exceptions.yaml"),
    termbaseDirectory: join(maintenanceDirectory, "terms"),
  };
}
