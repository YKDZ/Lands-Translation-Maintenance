package org.landsl10n.minimessage;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.flattener.ComponentFlattener;
import net.kyori.adventure.text.flattener.FlattenerListener;
import net.kyori.adventure.text.format.Style;
import net.kyori.adventure.text.format.TextDecoration;
import net.kyori.adventure.text.minimessage.MiniMessage;
import net.kyori.adventure.text.minimessage.ParsingException;
import net.kyori.adventure.text.minimessage.internal.parser.Token;
import net.kyori.adventure.text.minimessage.internal.parser.TokenParser;
import net.kyori.adventure.text.minimessage.internal.parser.TokenType;
import net.kyori.adventure.text.minimessage.internal.parser.node.ElementNode;
import net.kyori.adventure.text.minimessage.internal.parser.node.RootNode;
import net.kyori.adventure.text.minimessage.internal.parser.node.TagNode;
import net.kyori.adventure.text.minimessage.internal.parser.node.TagPart;
import net.kyori.adventure.text.minimessage.tag.Inserting;
import net.kyori.adventure.text.minimessage.tag.Tag;
import net.kyori.adventure.text.minimessage.tag.resolver.TagResolver;
import net.kyori.adventure.text.minimessage.tag.standard.StandardTags;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;

public final class MiniMessageBridge {
  private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();
  private static final Base64.Decoder DECODER = Base64.getUrlDecoder();
  private static final Pattern UNRESOLVED_TAG = Pattern.compile(
      "Attempting to match node '([^']+)'(?: at column (\\d+))?\\n"
          + "Could not match node '([^']+)'(?: - ([^\\n]*))?\\n");

  private MiniMessageBridge() {}

  private record ThemeInput(int index, String surface, String name, String input) {}

  private record MessageInput(int index, String surface, String input) {}

  private record StyleParse(Style style, String error, int start, int end) {}

  private record Position(int start, int end) {}

  private record Frame(String kind, String name, Position position) {}

  private record Parameter(String value, Position position) {}

  private record NodeOutput(
      String kind,
      Position position,
      String raw,
      String name,
      boolean closing,
      boolean selfClosing,
      List<Parameter> parameters,
      List<Frame> context) {}

  private record UnresolvedOutput(
      int documentIndex,
      int position,
      String name,
      String detail,
      String raw,
      List<Frame> context) {}

  private static final class SourceMap {
    private final String rootSource;
    private final String input;
    private final int[] indexes;
    private final boolean exact;
    private final Position emptyRange;

    SourceMap(String rootSource, String input, int[] indexes, boolean exact, Position emptyRange) {
      this.rootSource = rootSource;
      this.input = input;
      this.indexes = indexes;
      this.exact = exact;
      this.emptyRange = emptyRange;
    }

    Position range(int start, int end) {
      if (!this.exact || start < 0 || end < start || end > this.indexes.length) {
        return new Position(-1, -1);
      }
      if (start == end) return this.emptyRange;
      return new Position(this.indexes[start], this.indexes[end - 1] + 1);
    }

    String raw(int start, int end) {
      Position position = this.range(start, end);
      if (position.start() >= 0) return this.rootSource.substring(position.start(), position.end());
      return this.input.substring(start, end);
    }

    SourceMap nested(String nestedInput, int[] nestedIndexes, boolean nestedExact, Position emptyRange) {
      return new SourceMap(this.rootSource, nestedInput, nestedIndexes, this.exact && nestedExact, emptyRange);
    }
  }

  private record MappedValue(String value, int[] indexes) {}

  private static String encode(String value) {
    return ENCODER.encodeToString(value.getBytes(StandardCharsets.UTF_8));
  }

  private static String decode(String value) {
    return new String(DECODER.decode(value), StandardCharsets.UTF_8);
  }

  private static List<String> fields(String line) {
    return List.of(line.split("\\t", -1));
  }

  private static String jsonStyle(Style style) {
    String color = style.color() == null ? "null" : "\"" + style.color().asHexString() + "\"";
    StringBuilder decorations = new StringBuilder("{");
    boolean first = true;
    for (TextDecoration decoration : TextDecoration.values()) {
      if (!first) decorations.append(',');
      first = false;
      decorations.append('"')
          .append(decoration.toString().toLowerCase(Locale.ROOT))
          .append("\":\"")
          .append(style.decoration(decoration).toString().toLowerCase(Locale.ROOT))
          .append('"');
    }
    decorations.append('}');
    return "{\"color\":" + color + ",\"decorations\":" + decorations + "}";
  }

  private static StyleParse parseThemeStyle(String input) {
    StringBuilder debug = new StringBuilder();
    MiniMessage parser = MiniMessage.builder()
        .tags(TagResolver.resolver(
            StandardTags.color(),
            StandardTags.decorations(),
            StandardTags.reset()))
        .debug(debug::append)
        .build();
    try {
      Component component = parser.deserialize(input + " ");
      String plain = PlainTextComponentSerializer.plainText().serialize(component);
      if (!plain.trim().isEmpty()) {
        return new StyleParse(null, "主题定义只能包含颜色、装饰与重置标签", -1, -1);
      }
      Matcher unresolved = UNRESOLVED_TAG.matcher(debug);
      if (unresolved.find()) {
        String name = unresolved.group(3);
        return new StyleParse(null, "主题定义包含不允许的标签：" + name,
            parseIndex(unresolved.group(2)), -1);
      }
      List<Style> styles = new ArrayList<>();
      styles.add(Style.empty());
      Style[] finalTextStyle = {Style.empty()};
      ComponentFlattener.basic().flatten(component, new FlattenerListener() {
        @Override
        public void pushStyle(Style style) {
          Style parent = styles.get(styles.size() - 1);
          styles.add(parent.merge(style));
        }

        @Override
        public void component(String text) {
          if (!text.isEmpty()) finalTextStyle[0] = styles.get(styles.size() - 1);
        }

        @Override
        public void popStyle(Style style) {
          styles.remove(styles.size() - 1);
        }
      });
      return new StyleParse(finalTextStyle[0], null, -1, -1);
    } catch (ParsingException exception) {
      return new StyleParse(null, exception.detailMessage(), exception.startIndex(), exception.endIndex());
    } catch (RuntimeException exception) {
      return new StyleParse(null, exception.getMessage(), -1, -1);
    }
  }

  private static int parseIndex(String input) {
    if (input == null) return -1;
    try {
      return Integer.parseInt(input);
    } catch (NumberFormatException ignored) {
      return -1;
    }
  }

  private static TagResolver themeResolver(Map<String, Style> theme) {
    return TagResolver.resolver("t", (arguments, context) -> {
      String token = arguments.popOr("theme token expected").lowerValue();
      Style style = theme.get(token);
      if (style == null) throw context.newException("Unknown theme token: " + token);
      return Tag.styling(builder -> builder.merge(style));
    });
  }

  private static TagResolver variableResolver() {
    return TagResolver.resolver("v", (arguments, context) -> {
      arguments.popOr("placeholder name expected");
      return Tag.selfClosingInserting(Component.empty());
    });
  }

  private static TagResolver messageResolver(Map<String, Style> theme) {
    TagResolver standard = StandardTags.defaults();
    return TagResolver.resolver(standard, themeResolver(theme), variableResolver());
  }

  private static MappedValue decodePart(String input, Token token, SourceMap sourceMap) {
    int start = token.startIndex();
    int end = token.endIndex();
    if (start == end) return new MappedValue("", new int[0]);
    char first = input.charAt(start);
    if (first != '\'' && first != '"') {
      String value = input.substring(start, end);
      int[] indexes = new int[value.length()];
      System.arraycopy(sourceMap.indexes, start, indexes, 0, value.length());
      return new MappedValue(value, indexes);
    }

    int contentStart = start + 1;
    int contentEnd = end;
    char last = input.charAt(end - 1);
    if (last == '\'' || last == '"') contentEnd -= 1;
    if (contentStart > contentEnd) {
      String value = input.substring(start, end);
      int[] indexes = new int[value.length()];
      System.arraycopy(sourceMap.indexes, start, indexes, 0, value.length());
      return new MappedValue(value, indexes);
    }

    StringBuilder value = new StringBuilder(contentEnd - contentStart);
    List<Integer> indexes = new ArrayList<>();
    int cursor = contentStart;
    while (cursor < contentEnd) {
      int codePoint = input.codePointAt(cursor);
      int next = cursor + Character.charCount(codePoint);
      if (codePoint == TokenParser.ESCAPE && next < contentEnd) {
        int following = input.codePointAt(next);
        if (following == first || following == TokenParser.ESCAPE) {
          cursor = next;
          codePoint = following;
          next = cursor + Character.charCount(codePoint);
        }
      }
      value.appendCodePoint(codePoint);
      int count = Character.charCount(codePoint);
      for (int part = 0; part < count; part++) indexes.add(sourceMap.indexes[cursor + part]);
      cursor = next;
    }
    int[] mappedIndexes = indexes.stream().mapToInt(Integer::intValue).toArray();
    return new MappedValue(value.toString(), mappedIndexes);
  }

  private static List<Frame> contextFrames(List<Frame> initial, List<TagNode> openTags, SourceMap sourceMap) {
    List<Frame> result = new ArrayList<>(initial);
    for (TagNode tag : openTags) {
      Position position = sourceMap.range(tag.token().startIndex(), tag.token().endIndex());
      result.add(new Frame("tag", tag.name().toLowerCase(Locale.ROOT), position));
    }
    return result;
  }

  private static List<Parameter> parameters(
      String input,
      Token token,
      TagNode treeTag,
      SourceMap sourceMap) {
    List<Parameter> result = new ArrayList<>();
    List<Token> childTokens = token.childTokens();
    if (childTokens == null) return result;
    List<TagPart> officialParts = treeTag == null ? List.of() : treeTag.parts();
    for (int index = 1; index < childTokens.size(); index++) {
      Token partToken = childTokens.get(index);
      String value = index < officialParts.size()
          ? officialParts.get(index).value()
          : decodePart(input, partToken, sourceMap).value();
      result.add(new Parameter(value, sourceMap.range(partToken.startIndex(), partToken.endIndex())));
    }
    return result;
  }

  private static List<String> partValues(String input, Token token, TagNode treeTag, SourceMap sourceMap) {
    List<String> result = new ArrayList<>();
    List<Token> childTokens = token.childTokens();
    if (childTokens == null) return result;
    List<TagPart> officialParts = treeTag == null ? List.of() : treeTag.parts();
    for (int index = 0; index < childTokens.size(); index++) {
      result.add(index < officialParts.size()
          ? officialParts.get(index).value()
          : decodePart(input, childTokens.get(index), sourceMap).value());
    }
    return result;
  }

  private static boolean closes(List<String> close, TagNode open) {
    List<TagPart> parts = open.parts();
    if (close.size() > parts.size() || close.isEmpty()) return false;
    if (!close.get(0).equalsIgnoreCase(parts.get(0).value())) return false;
    for (int index = 1; index < close.size(); index++) {
      if (!close.get(index).equals(parts.get(index).value())) return false;
    }
    return true;
  }

  private static void collectTagNodes(ElementNode node, Map<String, TagNode> tagNodes) {
    for (ElementNode child : node.children()) {
      if (child instanceof TagNode tag) {
        tagNodes.put(tag.token().startIndex() + ":" + tag.token().endIndex(), tag);
      }
      collectTagNodes(child, tagNodes);
    }
  }

  private static String frameFields(List<Frame> frames) {
    StringBuilder line = new StringBuilder().append(frames.size());
    for (Frame frame : frames) {
      line.append('\t').append(frame.kind())
          .append('\t').append(encode(frame.name()))
          .append('\t').append(frame.position().start())
          .append('\t').append(frame.position().end());
    }
    return line.toString();
  }

  private static void addUnresolved(
      List<UnresolvedOutput> unresolved,
      Set<String> seen,
      int documentIndex,
      int position,
      String name,
      String detail,
      String raw,
      List<Frame> context) {
    String key = documentIndex + "\0" + position + "\0" + name + "\0" + detail;
    if (seen.add(key)) unresolved.add(new UnresolvedOutput(documentIndex, position, name, detail, raw, context));
  }

  private static void outputDocument(
      TagResolver resolver,
      Map<String, Style> theme,
      int messageIndex,
      int documentIndex,
      int parentDocumentIndex,
      String input,
      SourceMap sourceMap,
      List<Frame> initialContext,
      int[] nextDocumentIndex,
      List<String> output) {
    Position documentRange = sourceMap.range(0, input.length());
    output.add("D\t" + messageIndex + "\t" + documentIndex + "\t" + parentDocumentIndex
        + "\t" + documentRange.start() + "\t" + documentRange.end() + "\t" + frameFields(initialContext));

    RootNode tree;
    try {
      tree = (RootNode) MiniMessage.builder().tags(resolver).build().deserializeToTree(input);
    } catch (RuntimeException exception) {
      output.add("W\t" + messageIndex + "\t" + encode("MiniMessage 官方树解析未能提供完整结构："
          + (exception.getMessage() == null ? exception.getClass().getSimpleName() : exception.getMessage())));
      return;
    }

    Map<String, TagNode> treeTags = new HashMap<>();
    collectTagNodes(tree, treeTags);
    List<NodeOutput> nodes = new ArrayList<>();
    List<UnresolvedOutput> unresolved = new ArrayList<>();
    Set<String> seenUnresolved = new HashSet<>();
    List<TagNode> openTags = new ArrayList<>();

    // The official tree supplies resolved nodes and child-acceptance semantics; tokenize adds explicit close tokens,
    // which the 4.26.1 tree intentionally omits. Apply its tagCloses rule to retain those source occurrences.
    for (Token token : TokenParser.tokenize(input, false)) {
      if (token.type() == TokenType.TEXT) {
        Position position = sourceMap.range(token.startIndex(), token.endIndex());
        nodes.add(new NodeOutput("text", position,
            sourceMap.raw(token.startIndex(), token.endIndex()), "", false, false, List.of(),
            contextFrames(initialContext, openTags, sourceMap)));
        continue;
      }
      if (token.childTokens() == null || token.childTokens().isEmpty()) continue;

      TagNode treeTag = treeTags.get(token.startIndex() + ":" + token.endIndex());
      List<String> values = partValues(input, token, treeTag, sourceMap);
      String name = values.isEmpty() ? "" : values.get(0).toLowerCase(Locale.ROOT);
      boolean closing = token.type() == TokenType.CLOSE_TAG;
      boolean selfClosing = token.type() == TokenType.OPEN_CLOSE_TAG;
      List<Frame> currentContext = contextFrames(initialContext, openTags, sourceMap);
      Position position = sourceMap.range(token.startIndex(), token.endIndex());
      String raw = sourceMap.raw(token.startIndex(), token.endIndex());
      List<Parameter> parameters = parameters(input, token, treeTag, sourceMap);
      NodeOutput node = new NodeOutput("tag", position, raw, name,
          closing, selfClosing, parameters, currentContext);
      nodes.add(node);

      if (closing) {
        List<String> closeValues = values;
        for (int index = openTags.size() - 1; index >= 0; index--) {
          if (closes(closeValues, openTags.get(index))) {
            while (openTags.size() > index) openTags.remove(openTags.size() - 1);
            break;
          }
        }
        if (!resolver.has(name)) {
          addUnresolved(unresolved, seenUnresolved, documentIndex, position.start(), name,
              "Unrecognized MiniMessage tag", raw, currentContext);
        }
        continue;
      }

      if (name.equals("reset")) {
        openTags.clear();
      } else if (treeTag != null && !selfClosing) {
        Tag tag = treeTag.tag();
        if (!(tag instanceof Inserting inserting) || inserting.allowsChildren()) openTags.add(treeTag);
      }

      if (treeTag == null && !name.equals("reset")) {
        String detail;
        if (name.equals("t")) {
          String tokenName = parameters.isEmpty() ? "" : parameters.get(0).value();
          detail = tokenName.isEmpty()
              ? "theme token expected"
              : theme.containsKey(tokenName.toLowerCase(Locale.ROOT))
                  ? "Theme token could not be resolved: " + tokenName
                  : "Unknown theme token: " + tokenName.toLowerCase(Locale.ROOT);
        } else {
          detail = resolver.has(name)
              ? "标签参数或形式无法识别"
              : "Unrecognized MiniMessage tag";
        }
        addUnresolved(unresolved, seenUnresolved, documentIndex, position.start(), name,
            detail, raw, currentContext);
      }

      int hoverContentIndex = -1;
      String hoverAction = "";
      if (name.equals("hover") && !closing && treeTag != null && treeTag.parts().size() >= 2) {
        hoverAction = treeTag.parts().get(1).value().toLowerCase(Locale.ROOT);
        if (hoverAction.equals("show_text") && treeTag.parts().size() >= 3) {
          hoverContentIndex = 2;
        } else if (hoverAction.equals("show_entity") && treeTag.parts().size() >= 5) {
          hoverContentIndex = 4;
        }
      }
      if (hoverContentIndex >= 0) {
        TagPart content = treeTag.parts().get(hoverContentIndex);
        MappedValue decoded = decodePart(input, content.token(), sourceMap);
        String nestedInput = content.value();
        boolean exact = decoded.value().equals(nestedInput);
        int[] nestedIndexes = new int[nestedInput.length()];
        if (exact && decoded.indexes().length == nestedIndexes.length) {
          System.arraycopy(decoded.indexes(), 0, nestedIndexes, 0, nestedIndexes.length);
        } else {
          java.util.Arrays.fill(nestedIndexes, -1);
          output.add("W\t" + messageIndex + "\t" + encode(
              "hover 参数经过预处理后无法可靠映射回原文位置；相关嵌套诊断位置不可用"));
        }
        Position emptyRange = sourceMap.range(content.token().startIndex(), content.token().endIndex());
        SourceMap nestedMap = sourceMap.nested(nestedInput, nestedIndexes, exact, emptyRange);
        Position hoverPosition = sourceMap.range(token.startIndex(), token.endIndex());
        List<Frame> nestedContext = new ArrayList<>(currentContext);
        nestedContext.add(new Frame("hover-text", "hover:" + hoverAction, hoverPosition));
        int nestedDocumentIndex = nextDocumentIndex[0]++;
        outputDocument(resolver, theme, messageIndex,
            nestedDocumentIndex, documentIndex, nestedInput, nestedMap, nestedContext,
            nextDocumentIndex, output);
      }
    }

    for (NodeOutput node : nodes) {
      output.add(nodeLine(messageIndex, documentIndex, node));
    }
    for (UnresolvedOutput item : unresolved) {
      output.add("U\t" + messageIndex + "\t" + item.documentIndex() + "\t" + item.position()
          + "\t" + encode(item.name()) + "\t" + encode(item.detail()) + "\t" + encode(item.raw())
          + "\t" + frameFields(item.context()));
    }
  }

  private static String nodeLine(int messageIndex, int documentIndex, NodeOutput node) {
    StringBuilder line = new StringBuilder("N\t")
        .append(messageIndex).append('\t').append(documentIndex).append('\t').append(node.kind())
        .append('\t').append(node.position().start()).append('\t').append(node.position().end())
        .append('\t').append(encode(node.raw())).append('\t').append(encode(node.name()))
        .append('\t').append(node.closing()).append('\t').append(node.selfClosing())
        .append('\t').append(node.parameters().size());
    for (Parameter parameter : node.parameters()) {
      line.append('\t').append(encode(parameter.value()))
          .append('\t').append(parameter.position().start())
          .append('\t').append(parameter.position().end());
    }
    line.append('\t').append(frameFields(node.context()));
    return line.toString();
  }

  private static List<String> readInput() throws Exception {
    return new java.io.BufferedReader(new java.io.InputStreamReader(System.in, StandardCharsets.UTF_8))
        .lines().toList();
  }

  public static void main(String[] arguments) throws Exception {
    List<ThemeInput> themes = new ArrayList<>();
    List<MessageInput> messages = new ArrayList<>();
    for (String line : readInput()) {
      if (line.isEmpty()) continue;
      List<String> fields = fields(line);
      if (fields.get(0).equals("T") && fields.size() == 5) {
        themes.add(new ThemeInput(Integer.parseInt(fields.get(1)), decode(fields.get(2)),
            decode(fields.get(3)), decode(fields.get(4))));
      } else if (fields.get(0).equals("M") && fields.size() == 4) {
        messages.add(new MessageInput(Integer.parseInt(fields.get(1)), decode(fields.get(2)),
            decode(fields.get(3))));
      } else {
        throw new IllegalArgumentException("Invalid bridge request row");
      }
    }

    Map<String, Map<String, Style>> stylesBySurface = new HashMap<>();
    for (ThemeInput theme : themes) {
      StyleParse parsed = parseThemeStyle(theme.input());
      if (parsed.style() == null) {
        System.out.println("T\t" + theme.index() + "\tinvalid\t\t" + parsed.start()
            + "\t" + parsed.end() + "\t" + encode(parsed.error() == null ? "无法读取主题定义" : parsed.error()));
      } else {
        stylesBySurface.computeIfAbsent(theme.surface(), ignored -> new HashMap<>())
            .put(theme.name().toLowerCase(Locale.ROOT), parsed.style());
        String style = jsonStyle(parsed.style());
        System.out.println("T\t" + theme.index() + "\tok\t" + encode(style)
            + "\t" + parsed.start() + "\t" + parsed.end() + "\t");
      }
    }

    for (MessageInput message : messages) {
      Map<String, Style> theme = stylesBySurface.getOrDefault(message.surface(), Map.of());
      MiniMessage runtimeParser = MiniMessage.builder()
          .tags(messageResolver(theme))
          .build();
      try {
        Component component = runtimeParser.deserialize(message.input());
        String plain = PlainTextComponentSerializer.plainText().serialize(component);
        System.out.println("M\t" + message.index() + "\tok\t" + encode(plain) + "\t-1\t-1\t");
      } catch (ParsingException exception) {
        System.out.println("M\t" + message.index() + "\tinvalid\t\t" + exception.startIndex()
            + "\t" + exception.endIndex() + "\t"
            + encode(exception.detailMessage() == null ? exception.getClass().getSimpleName() : exception.detailMessage()));
      } catch (RuntimeException exception) {
        System.out.println("M\t" + message.index() + "\tfailed\t\t-1\t-1\t"
            + encode(exception.getMessage() == null ? exception.getClass().getSimpleName() : exception.getMessage()));
      }

      int[] identity = new int[message.input().length()];
      for (int index = 0; index < identity.length; index++) identity[index] = index;
      SourceMap sourceMap = new SourceMap(message.input(), message.input(), identity, true,
          new Position(0, 0));
      int[] nextDocumentIndex = {1};
      List<String> structureOutput = new ArrayList<>();
      // Structure collection must use the runtime resolver: a fallback Tag would hide official resolver failures.
      TagResolver structuralResolver = messageResolver(theme);
      outputDocument(structuralResolver, theme, message.index(), 0, -1, message.input(), sourceMap,
          List.of(), nextDocumentIndex, structureOutput);
      for (String row : structureOutput) System.out.println(row);
    }
  }
}
