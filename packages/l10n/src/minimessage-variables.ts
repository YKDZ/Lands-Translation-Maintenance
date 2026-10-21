import type {
  CheckRule,
  JsonValue,
  MiniMessageContextFrame,
  MiniMessagePosition,
  MiniMessageTagNode,
  ParsedMiniMessageDocument,
  ProjectView,
  RuleFinding,
  VariableContextPart,
  VariableCountDifference,
  VariableOccurrence,
} from "#/model";
import { canonicalJson } from "#/value";
import { compareVariableOccurrences } from "#/variable-comparison";

interface ClickInteraction {
  readonly document: ParsedMiniMessageDocument;
  readonly node: MiniMessageTagNode;
  readonly action: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly commandName: string;
  readonly commandArguments: string;
  readonly parentContext: readonly VariableContextPart[];
}

interface SideExtraction {
  readonly variables: readonly VariableOccurrence[];
  readonly clicks: readonly ClickInteraction[];
  readonly interactionRoots: readonly InteractionDistribution[];
  readonly limitations: readonly CoverageLimitation[];
}

interface CoverageLimitation {
  readonly reason: string;
  readonly context?: readonly VariableContextPart[];
  readonly position?: MiniMessagePosition;
  readonly object?: JsonValue;
}

type LimitationCollection = Map<string, CoverageLimitation>;

interface ClickPatternMatch {
  readonly action: string;
  readonly quote: string;
  readonly content: string;
  readonly contentOffset: number;
}

interface IndexedTag {
  readonly document: ParsedMiniMessageDocument;
  readonly node: MiniMessageTagNode;
}

interface InteractionDistribution {
  readonly fieldKey: string;
  readonly fieldContext: VariableContextPart;
  readonly parentKey?: string;
  readonly kind: "click" | "hover";
  readonly position: MiniMessagePosition;
  readonly behaviorKey: string;
  readonly behavior: JsonValue;
  readonly textVariables: Map<string, number>;
  readonly commandVariables: Map<string, number>;
  readonly children: InteractionDistribution[];
}

function addLimitation(
  limitations: LimitationCollection,
  reason: string,
  details: Omit<CoverageLimitation, "reason"> = {},
): void {
  const limitation: CoverageLimitation = { reason, ...details };
  limitations.set(canonicalJson(limitation), limitation);
}

const variablePattern = /<v:([A-Za-z0-9_.-]+)>/gu;
const landsClickPattern =
  /^<click:(run_command|suggest_command|copy_to_clipboard):(["'])((?:\\[^\n\r\u0085\u2028\u2029]|(?!\2)[^\n\r\u0085\u2028\u2029])*)\2>/u;
const commandActions = new Set(["run_command", "suggest_command"]);

function isVariable(node: MiniMessageTagNode): boolean {
  return node.name === "v" && !node.closing && node.parameters[0] !== undefined;
}

function isJsonObject(value: JsonValue): value is {
  readonly [key: string]: JsonValue;
} {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInsideTagParameter(
  document: ParsedMiniMessageDocument,
  variable: MiniMessageTagNode,
): boolean {
  return document.nodes.some(
    (candidate) =>
      candidate.kind === "tag" &&
      candidate.name !== "v" &&
      !candidate.closing &&
      ((candidate.name === "click" &&
        candidate.position.start <= variable.position.start &&
        variable.position.end <= candidate.position.end) ||
        candidate.parameterPositions.some(
          (position) =>
            position.start >= 0 &&
            variable.position.start >= position.start &&
            variable.position.end <= position.end,
        )),
  );
}

function fieldContext(
  document: ParsedMiniMessageDocument,
): VariableContextPart {
  return {
    kind: "field",
    identity: {
      surface: document.surface,
      path: [...document.path],
    },
  };
}

function documentKey(document: ParsedMiniMessageDocument): string {
  return canonicalJson({
    messageId: document.message.id,
    origin: document.origin,
    file: document.file,
    surface: document.surface,
    path: document.path,
  });
}

function sourcePositionKey(
  document: ParsedMiniMessageDocument,
  start: number,
): string {
  return canonicalJson({ document: documentKey(document), start });
}

function commandParts(value: string): {
  readonly name: string;
  readonly arguments: string;
} {
  const match = /^\s*\S+/u.exec(value);
  if (match === null) return { name: "", arguments: value };
  return {
    name: match[0],
    arguments: value.slice(match[0].length),
  };
}

function quotedClickPattern(
  node: MiniMessageTagNode,
): ClickPatternMatch | undefined {
  const match = landsClickPattern.exec(node.raw);
  if (match === null) return undefined;
  const action = match[1];
  const quote = match[2];
  const content = match[3];
  if (action === undefined || quote === undefined || content === undefined) {
    return undefined;
  }
  const contentOffset = match[0].indexOf(content);
  if (contentOffset < 0) return undefined;
  return { action, quote, content, contentOffset };
}

function unquoteAndUnescape(value: string, quote: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]!;
    const next = value[index + 1];
    if (current === "\\" && (next === quote || next === "\\")) {
      result += next;
      index += 1;
    } else {
      result += current;
    }
  }
  return result;
}

function variablesInClick(
  interaction: ClickInteraction,
  limitations: LimitationCollection,
): readonly VariableOccurrence[] {
  const pattern = quotedClickPattern(interaction.node);
  if (pattern === undefined) return [];
  if (pattern.action !== interaction.action) {
    addLimitation(
      limitations,
      "click 原文动作与官方解析结果不一致，无法确认 Lands 变量预处理范围",
      {
        context: [fieldContext(interaction.document)],
        position: interaction.node.position,
        object: interaction.node.raw,
      },
    );
    return [];
  }
  const decodedContent = unquoteAndUnescape(pattern.content, pattern.quote);
  if (decodedContent !== interaction.value) {
    addLimitation(
      limitations,
      "click 命令参数经过解析后无法与 Lands 引号预处理输入对应",
      {
        context: [fieldContext(interaction.document)],
        position: interaction.node.position,
        object: interaction.node.raw,
      },
    );
    return [];
  }

  const result: VariableOccurrence[] = [];
  for (const match of pattern.content.matchAll(variablePattern)) {
    const name = match[1];
    const offset = match.index;
    if (name === undefined || offset === undefined) continue;
    if (interaction.node.position.start < 0) {
      addLimitation(limitations, "click 命令变量无法可靠映射回原文位置", {
        context: [fieldContext(interaction.document)],
        object: interaction.node.raw,
      });
      continue;
    }
    result.push({
      name,
      context: [
        fieldContext(interaction.document),
        ...interaction.parentContext,
        {
          kind: "click-command",
          identity: {
            action: interaction.action,
            value: interaction.normalizedValue,
          },
        },
      ],
      position: {
        start: interaction.node.position.start + pattern.contentOffset + offset,
        end:
          interaction.node.position.start +
          pattern.contentOffset +
          offset +
          match[0].length,
      },
    });
  }
  return result;
}

function makeClickInteraction(
  document: ParsedMiniMessageDocument,
  node: MiniMessageTagNode,
  limitations: LimitationCollection,
): ClickInteraction | undefined {
  const actionValue = node.parameters[0];
  const value = node.parameters[1];
  if (actionValue === undefined || value === undefined) {
    addLimitation(limitations, "click 交互缺少官方解析所需的动作或参数", {
      context: [fieldContext(document)],
      position: node.position,
      object: node.raw,
    });
    return undefined;
  }
  const action = actionValue.toLowerCase();
  const quotedPattern = quotedClickPattern(node);
  const eligibleForVariables =
    quotedPattern !== undefined && quotedPattern.action === action;
  const normalizedValue = eligibleForVariables
    ? value.replace(variablePattern, "<v:*>")
    : value;
  const command = commandParts(normalizedValue);
  return {
    document,
    node,
    action,
    value,
    normalizedValue,
    commandName: command.name,
    commandArguments: command.arguments,
    parentContext: [],
  };
}

function tagIndex(
  documents: readonly ParsedMiniMessageDocument[],
): ReadonlyMap<string, IndexedTag> {
  const result = new Map<string, IndexedTag>();
  for (const document of documents) {
    for (const node of document.nodes) {
      if (node.kind !== "tag" || node.closing) continue;
      result.set(sourcePositionKey(document, node.position.start), {
        document,
        node,
      });
    }
  }
  return result;
}

function interactionContext(
  frames: readonly MiniMessageContextFrame[],
  document: ParsedMiniMessageDocument,
  tags: ReadonlyMap<string, IndexedTag>,
  clicks: ReadonlyMap<string, ClickInteraction>,
  limitations: LimitationCollection,
): readonly VariableContextPart[] {
  const result: VariableContextPart[] = [];
  for (const frame of frames) {
    if (frame.position.start < 0) {
      if (frame.kind === "hover-text" || frame.name === "click") {
        addLimitation(limitations, "交互上下文无法可靠映射到官方解析源节点", {
          object: { kind: frame.kind, name: frame.name },
        });
      }
      continue;
    }
    if (frame.kind === "tag" && frame.name === "click") {
      const interaction = clicks.get(
        sourcePositionKey(document, frame.position.start),
      );
      if (interaction === undefined) {
        addLimitation(limitations, "click 正文上下文缺少对应官方交互节点", {
          position: frame.position,
          object: { kind: frame.kind, name: frame.name },
        });
        continue;
      }
      result.push({
        kind: "click-text",
        identity: {
          action: interaction.action,
          value: interaction.normalizedValue,
        },
      });
    } else if (frame.kind === "hover-text") {
      const tag = tags.get(sourcePositionKey(document, frame.position.start));
      if (tag === undefined || tag.node.name !== "hover") {
        addLimitation(limitations, "hover 文本上下文缺少对应官方交互节点", {
          position: frame.position,
          object: { kind: frame.kind, name: frame.name },
        });
        continue;
      }
      const parent = interactionContext(
        tag.node.context,
        tag.document,
        tags,
        clicks,
        limitations,
      );
      result.push({
        kind: "hover-text",
        identity: hoverIdentity(tag.node, parent),
      });
    }
  }
  return result;
}

function hoverIdentity(
  tag: MiniMessageTagNode,
  parent: readonly VariableContextPart[],
): JsonValue {
  return { ...hoverBehavior(tag), parent: parent as unknown as JsonValue };
}

function hoverBehavior(tag: MiniMessageTagNode): {
  readonly action: string;
  readonly parameters: readonly string[];
} {
  const action = tag.parameters[0]?.toLowerCase() ?? "unknown";
  const parameters =
    action === "show_text"
      ? []
      : action === "show_entity"
        ? tag.parameters.slice(1, 3)
        : tag.parameters.slice(1);
  return { action, parameters };
}

function nearestInteractionFrame(
  frames: readonly MiniMessageContextFrame[],
): MiniMessageContextFrame | undefined {
  return [...frames]
    .reverse()
    .find(
      (frame) =>
        frame.kind === "hover-text" ||
        (frame.kind === "tag" && frame.name === "click"),
    );
}

function addVariableCount(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

function interactionTree(
  documents: readonly ParsedMiniMessageDocument[],
  clicks: readonly ClickInteraction[],
  limitations: LimitationCollection,
): readonly InteractionDistribution[] {
  const interactions = new Map<string, InteractionDistribution>();
  const clicksByPosition = new Map(
    clicks.map((interaction) => [
      sourcePositionKey(interaction.document, interaction.node.position.start),
      interaction,
    ]),
  );

  for (const document of documents) {
    if (document.status !== "parsed") continue;
    for (const node of document.nodes) {
      if (node.kind !== "tag" || node.closing) continue;
      const key = sourcePositionKey(document, node.position.start);
      let kind: "click" | "hover";
      let behavior: JsonValue;
      if (node.name === "click") {
        const click = clicksByPosition.get(key);
        if (click === undefined) continue;
        kind = "click";
        behavior = {
          action: click.action,
          value: click.normalizedValue,
        };
      } else if (node.name === "hover") {
        kind = "hover";
        behavior = hoverBehavior(node) as unknown as JsonValue;
      } else {
        continue;
      }
      if (node.position.start < 0) {
        addLimitation(
          limitations,
          "交互对象分布缺少官方解析位置，无法可靠区分同类对象",
          {
            context: [fieldContext(document)],
            object: { kind, tag: node.raw },
          },
        );
        continue;
      }
      const parent = nearestInteractionFrame(node.context);
      if (parent !== undefined && parent.position.start < 0) {
        addLimitation(
          limitations,
          "交互对象的父上下文缺少官方解析位置，无法可靠比较内部变量分布",
          {
            context: [fieldContext(document)],
            object: { kind, tag: node.raw, parent: parent.name },
          },
        );
        continue;
      }
      const field = fieldContext(document);
      const fieldKey = canonicalJson(field);
      interactions.set(key, {
        fieldKey,
        fieldContext: field,
        ...(parent === undefined
          ? {}
          : { parentKey: sourcePositionKey(document, parent.position.start) }),
        kind,
        position: node.position,
        behaviorKey: canonicalJson({ kind, behavior }),
        behavior,
        textVariables: new Map(),
        commandVariables: new Map(),
        children: [],
      });
    }
  }

  for (const interaction of clicks) {
    const key = sourcePositionKey(
      interaction.document,
      interaction.node.position.start,
    );
    const distribution = interactions.get(key);
    if (distribution === undefined) continue;
    for (const variable of variablesInClick(interaction, limitations)) {
      addVariableCount(distribution.commandVariables, variable.name);
    }
  }

  for (const document of documents) {
    if (document.status !== "parsed") continue;
    for (const node of document.nodes) {
      if (
        node.kind !== "tag" ||
        !isVariable(node) ||
        isInsideTagParameter(document, node)
      ) {
        continue;
      }
      const frame = nearestInteractionFrame(node.context);
      if (frame === undefined) continue;
      if (frame.position.start < 0) {
        addLimitation(
          limitations,
          "变量所属交互缺少官方解析位置，无法核对对象内分布",
          {
            context: [fieldContext(document)],
            object: { name: node.parameters[0]!, interaction: frame.name },
          },
        );
        continue;
      }
      const key = sourcePositionKey(document, frame.position.start);
      const interaction = interactions.get(key);
      if (interaction === undefined) {
        addLimitation(
          limitations,
          "变量的官方交互上下文没有对应对象，无法核对对象内分布",
          {
            context: [fieldContext(document)],
            position: node.position,
            object: { name: node.parameters[0]!, interaction: frame.name },
          },
        );
        continue;
      }
      addVariableCount(interaction.textVariables, node.parameters[0]!);
    }
  }

  const roots: InteractionDistribution[] = [];
  for (const interaction of interactions.values()) {
    if (interaction.parentKey === undefined) {
      roots.push(interaction);
      continue;
    }
    const parent = interactions.get(interaction.parentKey);
    if (parent === undefined) {
      addLimitation(
        limitations,
        "交互对象的父节点无法从官方解析结果映射，无法核对对象内变量分布",
        {
          context: [interaction.fieldContext],
          object: { kind: interaction.kind, behavior: interaction.behavior },
        },
      );
      continue;
    }
    parent.children.push(interaction);
  }

  return roots;
}

function extractSide(
  documents: readonly ParsedMiniMessageDocument[],
  parserLimitations: readonly CoverageLimitation[] = [],
): SideExtraction {
  const limitations: LimitationCollection = new Map(
    parserLimitations.map((limitation) => [
      canonicalJson(limitation),
      limitation,
    ]),
  );
  if (documents.some((document) => document.status !== "parsed")) {
    for (const document of documents.filter(
      (item) => item.status !== "parsed",
    )) {
      addLimitation(
        limitations,
        "至少一份 MiniMessage 输入未能完整解析，变量检查无法覆盖全部上下文",
        {
          context: [fieldContext(document)],
          ...(document.range.start < 0 ? {} : { position: document.range }),
          object: { status: document.status },
        },
      );
    }
  }
  const tags = tagIndex(documents);
  const clickCandidates = new Map<string, ClickInteraction>();
  for (const document of documents) {
    if (document.status !== "parsed") continue;
    for (const node of document.nodes) {
      if (node.kind !== "tag" || node.name !== "click" || node.closing)
        continue;
      const interaction = makeClickInteraction(document, node, limitations);
      if (interaction !== undefined)
        clickCandidates.set(
          sourcePositionKey(document, node.position.start),
          interaction,
        );
    }
  }

  const clicks = [...clickCandidates.values()].map((interaction) => ({
    ...interaction,
    parentContext: interactionContext(
      interaction.node.context,
      interaction.document,
      tags,
      clickCandidates,
      limitations,
    ),
  }));
  const clicksByPosition = new Map(
    clicks.map((interaction) => [
      sourcePositionKey(interaction.document, interaction.node.position.start),
      interaction,
    ]),
  );
  const variables: VariableOccurrence[] = [];

  for (const interaction of clicks) {
    variables.push(...variablesInClick(interaction, limitations));
  }

  for (const document of documents) {
    if (document.status !== "parsed") continue;
    for (const node of document.nodes) {
      if (
        node.kind !== "tag" ||
        !isVariable(node) ||
        isInsideTagParameter(document, node)
      ) {
        continue;
      }
      const context = interactionContext(
        node.context,
        document,
        tags,
        clicksByPosition,
        limitations,
      );
      variables.push({
        name: node.parameters[0]!,
        context: [
          fieldContext(document),
          ...(context.length === 0
            ? [{ kind: "body", identity: {} }]
            : context),
        ],
        position: node.position,
      });
    }
  }

  return {
    variables,
    clicks,
    interactionRoots: interactionTree(documents, clicks, limitations),
    limitations: [...limitations.values()].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    ),
  };
}

function finding(
  message: ProjectView["messages"][number],
  code: string,
  context: VariableCountDifference["context"],
  expected: JsonValue,
  actual: JsonValue,
  reason: string,
  identity: JsonValue = { context: context as unknown as JsonValue },
): RuleFinding {
  return {
    code,
    identity,
    message,
    origin: "target",
    location: { file: message.targetFile, path: message.path },
    reason,
    expected,
    actual,
  };
}

function positionValues(
  positions: VariableCountDifference["expectedPositions"],
): JsonValue {
  return positions.map(({ start, end }) => ({ start, end }));
}

function appendDifferenceFindings(
  message: ProjectView["messages"][number],
  difference: readonly VariableCountDifference[],
  findings: RuleFinding[],
): void {
  const contexts = new Map<string, VariableCountDifference[]>();
  for (const item of difference) {
    const key = canonicalJson(item.context);
    const group = contexts.get(key) ?? [];
    group.push(item);
    contexts.set(key, group);
  }

  for (const rows of contexts.values()) {
    const missing = rows
      .filter((item) => item.expectedCount > item.actualCount)
      .map((item) => ({
        item,
        remaining: item.expectedCount - item.actualCount,
      }));
    const added = rows
      .filter((item) => item.actualCount > item.expectedCount)
      .map((item) => ({
        item,
        remaining: item.actualCount - item.expectedCount,
      }));

    for (const expected of missing) {
      for (const actual of added) {
        const count = Math.min(expected.remaining, actual.remaining);
        if (count === 0) continue;
        findings.push(
          finding(
            message,
            "minimessage.variable-name-mismatch",
            expected.item.context,
            {
              name: expected.item.name,
              matchedCount: count,
              totalCount: expected.item.expectedCount,
              positions: positionValues(expected.item.expectedPositions),
              context: expected.item.context as unknown as JsonValue,
            },
            {
              name: actual.item.name,
              matchedCount: count,
              totalCount: actual.item.actualCount,
              positions: positionValues(actual.item.actualPositions),
              context: actual.item.context as unknown as JsonValue,
            },
            `变量名称不一致：${expected.item.name} 被译为 ${actual.item.name}`,
            {
              context: expected.item.context as unknown as JsonValue,
              expectedName: expected.item.name,
            },
          ),
        );
        expected.remaining -= count;
        actual.remaining -= count;
      }
    }

    for (const item of missing) {
      if (item.remaining === 0) continue;
      findings.push(
        finding(
          message,
          "minimessage.variable-missing",
          item.item.context,
          {
            name: item.item.name,
            expectedCount: item.item.expectedCount,
            actualCount: item.item.actualCount,
            remainingCount: item.remaining,
            positions: positionValues(item.item.expectedPositions),
            context: item.item.context as unknown as JsonValue,
          },
          {
            name: item.item.name,
            expectedCount: item.item.expectedCount,
            actualCount: item.item.actualCount,
            positions: positionValues(item.item.actualPositions),
            context: item.item.context as unknown as JsonValue,
          },
          `变量 ${item.item.name} 遗漏或次数不足`,
          {
            context: item.item.context as unknown as JsonValue,
            name: item.item.name,
          },
        ),
      );
    }

    for (const item of added) {
      if (item.remaining === 0) continue;
      findings.push(
        finding(
          message,
          "minimessage.variable-added",
          item.item.context,
          {
            name: item.item.name,
            expectedCount: item.item.expectedCount,
            actualCount: item.item.actualCount,
            positions: positionValues(item.item.expectedPositions),
            context: item.item.context as unknown as JsonValue,
          },
          {
            name: item.item.name,
            expectedCount: item.item.expectedCount,
            actualCount: item.item.actualCount,
            addedCount: item.remaining,
            positions: positionValues(item.item.actualPositions),
            context: item.item.context as unknown as JsonValue,
          },
          `正文新增变量 ${item.item.name} 或出现次数过多`,
          {
            context: item.item.context as unknown as JsonValue,
            name: item.item.name,
          },
        ),
      );
    }
  }
}

function clickPayload(interaction: ClickInteraction): JsonValue {
  return {
    action: interaction.action,
    value: interaction.value,
    normalizedValue: interaction.normalizedValue,
    commandName: interaction.commandName,
    commandArguments: interaction.commandArguments,
    position: {
      start: interaction.node.position.start,
      end: interaction.node.position.end,
    },
  };
}

function clickGroupKey(interaction: ClickInteraction): string {
  return canonicalJson({
    field: fieldContext(interaction.document),
    parentContext: interaction.parentContext,
  });
}

function clickBehaviorKey(interaction: ClickInteraction): string {
  return canonicalJson({
    action: interaction.action,
    value: interaction.normalizedValue,
  });
}

function clickOrdinals(
  groups: ReadonlyMap<string, readonly ClickInteraction[]>,
): ReadonlyMap<ClickInteraction, number> {
  const result = new Map<ClickInteraction, number>();
  for (const group of groups.values()) {
    group.forEach((interaction, index) => {
      result.set(interaction, index);
    });
  }
  return result;
}

function clickFindingIdentity(
  interaction: ClickInteraction,
  ordinal: number,
): JsonValue {
  return {
    field: fieldContext(interaction.document) as unknown as JsonValue,
    parentContext: interaction.parentContext as unknown as JsonValue,
    ordinal,
  };
}

function sortClicks(clicks: readonly ClickInteraction[]): ClickInteraction[] {
  return [...clicks].sort((left, right) =>
    clickBehaviorKey(left).localeCompare(clickBehaviorKey(right)),
  );
}

function takeMatchingClick(
  candidates: ClickInteraction[],
  predicate: (candidate: ClickInteraction) => boolean,
): ClickInteraction | undefined {
  const index = candidates.findIndex(predicate);
  if (index < 0) return undefined;
  return candidates.splice(index, 1)[0];
}

function appendClickDifference(
  message: ProjectView["messages"][number],
  expected: ClickInteraction,
  actual: ClickInteraction,
  identity: JsonValue,
  findings: RuleFinding[],
): void {
  const expectedValue = clickPayload(expected);
  const actualValue = clickPayload(actual);
  const context = [fieldContext(expected.document), ...expected.parentContext];
  if (expected.action !== actual.action) {
    findings.push(
      finding(
        message,
        "minimessage.click-action-mismatch",
        context,
        expectedValue,
        actualValue,
        `click 交互动作从 ${expected.action} 变为 ${actual.action}`,
        identity,
      ),
    );
    return;
  }
  if (commandActions.has(expected.action)) {
    if (expected.commandName !== actual.commandName) {
      findings.push(
        finding(
          message,
          "minimessage.click-command-name-mismatch",
          context,
          expectedValue,
          actualValue,
          `click 命令名从 ${expected.commandName || "（空）"} 变为 ${actual.commandName || "（空）"}`,
          identity,
        ),
      );
    }
    if (expected.commandArguments !== actual.commandArguments) {
      findings.push(
        finding(
          message,
          "minimessage.click-command-arguments-mismatch",
          context,
          expectedValue,
          actualValue,
          "click 命令参数与原文不同",
          identity,
        ),
      );
    }
    return;
  }
  if (expected.normalizedValue !== actual.normalizedValue) {
    findings.push(
      finding(
        message,
        "minimessage.click-value-mismatch",
        context,
        expectedValue,
        actualValue,
        `click ${expected.action} 行为参数与原文不同`,
        identity,
      ),
    );
  }
}

function appendClickFindings(
  message: ProjectView["messages"][number],
  source: readonly ClickInteraction[],
  target: readonly ClickInteraction[],
  findings: RuleFinding[],
): void {
  const sourceGroups = new Map<string, ClickInteraction[]>();
  const targetGroups = new Map<string, ClickInteraction[]>();
  for (const [items, destination] of [
    [source, sourceGroups],
    [target, targetGroups],
  ] as const) {
    for (const item of items) {
      const key = clickGroupKey(item);
      const group = destination.get(key) ?? [];
      group.push(item);
      destination.set(key, group);
    }
  }

  const groupKeys = [
    ...new Set([...sourceGroups.keys(), ...targetGroups.keys()]),
  ].sort();
  const sourceOrdinals = clickOrdinals(sourceGroups);
  const targetOrdinals = clickOrdinals(targetGroups);
  for (const groupKey of groupKeys) {
    const expected = sortClicks(sourceGroups.get(groupKey) ?? []);
    const actual = sortClicks(targetGroups.get(groupKey) ?? []);
    const unmatchedActual = [...actual];
    const unmatchedExpected: ClickInteraction[] = [];
    for (const item of expected) {
      const exact = takeMatchingClick(
        unmatchedActual,
        (candidate) => clickBehaviorKey(candidate) === clickBehaviorKey(item),
      );
      if (exact === undefined) unmatchedExpected.push(item);
    }

    const unmatchedExpectedSorted = sortClicks(unmatchedExpected);
    const unmatchedActualSorted = sortClicks(unmatchedActual);
    while (
      unmatchedExpectedSorted.length > 0 &&
      unmatchedActualSorted.length > 0
    ) {
      const expectedItem = unmatchedExpectedSorted.shift()!;
      const sameCommand = takeMatchingClick(
        unmatchedActualSorted,
        (candidate) =>
          candidate.action === expectedItem.action &&
          (commandActions.has(expectedItem.action)
            ? candidate.commandName === expectedItem.commandName
            : true),
      );
      const sameAction =
        sameCommand === undefined
          ? takeMatchingClick(
              unmatchedActualSorted,
              (candidate) => candidate.action === expectedItem.action,
            )
          : undefined;
      const actualItem =
        sameCommand ?? sameAction ?? unmatchedActualSorted.shift()!;
      const ordinal = sourceOrdinals.get(expectedItem)!;
      appendClickDifference(
        message,
        expectedItem,
        actualItem,
        clickFindingIdentity(expectedItem, ordinal),
        findings,
      );
    }

    for (const item of unmatchedExpectedSorted) {
      const ordinal = sourceOrdinals.get(item)!;
      findings.push(
        finding(
          message,
          "minimessage.click-missing",
          [fieldContext(item.document), ...item.parentContext],
          clickPayload(item),
          { state: "missing" },
          "原文中的 click 交互在译文中缺失",
          clickFindingIdentity(item, ordinal),
        ),
      );
    }
    for (const item of unmatchedActualSorted) {
      const ordinal = targetOrdinals.get(item)!;
      findings.push(
        finding(
          message,
          "minimessage.click-added",
          [fieldContext(item.document), ...item.parentContext],
          { state: "not present in source" },
          clickPayload(item),
          "译文新增了原文没有的 click 交互",
          clickFindingIdentity(item, ordinal),
        ),
      );
    }
  }
}

function interactionDistributionSignature(
  interaction: InteractionDistribution,
): JsonValue {
  const textVariables = Object.fromEntries(
    [...interaction.textVariables].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const commandVariables = Object.fromEntries(
    [...interaction.commandVariables].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const children = interaction.children
    .map(interactionDistributionSignature)
    .sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
  return {
    kind: interaction.kind,
    behavior: interaction.behavior,
    textVariables,
    commandVariables,
    children,
  };
}

function groupInteractionDistributions(
  interactions: readonly InteractionDistribution[],
): ReadonlyMap<string, InteractionDistribution[]> {
  const groups = new Map<string, InteractionDistribution[]>();
  for (const interaction of interactions) {
    const group = groups.get(interaction.behaviorKey) ?? [];
    group.push(interaction);
    groups.set(interaction.behaviorKey, group);
  }
  return groups;
}

function appendInteractionDistributionFindings(
  message: ProjectView["messages"][number],
  source: readonly InteractionDistribution[],
  target: readonly InteractionDistribution[],
  findings: RuleFinding[],
): void {
  const fieldKeys = [
    ...new Set([
      ...source.map((item) => item.fieldKey),
      ...target.map((item) => item.fieldKey),
    ]),
  ].sort();

  const compareSiblings = (
    expected: readonly InteractionDistribution[],
    actual: readonly InteractionDistribution[],
    parentContext: readonly VariableContextPart[],
  ): void => {
    const expectedGroups = groupInteractionDistributions(expected);
    const actualGroups = groupInteractionDistributions(actual);
    const behaviorKeys = [
      ...new Set([...expectedGroups.keys(), ...actualGroups.keys()]),
    ].sort();

    for (const behaviorKey of behaviorKeys) {
      const expectedGroup = expectedGroups.get(behaviorKey) ?? [];
      const actualGroup = actualGroups.get(behaviorKey) ?? [];
      if (
        expectedGroup.length === 0 ||
        expectedGroup.length !== actualGroup.length
      ) {
        continue;
      }
      const sample = expectedGroup[0]!;
      const context = {
        kind: sample.kind === "click" ? "click-text" : "hover-text",
        identity: sample.behavior,
      } satisfies VariableContextPart;
      if (expectedGroup.length > 1) {
        const fullContext = [...parentContext, context];
        const expectedSignatures = expectedGroup
          .map(interactionDistributionSignature)
          .sort((left, right) =>
            canonicalJson(left).localeCompare(canonicalJson(right)),
          );
        const actualSignatures = actualGroup
          .map(interactionDistributionSignature)
          .sort((left, right) =>
            canonicalJson(left).localeCompare(canonicalJson(right)),
          );
        if (
          canonicalJson(expectedSignatures) !== canonicalJson(actualSignatures)
        ) {
          findings.push(
            finding(
              message,
              "minimessage.variable-interaction-distribution-mismatch",
              fullContext,
              {
                behavior: sample.behavior,
                context: fullContext as unknown as JsonValue,
                objects: expectedSignatures,
                positions: expectedGroup
                  .map(({ position }) => ({
                    start: position.start,
                    end: position.end,
                  }))
                  .sort((left, right) => left.start - right.start),
              },
              {
                behavior: sample.behavior,
                context: fullContext as unknown as JsonValue,
                objects: actualSignatures,
                positions: actualGroup
                  .map(({ position }) => ({
                    start: position.start,
                    end: position.end,
                  }))
                  .sort((left, right) => left.start - right.start),
              },
              "同一父交互下多个同类对象的变量及嵌套上下文分配不同；按完整对象分布忽略对象顺序",
            ),
          );
        }
        continue;
      }
      compareSiblings(expectedGroup[0]!.children, actualGroup[0]!.children, [
        ...parentContext,
        context,
      ]);
    }
  };

  for (const fieldKey of fieldKeys) {
    const expected = source.filter((item) => item.fieldKey === fieldKey);
    const actual = target.filter((item) => item.fieldKey === fieldKey);
    const field = expected[0]?.fieldContext ?? actual[0]?.fieldContext;
    if (field === undefined) continue;
    compareSiblings(expected, actual, [field]);
  }
}

function appendLimitations(
  message: ProjectView["messages"][number],
  side: "原文" | "译文",
  limitations: readonly CoverageLimitation[],
  findings: RuleFinding[],
): void {
  for (const limitation of limitations) {
    const context = limitation.context ?? [
      {
        kind: "field",
        identity: { path: [...message.path] },
      },
    ];
    findings.push(
      finding(
        message,
        "minimessage.variable-coverage-unavailable",
        context,
        {
          state: "完整的正文和交互解析结果",
          context: context as unknown as JsonValue,
        },
        {
          side,
          limitation: limitation.reason,
          context: context as unknown as JsonValue,
          ...(limitation.position === undefined
            ? {}
            : {
                position: {
                  start: limitation.position.start,
                  end: limitation.position.end,
                },
              }),
          ...(limitation.object === undefined
            ? {}
            : { object: limitation.object }),
        },
        `${side}的变量/交互上下文无法完整核对：${limitation.reason}`,
      ),
    );
  }
}

function unresolvedInteractionLimitations(
  parsed: NonNullable<ProjectView["miniMessage"]>,
  messageId: string,
  origin: "source" | "target",
): readonly CoverageLimitation[] {
  const limitations = new Map<string, CoverageLimitation>();
  for (const item of parsed.findings) {
    if (
      item.message?.id !== messageId ||
      item.origin !== origin ||
      (item.code !== "minimessage.tag-unresolved" &&
        item.code !== "minimessage.tag-unknown") ||
      !isJsonObject(item.actual)
    ) {
      continue;
    }
    const tagName = item.actual.tagName;
    if (tagName === "click" || tagName === "hover") {
      const raw = item.actual.tag;
      const start = item.actual.position;
      const position =
        typeof start === "number" && start >= 0
          ? {
              start,
              end: start + (typeof raw === "string" ? raw.length : 0),
            }
          : undefined;
      const context: VariableContextPart[] = [
        {
          kind: "field",
          identity: { path: [...item.location.path] },
        },
      ];
      if (Array.isArray(item.actual.context)) {
        for (const frame of item.actual.context) {
          if (!Array.isArray(frame)) continue;
          const [kind, name, frameStart, frameEnd] = frame;
          if (typeof kind !== "string") continue;
          context.push({
            kind,
            identity: {
              ...(typeof name === "string" ? { name } : {}),
              ...(typeof frameStart === "number" && typeof frameEnd === "number"
                ? { position: { start: frameStart, end: frameEnd } }
                : {}),
            },
          });
        }
      }
      const reason =
        `官方解析器未能解析 ${tagName} 交互${typeof raw === "string" ? ` ${raw}` : ""}；` +
        "已保留其源参数，但完整行为语义无法确认";
      const limitation: CoverageLimitation = {
        reason,
        context,
        ...(position === undefined ? {} : { position }),
        object: item.actual,
      };
      limitations.set(canonicalJson(limitation), limitation);
    }
  }
  return [...limitations.values()].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

export const miniMessageVariablesRule: CheckRule = {
  id: "minimessage-variables",
  defaultSeverity: "error",
  requiredInputs: ["minimessage-parse"],
  evaluate(project) {
    const parsed = project.miniMessage;
    if (parsed === undefined) return [];

    const findings: RuleFinding[] = [];
    for (const message of project.messages) {
      const sourceDocuments = parsed.documents.filter(
        (document) =>
          document.message.id === message.id && document.origin === "source",
      );
      const targetDocuments = parsed.documents.filter(
        (document) =>
          document.message.id === message.id && document.origin === "target",
      );
      const source = extractSide(
        sourceDocuments,
        unresolvedInteractionLimitations(parsed, message.id, "source"),
      );
      const target = extractSide(
        targetDocuments,
        unresolvedInteractionLimitations(parsed, message.id, "target"),
      );
      appendDifferenceFindings(
        message,
        compareVariableOccurrences(source.variables, target.variables),
        findings,
      );
      appendClickFindings(message, source.clicks, target.clicks, findings);
      appendInteractionDistributionFindings(
        message,
        source.interactionRoots,
        target.interactionRoots,
        findings,
      );
      appendLimitations(message, "原文", source.limitations, findings);
      appendLimitations(message, "译文", target.limitations, findings);
    }
    return findings;
  },
};
