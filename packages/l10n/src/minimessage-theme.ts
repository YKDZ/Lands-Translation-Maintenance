import type { ProjectFileIssue, ResourceInventoryEntry } from "#/model";
import { parseYaml } from "#/yaml-data";

export interface MiniMessageThemeSnapshot {
  readonly file: string;
  readonly source: string;
}

export interface CapturedMiniMessageTheme {
  readonly theme?: MiniMessageThemeSnapshot;
  readonly ambiguousFiles: readonly string[];
  readonly unavailableFiles: readonly string[];
}

function themeFiles(resources: readonly ResourceInventoryEntry[]): string[] {
  return resources
    .filter((resource) => resource.purpose === "configuration")
    .map((resource) => resource.path)
    .filter((path) => path.split("/").at(-1) === "theme.yml")
    .sort();
}

export function captureMiniMessageTheme(
  resources: readonly ResourceInventoryEntry[],
  resourceBytes: ReadonlyMap<string, Uint8Array>,
): CapturedMiniMessageTheme {
  const files = themeFiles(resources);
  if (files.length > 1) return { ambiguousFiles: files, unavailableFiles: [] };
  const file = files[0];
  if (file === undefined) return { ambiguousFiles: [], unavailableFiles: [] };
  const bytes = resourceBytes.get(file);
  if (bytes === undefined) {
    return { ambiguousFiles: [], unavailableFiles: [file] };
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ambiguousFiles: [], unavailableFiles: [file] };
  }
  return {
    theme: { file, source },
    ambiguousFiles: [],
    unavailableFiles: [],
  };
}

export function validateMiniMessageThemeYaml(
  theme: MiniMessageThemeSnapshot,
): readonly ProjectFileIssue[] {
  const parsed = parseYaml(theme.source, theme.file);
  return parsed.ok ? [] : parsed.issues;
}
