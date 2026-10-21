package org.landsl10n.minimessage;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.Style;
import net.kyori.adventure.text.format.TextDecoration;
import net.kyori.adventure.text.minimessage.MiniMessage;
import net.kyori.adventure.text.minimessage.ParsingException;
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
      return new StyleParse(component.style(), null, -1, -1);
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

  private record StyleParse(Style style, String error, int start, int end) {}

  private static List<String> readInput() throws Exception {
    return new java.io.BufferedReader(new java.io.InputStreamReader(System.in, StandardCharsets.UTF_8))
        .lines().toList();
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
        stylesBySurface.computeIfAbsent(theme.surface(), ignored -> new LinkedHashMap<>())
            .put(theme.name().toLowerCase(Locale.ROOT), parsed.style());
        String style = jsonStyle(parsed.style());
        System.out.println("T\t" + theme.index() + "\tok\t" + encode(style)
            + "\t" + parsed.start() + "\t" + parsed.end() + "\t");
      }
    }

    for (MessageInput message : messages) {
      StringBuilder debug = new StringBuilder();
      MiniMessage parser = MiniMessage.builder()
          .tags(TagResolver.resolver(
              StandardTags.defaults(),
              themeResolver(stylesBySurface.getOrDefault(message.surface(), Map.of())),
              variableResolver()))
          .debug(debug::append)
          .build();
      try {
        Component component = parser.deserialize(message.input());
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

      Matcher unresolved = UNRESOLVED_TAG.matcher(debug);
      while (unresolved.find()) {
        String name = unresolved.group(3);
        String detail = unresolved.group(4) == null ? "" : unresolved.group(4);
        System.out.println("U\t" + message.index() + "\t" + encode(name) + "\t"
            + parseIndex(unresolved.group(2)) + "\t" + encode(detail));
      }
    }
  }
}
