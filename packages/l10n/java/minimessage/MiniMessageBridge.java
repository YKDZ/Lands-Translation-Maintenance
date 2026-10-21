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

  private record MessageInput(
      int index,
      String surface,
      String originalInput,
      String input,
      int[] sourceOffsets,
      boolean exact) {}

  private record StyleParse(Style style, String error, int start, int end) {}

  private record Position(int start, int end) {}

  private record Frame(String kind, String name, Position position) {}

  private record Parameter(String value, Position position, int[] sourceOffsets) {}

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
    private final int[] sourceOffsets;
    private final boolean exact;
    private final Position emptyRange;

    SourceMap(
        String rootSource,
        String input,
        int[] sourceOffsets,
        boolean exact,
        Position emptyRange) {
      this.rootSource = rootSource;
      this.input = input;
      this.sourceOffsets = sourceOffsets;
      this.exact = exact;
      this.emptyRange = emptyRange;
    }

    Position range(int start, int end) {
      if (start < 0 || end < start || end >= this.sourceOffsets.length) {
        return new Position(-1, -1);
      }
      if (start == end) {
        int sourcePosition = this.sourceOffsets[start];
        return sourcePosition < 0
            ? this.emptyRange
            : new Position(sourcePosition, sourcePosition);
      }
      int sourceStart = Integer.MAX_VALUE;
      int sourceEnd = -1;
      for (int index = start; index <= end; index++) {
        int sourcePosition = this.sourceOffsets[index];
        if (sourcePosition < 0) return new Position(-1, -1);
        sourceStart = Math.min(sourceStart, sourcePosition);
        sourceEnd = Math.max(sourceEnd, sourcePosition);
      }
      return new Position(sourceStart, sourceEnd);
    }

    String raw(int start, int end) {
      Position position = this.range(start, end);
      if (position.start() >= 0) return this.rootSource.substring(position.start(), position.end());
      return this.input.substring(start, end);
    }

    SourceMap nested(String nestedInput, int[] nestedOffsets, boolean nestedExact, Position emptyRange) {
      return new SourceMap(
          this.rootSource,
          nestedInput,
          nestedOffsets,
          this.exact && nestedExact,
          emptyRange);
    }
  }

  private record MappedValue(String value, int[] sourceOffsets) {}

  private static String encode(String value) {
    return ENCODER.encodeToString(value.getBytes(StandardCharsets.UTF_8));
  }

  private static String decode(String value) {
    return new String(DECODER.decode(value), StandardCharsets.UTF_8);
  }

  private static int[] identityOffsets(String input) {
    int[] offsets = new int[input.length() + 1];
    for (int index = 0; index < offsets.length; index++) offsets[index] = index;
    return offsets;
  }

  private static int[] parseOffsets(String value, int expectedLength) {
    String[] parts = value.split(",", -1);
    if (parts.length != expectedLength) throw new IllegalArgumentException("Invalid source offset count");
    int[] offsets = new int[parts.length];
    for (int index = 0; index < parts.length; index++) offsets[index] = Integer.parseInt(parts[index]);
    return offsets;
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
    if (start == end) return new MappedValue("", new int[] {sourceMap.sourceOffsets[start]});
    char first = input.charAt(start);
    if (first != '\'' && first != '"') {
      String value = input.substring(start, end);
      int[] offsets = new int[value.length() + 1];
      System.arraycopy(sourceMap.sourceOffsets, start, offsets, 0, offsets.length);
      return new MappedValue(value, offsets);
    }

    int contentStart = start + 1;
    int contentEnd = end;
    char last = input.charAt(end - 1);
    if (last == '\'' || last == '"') contentEnd -= 1;
    if (contentStart > contentEnd) {
      String value = input.substring(start, end);
      int[] offsets = new int[value.length() + 1];
      System.arraycopy(sourceMap.sourceOffsets, start, offsets, 0, offsets.length);
      return new MappedValue(value, offsets);
    }

    StringBuilder value = new StringBuilder(contentEnd - contentStart);
    List<Integer> offsets = new ArrayList<>();
    offsets.add(sourceMap.sourceOffsets[contentStart]);
    int cursor = contentStart;
    while (cursor < contentEnd) {
      int sourceStart = cursor;
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
      int outputUnits = Character.charCount(codePoint);
      int sourceUnits = next - sourceStart;
      if (outputUnits == sourceUnits) {
        for (int part = 1; part <= outputUnits; part++) {
          offsets.add(sourceMap.sourceOffsets[sourceStart + part]);
        }
      } else {
        for (int part = 1; part < outputUnits; part++) offsets.add(-1);
        offsets.add(sourceMap.sourceOffsets[next]);
      }
      cursor = next;
    }
    return new MappedValue(value.toString(), offsets.stream().mapToInt(Integer::intValue).toArray());
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
      MappedValue decoded = decodePart(input, partToken, sourceMap);
      String value = index < officialParts.size()
          ? officialParts.get(index).value()
          : decoded.value();
      Position position = sourceMap.range(partToken.startIndex(), partToken.endIndex());
      int[] sourceOffsets = decoded.value().equals(value)
          ? decoded.sourceOffsets()
          : unavailableSourceOffsets(value, position);
      result.add(new Parameter(value, position, sourceOffsets));
    }
    return result;
  }

  private static int[] unavailableSourceOffsets(String value, Position position) {
    int[] offsets = new int[value.length() + 1];
    java.util.Arrays.fill(offsets, -1);
    offsets[0] = position.start();
    if (offsets.length > 1) offsets[offsets.length - 1] = position.end();
    return offsets;
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

  private static List<Integer> nestedContentIndexes(TagNode tag) {
    List<TagPart> parts = tag.parts();
    if (parts.isEmpty()) return List.of();
    String name = parts.get(0).value().toLowerCase(Locale.ROOT);
    if (name.equals("hover") && parts.size() >= 2) {
      String action = parts.get(1).value().toLowerCase(Locale.ROOT);
      if (action.equals("show_text") && parts.size() >= 3) return List.of(2);
      if (action.equals("show_entity") && parts.size() >= 5) return List.of(4);
      return List.of();
    }
    if (name.equals("translate") || name.equals("tr") || name.equals("lang")) {
      List<Integer> indexes = new ArrayList<>();
      for (int index = 2; index < parts.size(); index++) indexes.add(index);
      return indexes;
    }
    if (name.equals("translate_or") || name.equals("tr_or") || name.equals("lang_or")) {
      List<Integer> indexes = new ArrayList<>();
      // The official resolver consumes the key and fallback with value(), then
      // deserializes only the remaining component arguments.
      for (int index = 3; index < parts.size(); index++) indexes.add(index);
      return indexes;
    }
    if (name.equals("nbt") || name.equals("data")) {
      // NbtTag consumes at most parts[4] as the optional separator. A later
      // part is only the optional "interpret" flag; excess arguments are ignored.
      if (parts.size() > 4 && !parts.get(4).value().equalsIgnoreCase("interpret")) {
        return List.of(4);
      }
    }
    return List.of();
  }

  private static String canonicalNestedTagName(String tagName) {
    return switch (tagName.toLowerCase(Locale.ROOT)) {
      case "tr", "lang" -> "translate";
      case "tr_or", "lang_or" -> "translate_or";
      case "data" -> "nbt";
      default -> tagName.toLowerCase(Locale.ROOT);
    };
  }

  private static List<String> nestedOwnerParameters(TagNode tag, int argumentIndex) {
    List<TagPart> parts = tag.parts();
    if (parts.size() < 2) return List.of();
    String canonicalName = canonicalNestedTagName(parts.get(0).value());
    if (canonicalName.equals("translate") || canonicalName.equals("translate_or")) {
      return List.of(parts.get(1).value());
    }
    if (canonicalName.equals("nbt") && argumentIndex == 4 && parts.size() >= 4) {
      return List.of(
          parts.get(1).lowerValue(),
          parts.get(2).value(),
          parts.get(3).value());
    }
    return List.of();
  }

  private static String nestedOwnerKey(TagNode tag, int argumentIndex) {
    StringBuilder ownerKey = new StringBuilder();
    for (String parameter : nestedOwnerParameters(tag, argumentIndex)) {
      ownerKey.append(parameter.length()).append(':').append(parameter);
    }
    return encode(ownerKey.toString());
  }

  private static Frame nestedContentFrame(
      TagNode tag,
      int argumentIndex,
      Position argumentPosition,
      Position tagPosition) {
    String canonicalName = canonicalNestedTagName(tag.name());
    if (canonicalName.equals("hover")) {
      String action = "unknown";
      if (argumentIndex == 2) action = "show_text";
      else if (argumentIndex == 4) action = "show_entity";
      return new Frame("hover-text", "hover:" + action, tagPosition);
    }
    int argumentNumber = argumentIndex - 2;
    if (canonicalName.equals("translate_or")) argumentNumber = argumentIndex - 3;
    if (canonicalName.equals("nbt") && argumentIndex >= 4) argumentNumber = 0;
    return new Frame(
        "tag-argument",
        canonicalName + ":" + argumentNumber + ":" + nestedOwnerKey(tag, argumentIndex),
        argumentPosition);
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

      if (!closing && treeTag != null) {
        List<Integer> contentIndexes = nestedContentIndexes(treeTag);
        for (int contentIndex : contentIndexes) {
          TagPart content = treeTag.parts().get(contentIndex);
          MappedValue decoded = decodePart(input, content.token(), sourceMap);
          String nestedInput = content.value();
          boolean exact = decoded.value().equals(nestedInput);
          int[] nestedOffsets = new int[nestedInput.length() + 1];
          if (exact && decoded.sourceOffsets().length == nestedOffsets.length) {
            System.arraycopy(decoded.sourceOffsets(), 0, nestedOffsets, 0, nestedOffsets.length);
          } else {
            java.util.Arrays.fill(nestedOffsets, -1);
            nestedOffsets[0] = sourceMap.range(content.token().startIndex(), content.token().endIndex()).start();
            nestedOffsets[nestedOffsets.length - 1] = sourceMap.range(
                content.token().startIndex(), content.token().endIndex()).end();
            output.add("W\t" + messageIndex + "\t" + encode(
                "MiniMessage 标签参数经过预处理后无法可靠映射回原文位置；相关嵌套诊断位置不可用"));
          }
          Position emptyRange = sourceMap.range(content.token().startIndex(), content.token().endIndex());
          SourceMap nestedMap = sourceMap.nested(nestedInput, nestedOffsets, exact, emptyRange);
          List<Frame> nestedContext = new ArrayList<>(currentContext);
          nestedContext.add(nestedContentFrame(
              treeTag,
              contentIndex,
              emptyRange,
              sourceMap.range(treeTag.token().startIndex(), treeTag.token().endIndex())));
          int nestedDocumentIndex = nextDocumentIndex[0]++;
          outputDocument(resolver, theme, messageIndex,
              nestedDocumentIndex, documentIndex, nestedInput, nestedMap, nestedContext,
              nextDocumentIndex, output);
        }
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
          .append('\t').append(parameter.position().end())
          .append('\t').append(offsetFields(parameter.sourceOffsets()));
    }
    line.append('\t').append(frameFields(node.context()));
    return line.toString();
  }

  private static String offsetFields(int[] offsets) {
    StringBuilder result = new StringBuilder();
    for (int index = 0; index < offsets.length; index++) {
      if (index > 0) result.append(',');
      result.append(offsets[index]);
    }
    return result.toString();
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
      } else if (fields.get(0).equals("M") && (fields.size() == 4 || fields.size() == 7)) {
        String surface = decode(fields.get(2));
        if (fields.size() == 4) {
          String input = decode(fields.get(3));
          messages.add(new MessageInput(Integer.parseInt(fields.get(1)), surface,
              input, input, identityOffsets(input), true));
        } else {
          String originalInput = decode(fields.get(3));
          String input = decode(fields.get(4));
          int[] sourceOffsets = parseOffsets(fields.get(5), input.length() + 1);
          for (int offset : sourceOffsets) {
            if (offset < -1 || offset > originalInput.length()) {
              throw new IllegalArgumentException("Source offset is outside the original input");
            }
          }
          if (!fields.get(6).equals("true") && !fields.get(6).equals("false")) {
            throw new IllegalArgumentException("Invalid exact source map flag");
          }
          messages.add(new MessageInput(Integer.parseInt(fields.get(1)), surface,
              originalInput, input, sourceOffsets, fields.get(6).equals("true")));
        }
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
        String plain;
        try {
          plain = PlainTextComponentSerializer.plainText().serialize(component);
        } catch (RuntimeException ignored) {
          // Some valid content components (such as NBT) cannot be rendered without a game runtime.
          plain = "";
        }
        System.out.println("M\t" + message.index() + "\tok\t" + encode(plain) + "\t-1\t-1\t");
      } catch (ParsingException exception) {
        System.out.println("M\t" + message.index() + "\tinvalid\t\t" + exception.startIndex()
            + "\t" + exception.endIndex() + "\t"
            + encode(exception.detailMessage() == null ? exception.getClass().getSimpleName() : exception.detailMessage()));
      } catch (RuntimeException exception) {
        System.out.println("M\t" + message.index() + "\tfailed\t\t-1\t-1\t"
            + encode(exception.getMessage() == null ? exception.getClass().getSimpleName() : exception.getMessage()));
      }

      SourceMap sourceMap = new SourceMap(
          message.originalInput(),
          message.input(),
          message.sourceOffsets(),
          message.exact(),
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
