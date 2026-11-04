import type { JsonValue } from "#/json-value";

/** 完整语言资源保留空映射和无正文的 GUI 物品，供加载检查使用。 */
export type LandsLanguageLoadResource = {
  readonly file: string;
  readonly kind: "chat" | "gui";
} & (
  | {
      readonly status: "available";
      readonly source: JsonValue;
      readonly target: JsonValue;
      readonly definitions?: JsonValue;
    }
  | { readonly status: "missing" }
  | { readonly status: "unavailable"; readonly reason: string }
);
export interface LandsLanguageLoadFinding {
  readonly file: string;
  readonly path: readonly string[];
  readonly code: "unused-value" | "unused-menu" | "invalid-slots";
  readonly message: string;
  readonly actual: JsonValue;
}
type ObjectValue = { readonly [key: string]: JsonValue };
function section(value: JsonValue | undefined): value is ObjectValue {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
function object(value: JsonValue | undefined): ObjectValue {
  return section(value) ? value : {};
}

/** 加载时补入缺失定义；已有标量和列表保持原值。 */
function defaults(value: JsonValue, fallback: JsonValue): JsonValue {
  if (!section(value) || !section(fallback)) return value;
  const result: Record<string, JsonValue> = { ...value };
  for (const [key, entry] of Object.entries(fallback))
    result[key] =
      result[key] === undefined || result[key] === null
        ? entry
        : defaults(result[key], entry);
  return result;
}
function paths(
  value: JsonValue,
  prefix: readonly string[] = [],
): readonly (readonly string[])[] {
  return Object.entries(object(value))
    .filter(([, entry]) => entry !== null)
    .flatMap(([key, entry]) => {
      const path = [...prefix, key];
      // Bukkit getValues(true) 包含映射本身，但不展开列表索引。
      return [path, ...paths(entry, path)];
    });
}
function get(value: JsonValue, path: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const key of path) current = object(current)[key];
  return current;
}
function integer(value: string): number | undefined {
  if (!/^[+-]?\d+$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isInteger(number) &&
    number >= -2147483648 &&
    number <= 2147483647
    ? number
    : undefined;
}
/** 9.1.1 Java 槽位从 1 开始，支持分号、逗号、列表和闭区间；至少一段有效即可。 */
function validSlots(value: JsonValue | undefined, size: number): boolean {
  const entries = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : typeof value === "string" || typeof value === "number"
        ? String(value).split(";")
        : [];
  return entries.some(
    (entry) =>
      (typeof entry === "string" || typeof entry === "number") &&
      String(entry)
        .split(",")
        .some((token) => {
          if (token.includes("-")) {
            const [first, last] = token.split("-");
            const start = integer(first ?? ""),
              end = integer(last ?? "");
            return (
              start !== undefined &&
              end !== undefined &&
              start >= 1 &&
              end >= start &&
              end <= size
            );
          }
          const slot = integer(token);
          return slot !== undefined && slot >= 1 && slot <= size;
        }),
  );
}
function sizeOf(menu: ObjectValue, common: ObjectValue): number {
  const configured = menu.size ?? common.size ?? 45;
  const size = typeof configured === "number" ? Math.trunc(configured) : 45;
  return Math.min(54, Math.max(9, Math.ceil(size / 9) * 9));
}
const itemTypes = new Set([
  "normal",
  "placeholder",
  "child",
  "custom",
  "refresh",
  "entry",
]);
function itemIdentity(name: string): {
  readonly type: string;
  readonly name: string;
} {
  const split = name.indexOf("_"),
    prefix = name.slice(0, split).toLowerCase();
  return split >= 0 && itemTypes.has(prefix)
    ? { type: prefix, name: name.slice(split + 1).toLowerCase() }
    : { type: "normal", name: name.toLowerCase() };
}

/**
 * 对照 Lands 9.1.1 语言清理和 Java GUI 加载分支，仅报告、不写回。
 * GUI 只清理整段未知菜单；物品遵循动态条目、公共模板和 patch 的槽位规则。
 * Bedrock order 不属于 Java 槽位；自定义物品允许配置自己的有效槽位。
 */
export function inspectLandsLanguageLoad(
  resources: readonly LandsLanguageLoadResource[],
) {
  const findings: LandsLanguageLoadFinding[] = [];
  const issues = resources.filter(
    (resource) => resource.status === "unavailable",
  );
  const available = resources.filter(
    (resource) => resource.status === "available",
  );
  const guis = available
    .filter((resource) => resource.kind === "gui")
    .map((resource) => {
      const source = defaults(resource.source, resource.definitions ?? {});
      return {
        ...resource,
        source,
        effective: object(defaults(resource.target, source)),
      };
    });
  // 主 Locale 目录的 common 同时供 Nations/Wars 使用，模块可局部覆盖。
  const globalCommon = object(
    guis.find((resource) => resource.file.split("/").length === 2)?.effective
      .common,
  );
  for (const resource of available.filter((entry) => entry.kind === "chat")) {
    const expected = new Set(
      paths(resource.source).map((path) => JSON.stringify(path)),
    );
    for (const path of paths(resource.target))
      if (!expected.has(JSON.stringify(path)))
        findings.push({
          file: resource.file,
          path,
          code: "unused-value",
          message: "Lands 加载时会删除此废弃语言键",
          actual: get(resource.target, path) ?? null,
        });
  }
  for (const resource of guis) {
    const sourceMenus = object(object(resource.source).gui);
    const common = object(
      defaults(object(resource.effective.common), globalCommon),
    );
    const commonItems = object(object(common.items).default);
    const shared = new Map(
      Object.entries(commonItems).map(([name, value]) => [
        itemIdentity(name).name,
        { value: object(value), size: sizeOf(common, {}) },
      ]),
    );
    for (const [name, menuValue] of Object.entries(
      object(resource.effective.gui),
    )) {
      if (!section(menuValue)) continue;
      if (!Object.hasOwn(sourceMenus, name)) {
        findings.push({
          file: resource.file,
          path: ["gui", name],
          code: "unused-menu",
          message: "Lands 加载时会删除此废弃菜单及其全部条目",
          actual: menuValue,
        });
        continue;
      }
      const size = sizeOf(menuValue, common),
        items = object(menuValue.items),
        baseItems = object(items.default);
      const groups: { path: string[]; value: ObjectValue; patch: boolean }[] = [
        {
          path: ["gui", name, "items", "default"],
          value: baseItems,
          patch: false,
        },
        {
          path: ["gui", name, "items", "custom"],
          value: object(items.custom),
          patch: false,
        },
      ];
      const sourcePatches = object(
        object(object(sourceMenus[name]).items).patches,
      );
      for (const patch of Object.keys(sourcePatches))
        groups.push({
          path: ["gui", name, "items", "patches", patch],
          value: object(object(items.patches)[patch]),
          patch: true,
        });
      for (const group of groups)
        for (const [key, value] of Object.entries(group.value)) {
          if (!section(value)) continue;
          const identity = itemIdentity(key);
          if (identity.type === "child" || identity.type === "entry") continue;
          const inherited = shared.get(identity.name);
          const slots = group.patch
            ? object(defaults(value, baseItems[key] ?? {})).slots
            : value.slots;
          if (
            validSlots(slots, size) ||
            (inherited !== undefined &&
              validSlots(inherited.value.slots, inherited.size))
          )
            continue;
          findings.push({
            file: resource.file,
            path: [...group.path, key],
            code: "invalid-slots",
            message: "Lands GUI 加载时找不到有效槽位（含公共模板回退）",
            actual: { slots: slots ?? null, size },
          });
        }
    }
  }
  return { findings, issues };
}
