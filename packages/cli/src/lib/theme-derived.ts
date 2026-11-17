import type { ThemeColors } from "../theme";

/** A style as `SyntaxStyle.fromStyles` takes it: colours are `#RRGGBB` strings. */
export type DerivedStyle = {
  fg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
};

export type DiffColors = {
  /** Background of an added line. */
  addedBg: string;
  /** Background of a removed line. */
  removedBg: string;
  /** The `+` sign. */
  addedSign: string;
  /** The `-` sign. */
  removedSign: string;
  lineNumber: string;
  /** Background of an unchanged line. */
  contextBg: string;
};

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

function parse(color: string): [number, number, number] {
  const match = HEX.exec(color);
  if (!match) throw new Error(`Not a #RRGGBB colour: ${color}`);
  return [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)];
}

/** `share` of `fg` over `bg` (0 is all `bg`, 1 is all `fg`), as `#RRGGBB`. */
export function blend(fg: string, bg: string, share: number): string {
  const t = Math.min(1, Math.max(0, share));
  const front = parse(fg);
  const back = parse(bg);
  const channel = (i: number) =>
    Math.round(front[i]! * t + back[i]! * (1 - t))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`.toUpperCase();
}

/** The colours of a diff, from the theme's own: tinted backgrounds for added and removed lines. */
export function deriveDiffColors(colors: ThemeColors): DiffColors {
  return {
    addedBg: blend(colors.success, colors.background, 0.2),
    removedBg: blend(colors.error, colors.background, 0.2),
    addedSign: colors.success,
    removedSign: colors.error,
    lineNumber: colors.dimSeparator,
    contextBg: colors.background,
  };
}

/**
 * The styles for code and markdown, by the scope names OpenTUI's tree-sitter queries emit (`assets/*\/highlights.scm`).
 * A dotted name that is not registered falls back to its first segment only (`keyword.import` to `keyword`), so the
 * code scopes are registered by that root. The markup scopes are registered in full because `markup` itself must stay
 * unregistered: OpenTUI draws strikethrough through its absence. No `default` is set: text keeps the terminal's colour.
 */
export function deriveSyntaxStyles(colors: ThemeColors): Record<string, DerivedStyle> {
  const link: DerivedStyle = { fg: colors.info, underline: true };
  return {
    // Code
    keyword: { fg: colors.primary },
    string: { fg: colors.success },
    comment: { fg: colors.thinking, italic: true },
    function: { fg: colors.info },
    constructor: { fg: colors.info },
    type: { fg: colors.info },
    number: { fg: colors.planMode },
    constant: { fg: colors.planMode },
    boolean: { fg: colors.planMode },
    punctuation: { fg: colors.dimSeparator },
    operator: { fg: colors.dimSeparator },
    // Markdown
    "markup.heading": { fg: colors.primary, bold: true },
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.raw": { fg: colors.info },
    "markup.raw.block": { fg: colors.info },
    "markup.link": { ...link },
    "markup.link.label": { ...link },
    "markup.link.url": { ...link },
    "markup.list": { fg: colors.dimSeparator },
    "markup.quote": { fg: colors.thinking, italic: true },
    conceal: { fg: colors.dimSeparator },
  };
}
