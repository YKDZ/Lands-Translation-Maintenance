import { createHash } from "node:crypto";

import type { JsonValue } from "#/json-value";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonValue(entry));
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: toJsonValue(entry),
        writable: true,
      });
    }
    return result;
  }
  throw new TypeError("值无法无损表示为 JSON 数据");
}

export function deepFreeze<Value>(value: Value): Readonly<Value> {
  const seen = new WeakSet<object>();
  const freeze = (current: unknown): void => {
    if (
      current === null ||
      typeof current !== "object" ||
      seen.has(current) ||
      Object.isFrozen(current)
    ) {
      return;
    }
    seen.add(current);
    for (const child of Object.values(current)) freeze(child);
    Object.freeze(current);
  };
  freeze(value);
  return value;
}

export function describeValue(value: unknown): string {
  if (value === undefined) return "缺失";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === "string")
      ? "字符串列表"
      : "列表";
  }
  if (typeof value === "object") return "对象";
  if (typeof value === "string") return "字符串";
  if (typeof value === "number") return "数字";
  if (typeof value === "boolean") return "布尔值";
  return "不支持的值";
}

export function toPointer(path: readonly (string | number)[]): string {
  return path
    .map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1"))
    .map((part) => `/${part}`)
    .join("");
}
