import type {
  AdaptedMiniMessageInput,
  MiniMessagePosition,
} from "#/mini-message-model";

export interface LegacyFormatMarker {
  readonly kind: "color" | "decoration" | "reset";
  readonly name: string;
  readonly position: MiniMessagePosition;
}

export interface LegacyFormatIssue {
  readonly code: string;
  readonly position: MiniMessagePosition;
  readonly expected: string;
  readonly actual: string;
}

export interface LegacyMiniMessageAdaptation extends AdaptedMiniMessageInput {
  readonly markers: readonly LegacyFormatMarker[];
  readonly issues: readonly LegacyFormatIssue[];
}

const colorNames = [
  "black",
  "dark_blue",
  "dark_green",
  "dark_aqua",
  "dark_red",
  "dark_purple",
  "gold",
  "gray",
  "dark_gray",
  "blue",
  "green",
  "aqua",
  "red",
  "light_purple",
  "yellow",
  "white",
] as const;
const colorCodes = new Map(
  "0123456789abcdef".split("").map((code, index) => [code, colorNames[index]!]),
);
const decorationNames = ["obf", "b", "st", "u", "i"] as const;
const decorationCodes = new Map(
  "klmno".split("").map((code, index) => [code, decorationNames[index]!]),
);
const legacyHex = /^#[a-f\d]{6}$/iu;
const htmlLikeTag = /<\/?[a-zA-Z#!][^<>]*>/uy;

interface OutputBuilder {
  readonly pieces: string[];
  readonly sourceOffsets: number[];
  exact: boolean;
}

function append(
  output: OutputBuilder,
  text: string,
  sourceStart: number,
  sourceEnd: number,
  exact: boolean,
  finalBoundary = sourceEnd,
): void {
  if (text.length === 0) return;
  output.pieces.push(text);
  if (!exact || text.length !== sourceEnd - sourceStart) output.exact = false;
  for (let index = 1; index <= text.length; index += 1) {
    output.sourceOffsets.push(
      exact && text.length === sourceEnd - sourceStart
        ? sourceStart + index
        : index === text.length
          ? finalBoundary
          : sourceStart,
    );
  }
}

function lowerHex(value: string): string {
  return value.toLowerCase();
}

function legacyHexSequenceEnd(
  input: string,
  start: number,
  prefix: "&" | "§",
): number | undefined {
  if (input[start + 1]?.toLowerCase() !== "x" || start + 14 > input.length) {
    return undefined;
  }
  for (let digit = 0; digit < 6; digit += 1) {
    const prefixIndex = start + 2 + digit * 2;
    if (
      input[prefixIndex] !== prefix ||
      !/[0-9a-f]/iu.test(input[prefixIndex + 1] ?? "")
    ) {
      return undefined;
    }
  }
  return start + 14;
}

function malformedHexCandidate(
  input: string,
  start: number,
  prefix: "&" | "§",
): boolean {
  if (input[start + 1]?.toLowerCase() !== "x") return false;
  const remainder = input.slice(start + 2, start + 14);
  return remainder.includes(prefix) || /[0-9a-f]/iu.test(remainder);
}

/** 按当前 Lands 格式规则转换旧颜色码并保留原文位置映射。 */
export function adaptLegacyMiniMessageInput(
  input: string,
): LegacyMiniMessageAdaptation {
  const output: OutputBuilder = {
    pieces: [],
    sourceOffsets: [0],
    exact: true,
  };
  const markers: LegacyFormatMarker[] = [];
  const issues: LegacyFormatIssue[] = [];
  const activeDecorations = new Set<string>();
  const emitClosures = (position: MiniMessagePosition): void => {
    for (const decoration of decorationNames) {
      if (!activeDecorations.delete(decoration)) continue;
      append(
        output,
        `<!${decoration}>`,
        position.start,
        position.end,
        false,
        position.start,
      );
    }
  };
  const emitMarker = (
    kind: LegacyFormatMarker["kind"],
    name: string,
    position: MiniMessagePosition,
    text: string,
  ): void => {
    markers.push({ kind, name, position });
    append(output, text, position.start, position.end, false);
  };
  const appendCopied = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) {
      append(output, input[index]!, index, index + 1, true);
    }
  };

  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === "<") {
      htmlLikeTag.lastIndex = index;
      const tag = htmlLikeTag.exec(input);
      if (tag !== null) {
        appendCopied(index, htmlLikeTag.lastIndex);
        index = htmlLikeTag.lastIndex - 1;
        continue;
      }
    }

    const codePrefix = input[index];
    if (
      (codePrefix === "&" || codePrefix === "§") &&
      index + 1 < input.length
    ) {
      const code = input[index + 1]!.toLowerCase();
      const position = { start: index, end: index + 2 };
      const color = colorCodes.get(code);
      const decoration = decorationCodes.get(code);

      if (color !== undefined) {
        emitClosures(position);
        emitMarker("color", color, position, `<${color}>`);
        index += 1;
        continue;
      }
      if (decoration !== undefined) {
        activeDecorations.add(decoration);
        emitMarker("decoration", decoration, position, `<${decoration}>`);
        index += 1;
        continue;
      }
      if (code === "r") {
        emitClosures(position);
        emitMarker("reset", "white", position, "<white>");
        index += 1;
        continue;
      }
      if (code === "x") {
        const end = legacyHexSequenceEnd(input, index, codePrefix);
        if (end !== undefined) {
          const position = { start: index, end };
          const color = input.slice(index + 3, end).replaceAll(codePrefix, "");
          emitClosures(position);
          emitMarker(
            "color",
            `#${lowerHex(color)}`,
            position,
            `<#${lowerHex(color)}>`,
          );
          index = end - 1;
          continue;
        }
        if (malformedHexCandidate(input, index, codePrefix)) {
          issues.push({
            code: "legacy-format.hex-sequence-invalid",
            position: { start: index, end: Math.min(index + 14, input.length) },
            expected: "六组相同前缀加十六进制数字",
            actual: input.slice(index, Math.min(index + 14, input.length)),
          });
        }
      }
    }

    if (input[index] === "#" && index + 7 <= input.length) {
      const hex = input.slice(index, index + 7);
      if ((index === 0 || input[index - 1] !== "<") && legacyHex.test(hex)) {
        const position = { start: index, end: index + 7 };
        emitClosures(position);
        emitMarker("color", hex, position, `<${hex}>`);
        index += 6;
        continue;
      }
    }
    appendCopied(index, index + 1);
  }

  return {
    input: output.pieces.join(""),
    sourceOffsets: output.sourceOffsets,
    exact: output.exact,
    markers,
    issues,
  };
}
