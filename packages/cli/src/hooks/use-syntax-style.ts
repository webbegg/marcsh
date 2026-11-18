import { useEffect, useMemo } from "react";
import { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useTheme } from "../providers/theme";
import { deriveSyntaxStyles } from "../lib/theme-derived";

/**
 * The `SyntaxStyle` for `<markdown>` and `<code>` in the current theme: built once per theme and destroyed when the
 * theme changes or the component unmounts. Its owner is the renderer's native scene: a style can only bind where it
 * was created, so it needs a live renderer.
 */
export function useSyntaxStyle(): SyntaxStyle {
  const renderer = useRenderer();
  const { colors } = useTheme();
  const style = useMemo(() => SyntaxStyle.fromStyles(deriveSyntaxStyles(colors), renderer.nativeScene), [renderer, colors]);
  useEffect(
    () => () => {
      // The renderer's own teardown can free the style first; destroying a freed style throws.
      try {
        style.destroy();
      } catch {}
    },
    [style],
  );
  return style;
}
