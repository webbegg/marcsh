import { describe, expect, test } from "bun:test";
import { THEMES } from "../theme";
import { blend, deriveDiffColors, deriveSyntaxStyles } from "./theme-derived";

const HEX = /^#[0-9A-F]{6}$/i;

describe("blend", () => {
  test("mixes the first colour over the second by the given share", () => {
    expect(blend("#FFFFFF", "#000000", 0.5)).toBe("#808080");
    expect(blend("#FF0000", "#000000", 0.2)).toBe("#330000");
    expect(blend("#102030", "#FFFFFF", 0)).toBe("#FFFFFF");
    expect(blend("#102030", "#FFFFFF", 1)).toBe("#102030");
  });

  test("clamps the share to 0..1 and accepts lower case", () => {
    expect(blend("#ffffff", "#000000", 2)).toBe("#FFFFFF");
    expect(blend("#ffffff", "#000000", -1)).toBe("#000000");
  });

  test("rejects a colour that is not #RRGGBB", () => {
    expect(() => blend("red", "#000000", 0.2)).toThrow();
    expect(() => blend("#FFF", "#000000", 0.2)).toThrow();
  });
});

describe("the diff colours", () => {
  test("a colour that is not #RRGGBB leaves its background plain instead of throwing", () => {
    const colors = { ...THEMES[0]!.colors, success: "green" };
    const diff = deriveDiffColors(colors);
    expect(diff.addedBg).toBe(colors.background);
    expect(diff.addedSign).toBe("green");
    expect(diff.removedBg).not.toBe(colors.background);
  });

  test("come from the success, error, background and separator colours", () => {
    const { colors } = THEMES[0]!;
    const diff = deriveDiffColors(colors);
    expect(diff.addedBg).toBe(blend(colors.success, colors.background, 0.2));
    expect(diff.removedBg).toBe(blend(colors.error, colors.background, 0.2));
    expect(diff.addedSign).toBe(colors.success);
    expect(diff.removedSign).toBe(colors.error);
    expect(diff.lineNumber).toBe(colors.dimSeparator);
    expect(diff.contextBg).toBe(colors.background);
  });

  test.each(THEMES.map((t) => [t.name, t] as const))("%s yields valid colours", (_name, theme) => {
    for (const value of Object.values(deriveDiffColors(theme.colors))) expect(value).toMatch(HEX);
  });

  test("the added and removed backgrounds differ from each other and from the background", () => {
    for (const { colors } of THEMES) {
      const diff = deriveDiffColors(colors);
      expect(diff.addedBg).not.toBe(diff.removedBg);
      expect(diff.addedBg).not.toBe(colors.background);
      expect(diff.removedBg).not.toBe(colors.background);
    }
  });
});

describe("the syntax styles", () => {
  test("map the code scopes to the theme's colours", () => {
    const { colors } = THEMES[0]!;
    const styles = deriveSyntaxStyles(colors);
    expect(styles.keyword).toEqual({ fg: colors.primary });
    expect(styles.string).toEqual({ fg: colors.success });
    expect(styles.comment).toEqual({ fg: colors.thinking, italic: true });
    expect(styles.function).toEqual({ fg: colors.info });
    expect(styles.type).toEqual({ fg: colors.info });
    expect(styles.number).toEqual({ fg: colors.planMode });
    expect(styles.constant).toEqual({ fg: colors.planMode });
    expect(styles.punctuation).toEqual({ fg: colors.dimSeparator });
  });

  test("map the markdown scopes the tree-sitter queries use", () => {
    const { colors } = THEMES[0]!;
    const styles = deriveSyntaxStyles(colors);
    expect(styles["markup.heading"]).toEqual({ fg: colors.primary, bold: true });
    expect(styles["markup.strong"]).toEqual({ bold: true });
    expect(styles["markup.italic"]).toEqual({ italic: true });
    expect(styles["markup.raw"]).toEqual({ fg: colors.info });
    expect(styles["markup.raw.block"]).toEqual({ fg: colors.info });
    expect(styles["markup.link"]).toEqual({ fg: colors.info, underline: true });
    expect(styles["markup.link.label"]).toEqual({ fg: colors.info, underline: true });
    expect(styles["markup.link.url"]).toEqual({ fg: colors.info, underline: true });
    expect(styles["markup.list"]).toEqual({ fg: colors.dimSeparator });
    expect(styles["markup.quote"]).toEqual({ fg: colors.thinking, italic: true });
    expect(styles.conceal).toEqual({ fg: colors.dimSeparator });
  });

  test("never register a bare `markup`, which would switch off OpenTUI's strikethrough fallback", () => {
    expect(Object.keys(deriveSyntaxStyles(THEMES[0]!.colors))).not.toContain("markup");
  });

  test.each(THEMES.map((t) => [t.name, t] as const))("%s yields valid colours", (_name, theme) => {
    const styles = deriveSyntaxStyles(theme.colors);
    expect(Object.keys(styles).length).toBeGreaterThan(10);
    for (const style of Object.values(styles)) if (style.fg !== undefined) expect(style.fg).toMatch(HEX);
  });
});
